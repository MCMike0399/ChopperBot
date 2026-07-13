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
import { EventIntakeStore } from './store.js';
import { isEventForm, parseTicketForm, extractRequesterId, type ParsedForm } from './parse.js';
import { isModByRole } from './roles.js';
import { renderProposalPrompt, renderTicketConversationPrompt } from './preamble.js';

/** The Message shape the MessageCreate gateway event actually delivers. */
type GatewayMessage = OmitPartialGroupDMChannel<Message>;

/** Read-only calendar tools every ticket participant gets (conflict checks). */
const READ_TOOLS = [
  'calendar_search_events',
  'calendar_list_upcoming',
  'calendar_get_event',
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

    await message.channel.sendTyping().catch(() => {});
    const system = renderProposalPrompt(new Date(this.now()), parsed, requesterId);
    // Read-only bundle: the proposal must never create anything.
    const tools = composeToolSources([this.calendarSource(message, { write: false })]);
    const proposal = await ask({
      system,
      messages: [{ role: 'user', content: 'Genera la propuesta para esta solicitud.' }],
      tools,
    });

    const posted = await this.post(message, proposal);
    this.deps.store.recordProposal({
      channelId: message.channelId,
      guildId: message.guildId,
      requesterId,
      parsedForm: parsed,
      resolvedStartAt: null,
      proposalMessageId: posted?.id ?? null,
    });
    log.info(
      { channelId: message.channelId, requesterId, title: parsed.title },
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

    const reaction = await message.react('🔍').catch(() => null);
    await message.channel.sendTyping().catch(() => {});
    const heartbeat = setInterval(() => void message.channel.sendTyping().catch(() => {}), 8000);

    let reply: string;
    try {
      const history = await buildHistory(this.deps.client, message);
      const turns: Turn[] = normalizeTurns([...history, { role: 'user', content: userText }]);
      const system = renderTicketConversationPrompt({
        now: new Date(this.now()),
        parsed,
        requesterId,
        isMod,
      });
      const tools = composeToolSources([this.calendarSource(message, { write: isMod })]);
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

    const parts = chunkBotReply(reply);
    let anchor = await message.reply(parts[0]).catch(() => null);
    for (let i = 1; anchor && i < parts.length; i++) {
      anchor = await anchor
        .reply({ content: parts[i], allowedMentions: { repliedUser: false } })
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
  private calendarSource(message: Message, opts: { write: boolean }): ToolSource {
    const include = opts.write ? [...READ_TOOLS, 'calendar_create_event'] : [...READ_TOOLS];
    const inner = new CalendarToolSource(
      this.deps.calendarStore,
      message.author?.id ?? 'event_intake',
      this.now(),
      opts.write ? this.deps.publisher : undefined,
      { include, allowWrite: opts.write },
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
            log.info({ channelId, eventId }, 'event_intake.event_created');
          }
        }
        return res;
      },
    };
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
  private async post(message: GatewayMessage, content: string): Promise<Message | null> {
    const parts = chunkBotReply(content);
    // `reply` and `send` return slightly different Message shapes — widen so both assign.
    let anchor: Message | null = await message.reply(parts[0]).catch(() => null);
    if (!anchor && message.channel.isSendable()) {
      anchor = await message.channel.send(parts[0]).catch(() => null);
    }
    let cursor: Message | null = anchor;
    for (let i = 1; cursor && i < parts.length; i++) {
      cursor = await cursor
        .reply({ content: parts[i], allowedMentions: { repliedUser: false } })
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
