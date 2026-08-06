import {
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import { log } from '../../log.js';
import { ask } from '../../llm/client.js';
import { buildHistory, normalizeTurns, type Turn } from '../../discord/history.js';
import { chunkBotReply } from '../../discord/chunk.js';
import { stripBotMention } from '../../discord/handlers.js';
import { composeToolSources, type ToolSource } from '../../tools/source.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarToolSource } from '../calendar/source.js';
import type { CalendarPublisher } from '../calendar/publisher.js';
import { createEventSyncer, type DiscordEventSyncer } from '../calendar/discord-events.js';
import { formatInTimezone } from '../calendar/time.js';
import { listImageAttachments } from '../../attachments/resolver.js';
import { EventIntakeStore } from './store.js';
import { isEventForm, parseTicketForm, extractRequesterId, type ParsedForm } from './parse.js';
import {
  appendModPing,
  EMPTY_MOD_MENTIONS,
  isModByRole,
  mentionedRoleIds,
  resolveModMentions,
  sanitizeRoleMentions,
  shouldNotifyRoles,
  type ModMentions,
} from '../../discord/mod-roles.js';
import { renderProposalPrompt, renderTicketConversationPrompt } from './preamble.js';

/** The Message shape the MessageCreate gateway event actually delivers. */
type GatewayMessage = OmitPartialGroupDMChannel<Message>;

/**
 * What we let through `allowedMentions`: every user mention the model wrote
 * (the requester) plus, explicitly, the approver roles we resolved. Never
 * @everyone/@here — omitting them from `parse` is what blocks them.
 */
function mentionPolicy(roleIds: readonly string[], repliedUser: boolean) {
  return { parse: ['users' as const], roles: [...roleIds], repliedUser };
}

/** Read-only calendar tools every ticket participant gets (conflict checks). */
const READ_TOOLS = [
  'calendar_search_events',
  'calendar_list_upcoming',
  'calendar_get_event',
] as const;

/**
 * What a MOD additionally gets in a ticket. `calendar_update_event` is here
 * because of a real dead end (ticket-0005, 2026-08-04): a mod approved an event
 * whose title had a typo, asked the bot to fix it, and the bot had to answer
 * "no tengo herramienta para editar" and hand the job back to a human — for a
 * one-word change it had every right to make. Correcting what you just approved,
 * in the ticket where you approved it, is part of approving.
 *
 * `calendar_delete_event` is deliberately still absent: fixing your own event is
 * ticket work, wiping events off the shared calendar is not.
 */
const MOD_TOOLS = [
  'calendar_create_event',
  'calendar_update_event',
  'calendar_sync_discord_event',
] as const;

export interface EventIntakeWatcherDeps {
  store: EventIntakeStore;
  calendarStore: CalendarStore;
  client: Client;
  botUserId: string;
  ticketBotId: string;
  getModRoles: () => string[];
  /** Present at runtime so an approved create auto-publishes the PDF/ICS. */
  publisher?: CalendarPublisher;
  now?: () => number;
}

/**
 * The passive brain for the ticket funnel. Two disjoint jobs, both wrapped so a
 * failure never propagates into the Discord gateway:
 *   - the ticket bot's form message → ONE normalized, conflict-checked proposal.
 *   - a human @-mentioning / replying to the bot → the agent loop, with the
 *     calendar WRITE tool included only when that author is a moderator.
 */
export class EventIntakeWatcher {
  private readonly now: () => number;
  /** Last time we actually NOTIFIED the approver roles, per ticket channel. */
  private readonly lastModPingAt = new Map<string, number>();
  /** Guilds we already warned about unpingable approver roles (log once). */
  private readonly warnedUnpingable = new Set<string>();

  constructor(private readonly deps: EventIntakeWatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Entry point wired to Events.MessageCreate for watched ticket categories. */
  async handleMessage(message: GatewayMessage): Promise<void> {
    try {
      const authorId = message.author?.id ?? null;
      if (authorId === this.deps.botUserId) return; // never react to our own posts

      const msgLike = toMessageLike(message);

      if (isEventForm(msgLike, this.deps.ticketBotId)) {
        await this.handleForm(message);
        return;
      }

      // Anything else only matters if a human is talking TO the bot.
      if (message.author?.bot) return;
      if (!this.addressesBot(message)) return;
      await this.handleConversation(message);
    } catch (err) {
      log.error({ err, channelId: message.channelId }, 'event_intake.watcher.error');
    }
  }

  // ── Form → proposal ─────────────────────────────────────────────────────

  private async handleForm(message: GatewayMessage): Promise<void> {
    // Dedup: one proposal per ticket, survives restarts.
    if (this.deps.store.getTicket(message.channelId)) {
      log.info({ channelId: message.channelId }, 'event_intake.form.already_proposed');
      return;
    }
    if (!this.canPost(message)) {
      log.warn({ channelId: message.channelId, guildId: message.guildId }, 'event_intake.cannot_send');
      return;
    }

    const parsed = parseTicketForm(toMessageLike(message));
    if (!parsed) return;
    const requesterId = extractRequesterId(message.content ?? '', [
      this.deps.ticketBotId,
      this.deps.botUserId,
    ]);

    const mentions = await this.resolveMentions(message);

    await message.channel.sendTyping().catch(() => {});
    const system = renderProposalPrompt(new Date(this.now()), parsed, requesterId);
    // Read-only bundle: the proposal must never create anything.
    const tools = composeToolSources([this.calendarSource(message, { write: false })]);
    const proposal = await ask({
      system,
      messages: [{ role: 'user', content: 'Genera la propuesta para esta solicitud.' }],
      tools,
    });

    // The proposal is THE message mods must not miss, so the ping is appended
    // deterministically rather than left to the model.
    const body = appendModPing(sanitizeRoleMentions(proposal, mentions.notifyIds), mentions);
    const posted = await this.post(message, body, mentions.notifyIds);
    if (posted && mentions.notifyIds.length > 0) {
      this.lastModPingAt.set(message.channelId, this.now());
    }
    this.deps.store.recordProposal({
      channelId: message.channelId,
      guildId: message.guildId,
      requesterId,
      parsedForm: parsed,
      resolvedStartAt: null,
      proposalMessageId: posted?.id ?? null,
    });
    log.info(
      {
        channelId: message.channelId,
        requesterId,
        title: parsed.title,
        modRolesPinged: mentions.notifyIds.length,
        modRolesSilent: mentions.silent.length,
      },
      'event_intake.proposal.posted',
    );
  }

  // ── Human conversation (mod-gated create) ─────────────────────────────────

  private async handleConversation(message: GatewayMessage): Promise<void> {
    if (!this.canPost(message)) {
      log.warn({ channelId: message.channelId }, 'event_intake.cannot_send');
      return;
    }
    const userText = stripBotMention(this.deps.client, message.content ?? '').trim();
    if (!userText) return;

    // GUARDRAIL: only ever talk in a ticket we recognized as an EVENT request.
    // In any other ticket type (report/support/etc.) in this category we stay
    // completely silent, even if @-mentioned.
    const ctx = await this.resolveEventContext(message);
    if (!ctx) {
      log.info({ channelId: message.channelId }, 'event_intake.conversation.not_event_ticket');
      return;
    }
    const { parsed, requesterId } = ctx;

    const isMod = await this.isModerator(message);
    const mentions = await this.resolveMentions(message);
    // The newest image posted in the ticket is almost always the event flyer
    // (requesters attach it right after opening — the Calibán ticket pattern).
    // Only mod turns can do anything with it (the sync tool is mod-only), so
    // non-mod turns skip the fetch.
    const flyer = isMod ? await this.findLatestTicketImage(message) : null;

    const reaction = await message.react('🔍').catch(() => null);
    await message.channel.sendTyping().catch(() => {});
    const heartbeat = setInterval(() => void message.channel.sendTyping().catch(() => {}), 8000);

    let reply: string;
    /** Set by the tool tap below when THIS turn actually created the event. */
    let createdEventId: number | null = null;
    try {
      const history = await buildHistory(this.deps.client, message);
      const turns: Turn[] = normalizeTurns([...history, { role: 'user', content: userText }]);
      const system = renderTicketConversationPrompt({
        now: new Date(this.now()),
        parsed,
        requesterId,
        isMod,
        modMention: mentions.notifies ? mentions.text : '',
        flyer,
      });
      const tools = composeToolSources([
        this.calendarSource(message, {
          write: isMod,
          onCreated: (id) => {
            createdEventId = id;
          },
          imageUrls: flyer ? [flyer.url] : [],
        }),
      ]);
      log.info(
        { channelId: message.channelId, user: message.author?.tag, isMod },
        'event_intake.conversation',
      );
      reply = await ask({ system, messages: turns, tools });
    } finally {
      clearInterval(heartbeat);
      if (reaction && this.deps.client.user) {
        await reaction.users.remove(this.deps.client.user.id).catch(() => {});
      }
    }

    // The model decides WHETHER to call the mods; we decide whether that call
    // actually rings. A ping is suppressed (chip still renders, silently) when
    // we already notified this ticket inside the cooldown, so a mention echoed
    // out of conversation history can't turn into repeat pages for the mods.
    //
    // The approval itself is the exception: when THIS turn created the event,
    // the team is told deterministically and the cooldown does not apply — it's
    // the outcome everyone in the ticket was waiting for, and it happens at most
    // once per ticket.
    let body = sanitizeRoleMentions(reply, mentions.notifyIds);
    if (createdEventId !== null) {
      // Close the loop while we're still in the ticket: calendar row → Discord
      // scheduled event → the link the daily announcement will carry.
      body += await this.syncDiscordEventFor(message, createdEventId);
      body = appendModPing(body, mentions, 'created');
    }
    const wanted = mentionedRoleIds(body, mentions.notifyIds);
    const notify =
      wanted.length > 0 &&
      (createdEventId !== null ||
        shouldNotifyRoles(this.lastModPingAt.get(message.channelId), this.now()));
    if (wanted.length > 0) {
      log.info(
        {
          channelId: message.channelId,
          roles: wanted.length,
          notified: notify,
          reason: createdEventId !== null ? 'created' : 'requested',
        },
        'event_intake.mod_ping',
      );
    }
    if (notify) this.lastModPingAt.set(message.channelId, this.now());

    const parts = chunkBotReply(body);
    const roleIds = notify ? wanted : [];
    let anchor = await message.reply({
      content: parts[0],
      allowedMentions: mentionPolicy(roleIds, true),
    }).catch(() => null);
    for (let i = 1; anchor && i < parts.length; i++) {
      anchor = await anchor
        .reply({ content: parts[i], allowedMentions: mentionPolicy(roleIds, false) })
        .catch(() => null);
    }
  }

  /**
   * The event context for a ticket, or null if this ticket isn't a recognized
   * event request (→ stay silent). Prefer the stored proposal row; if there's
   * none (bot added after the form, a missed MessageCreate, a restart) re-scan
   * recent history for the ticket-bot event form. A ticket that has neither is
   * some other ticket type and we don't touch it.
   */
  private async resolveEventContext(
    message: GatewayMessage,
  ): Promise<{ parsed: ParsedForm | null; requesterId: string | null } | null> {
    const row = this.deps.store.getTicket(message.channelId);
    if (row) {
      return { parsed: EventIntakeStore.parseForm(row), requesterId: row.requester_id ?? null };
    }
    return this.findEventFormInHistory(message);
  }

  /** Scan recent messages for the ticket-bot event form; null if none present. */
  private async findEventFormInHistory(
    message: GatewayMessage,
  ): Promise<{ parsed: ParsedForm; requesterId: string | null } | null> {
    try {
      const msgs = await message.channel.messages.fetch({ limit: 25 });
      for (const m of msgs.values()) {
        const ml = toMessageLike(m);
        if (isEventForm(ml, this.deps.ticketBotId)) {
          return {
            parsed: parseTicketForm(ml)!,
            requesterId: extractRequesterId(m.content ?? '', [
              this.deps.ticketBotId,
              this.deps.botUserId,
            ]),
          };
        }
      }
    } catch {
      // fetch failed (perms/deleted) — treat as unrecognized, stay silent.
    }
    return null;
  }

  // ── Tool bundle (gated) ───────────────────────────────────────────────────

  /**
   * A calendar tool source restricted for the ticket flow: read tools always,
   * plus `calendar_create_event` only when `write` (the author is a mod). A
   * successful create is tapped to mark the ticket resolved.
   */
  private calendarSource(
    message: Message,
    opts: { write: boolean; onCreated?: (eventId: number) => void; imageUrls?: readonly string[] },
  ): ToolSource {
    const include = opts.write ? [...READ_TOOLS, ...MOD_TOOLS] : [...READ_TOOLS];
    const inner = new CalendarToolSource(
      this.deps.calendarStore,
      message.author?.id ?? 'event_intake',
      this.now(),
      opts.write ? this.deps.publisher : undefined,
      {
        include,
        allowWrite: opts.write,
        syncer: opts.write ? this.makeSyncer(message) : undefined,
        allowedImageUrls: opts.imageUrls ?? [],
      },
    );
    const store = this.deps.store;
    const channelId = message.channelId;
    return {
      name: inner.name,
      systemPromptSection: () => inner.systemPromptSection(),
      tools: () => inner.tools(),
      async handle(name, input) {
        const res = await inner.handle(name, input);
        if (name === 'calendar_create_event' && res.status === 'success') {
          const eventId = (res.payload as { event?: { id?: number } })?.event?.id;
          if (typeof eventId === 'number') {
            store.markCreated(channelId, eventId);
            opts.onCreated?.(eventId);
            log.info({ channelId, eventId }, 'event_intake.event_created');
          }
        }
        return res;
      },
    };
  }

  /** Discord-scheduled-event access for this ticket's guild (null in a DM). */
  private makeSyncer(message: Message): DiscordEventSyncer | undefined {
    if (!message.guildId) return undefined;
    return createEventSyncer({
      client: this.deps.client,
      guildId: message.guildId,
      store: this.deps.calendarStore,
      now: this.now,
      formatLocal: formatInTimezone,
    });
  }

  /**
   * Create the Discord scheduled event for a just-approved request and return
   * the line to append to the confirmation.
   *
   * Done deterministically on approval rather than left to the model, for the
   * same reason the mod ping is: this is the moment the whole ticket existed
   * for, and "the event is in the calendar but nobody can RSVP to it" is exactly
   * the gap the daily announcement then has to apologise for. When the bot lacks
   * the permission, the line says so and asks the mods — which is strictly
   * better than silence.
   *
   * The newest image posted in the ticket (the flyer requesters attach right
   * after opening) becomes the event's cover image automatically — before this,
   * a mod had to open the Discord event and upload it by hand.
   */
  private async syncDiscordEventFor(message: GatewayMessage, eventId: number): Promise<string> {
    const syncer = this.makeSyncer(message);
    if (!syncer) return '';
    const flyer = await this.findLatestTicketImage(message);
    const result = await syncer.sync(eventId, { imageUrl: flyer?.url ?? null }).catch((err) => {
      log.warn({ err, eventId }, 'event_intake.discord_event.sync_threw');
      return null;
    });
    if (!result) return '';
    if (result.ok) {
      log.info(
        { eventId, discordEventId: result.discordEventId, created: result.created, imageSet: result.imageSet === true },
        'event_intake.discord_event.synced',
      );
      const withBanner = result.imageSet === true;
      return result.created
        ? `\n\n📅 Ya creé también el **evento de Discord**${withBanner ? ' (con la portada que compartieron)' : ''} para que la gente se apunte:\n${result.url}`
        : `\n\n📅 El evento de Discord ya existía${withBanner ? '; le puse la portada que compartieron' : ''}:\n${result.url}`;
    }
    log.warn({ eventId, reason: result.reason, message: result.message }, 'event_intake.discord_event.sync_failed');
    if (result.reason === 'missing_permission') {
      return (
        '\n\n⚠️ No pude crear el **evento de Discord** (me falta el permiso *Gestionar eventos* del servidor, ' +
        'un admin lo activa en Ajustes del servidor → Roles → ChopperBot). ¿Lo crean a mano en **Eventos → Crear evento**? ' +
        'Es lo que enlaza el anuncio del día para que la gente se apunte.'
      );
    }
    return '\n\n⚠️ No pude crear el evento de Discord; créenlo a mano en **Eventos → Crear evento** para que la gente se apunte.';
  }

  /**
   * The newest image attachment anywhere in this ticket's recent history —
   * almost always the event flyer (requesters attach it right after the
   * welcome, before any approval). Our own posts and the ticket bot's are
   * skipped. Null when there's none or the fetch fails (non-fatal everywhere).
   */
  private async findLatestTicketImage(
    message: GatewayMessage,
  ): Promise<{ url: string; name: string; authorId: string | null } | null> {
    try {
      const msgs = await message.channel.messages.fetch({ limit: 25 });
      const newestFirst = [...msgs.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const m of newestFirst) {
        if (m.author?.id === this.deps.botUserId || m.author?.id === this.deps.ticketBotId) continue;
        const images = listImageAttachments(m);
        if (images.length > 0) {
          return { url: images[0]!.url, name: images[0]!.name, authorId: m.author?.id ?? null };
        }
      }
    } catch (err) {
      log.warn({ err, channelId: message.channelId }, 'event_intake.flyer_scan_failed');
    }
    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** True when a human message @-mentions the bot or replies to one of its messages. */
  private addressesBot(message: GatewayMessage): boolean {
    if (!this.deps.client.user) return false;
    const botId = this.deps.client.user.id;
    const mentioned = message.mentions.users.has(botId);
    const isReplyToBot =
      message.reference?.messageId != null && message.mentions.repliedUser?.id === botId;
    return mentioned || isReplyToBot;
  }

  /**
   * Whether the message author may APPROVE (→ create): a member of an approver
   * role (Moderador / Administrador / Administradora by default, matched by name
   * or id) or anyone with Discord's Administrator permission. Fails CLOSED when
   * the member can't be resolved.
   */
  private async isModerator(message: GatewayMessage): Promise<boolean> {
    if (!message.inGuild()) return false;
    let member: GuildMember | null = message.member;
    if (!member) {
      member = await message.guild.members.fetch(message.author.id).catch(() => null);
    }
    if (!member) return false;
    const roles = member.roles.cache.map((r) => ({ id: r.id, name: r.name }));
    if (isModByRole(roles, this.deps.getModRoles())) return true;
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  /**
   * The approver roles as this guild/channel actually allows us to mention them.
   * Discord only NOTIFIES a role mention when the role is `mentionable` or we
   * hold MentionEveryone here, so pingability is resolved per channel (a
   * category override can grant it where the guild default doesn't).
   */
  private async resolveMentions(message: GatewayMessage): Promise<ModMentions> {
    if (!message.inGuild()) return EMPTY_MOD_MENTIONS;
    try {
      const guild = message.guild;
      let roles = guild.roles.cache;
      if (roles.size === 0) roles = await guild.roles.fetch();
      const me = guild.members.me;
      const canMentionAny =
        me !== null &&
        (message.channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) ?? false);
      const resolved = resolveModMentions(
        roles.map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
        this.deps.getModRoles(),
        { canMentionAny },
      );
      // An approver role we can't ping is invisible to the operator otherwise —
      // it just silently never notifies. Say it once per guild per process.
      if (resolved.silent.length > 0 && !this.warnedUnpingable.has(guild.id)) {
        this.warnedUnpingable.add(guild.id);
        log.warn(
          {
            guildId: guild.id,
            roles: resolved.silent.map((r) => r.name),
            hint: 'marca el rol como mencionable o dale al bot el permiso "Mencionar @everyone, @here y todos los roles"',
          },
          'event_intake.mentions.not_pingable',
        );
      }
      return resolved;
    } catch (err) {
      log.warn({ err, channelId: message.channelId }, 'event_intake.mentions.resolve_failed');
      return EMPTY_MOD_MENTIONS;
    }
  }

  /** Whether the bot can post here (thread/forum needs SendMessagesInThreads). */
  private canPost(message: GatewayMessage): boolean {
    if (!message.inGuild()) return true;
    const me = message.guild.members.me;
    if (!me) return true;
    const perms = message.channel.permissionsFor(me);
    if (!perms) return true;
    const needed = message.channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    return perms.has(needed);
  }

  /** Post text as a reply to the source message, falling back to a plain send. */
  private async post(
    message: GatewayMessage,
    content: string,
    roleIds: readonly string[] = [],
  ): Promise<Message | null> {
    const parts = chunkBotReply(content);
    // `reply` and `send` return slightly different Message shapes — widen so both assign.
    let anchor: Message | null = await message
      .reply({ content: parts[0], allowedMentions: mentionPolicy(roleIds, true) })
      .catch(() => null);
    if (!anchor && message.channel.isSendable()) {
      anchor = await message.channel
        .send({ content: parts[0], allowedMentions: mentionPolicy(roleIds, true) })
        .catch(() => null);
    }
    let cursor: Message | null = anchor;
    for (let i = 1; cursor && i < parts.length; i++) {
      cursor = await cursor
        .reply({ content: parts[i], allowedMentions: mentionPolicy(roleIds, false) })
        .catch(() => null);
    }
    return anchor;
  }
}

function toMessageLike(m: Message) {
  return {
    authorId: m.author?.id ?? null,
    authorBot: m.author?.bot ?? false,
    content: m.content ?? '',
    embeds: m.embeds.map((e) => ({
      description: e.description,
      fields: e.fields?.map((f) => ({ name: f.name, value: f.value })),
    })),
  };
}
