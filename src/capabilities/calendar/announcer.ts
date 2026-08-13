/**
 * The daily same-day announcement: every morning, tell the community which
 * events happen TODAY, in the community's own voice, with a link to the Discord
 * scheduled event they can RSVP to — and quietly nudge the mods when that
 * Discord event doesn't exist yet.
 *
 * Why this capability is worth its own module: the community's admins were doing
 * this by hand, and the two hard parts were never the posting. They were
 *
 *  1. **knowing which Discord event goes with which calendar row** (admins write
 *     the Discord event in different words — see {@link ./match.js}), and
 *  2. **not double-posting**, across ticks, restarts and a mod booking something
 *     the same afternoon.
 *
 * So the flow is a funnel with a durable ledger at the end of it:
 *
 *   occurrences today  →  link (stored → deterministic → model)  →  write
 *   (model, else template)  →  post  →  record in `calendar_announcements`
 *
 * Every LLM step degrades to a deterministic one: an unmatched event is still
 * announced (without a link), and a model outage costs the message its *style*,
 * never the heads-up itself.
 */
import type { Client } from 'discord.js';
import { log } from '../../log.js';
import { ask } from '../../llm/client.js';
import { composeToolSources } from '../../tools/source.js';
import { resolveModMentions, type ModMentions } from '../../discord/mod-roles.js';
import { sendAdminAlert } from '../../discord/admin-alert.js';
import type { CalendarStore } from './store.js';
import { localParts } from './grid.js';
import { formatInTimezone, formatLocalClock, WALL_CLOCK_OFFSET_MS } from './time.js';
import {
  candidatesFor,
  matchVerdict,
  parseMatchReply,
  type MatchableDiscordEvent,
  type MatchableOccurrence,
} from './match.js';
import {
  announceKey,
  announceNonce,
  announcementsDue,
  appendEventLink,
  nudgeKey,
  nudgesDue,
  prefixMentions,
  renderAnnouncementPrompt,
  renderAnnounceMentions,
  renderFallbackAnnouncement,
  renderMatchPrompt,
  type AnnounceTarget,
} from './announce.js';
import { fetchScheduledEvent, fetchScheduledEvents, type DiscordScheduledEvent } from './discord-events.js';

/** Both model calls here are pure text generation — no tools to offer. */
const NO_TOOLS = composeToolSources([]);

/** Mention classes Discord accepts in `allowedMentions.parse`. */
type MentionParseType = 'everyone' | 'roles' | 'users';

/** What we send: content plus an explicit, minimal mention policy. */
interface AnnouncePayload {
  content: string;
  allowedMentions: { parse: MentionParseType[]; roles: string[] };
  /**
   * The linked Discord event's cover image, attached so the announcement looks
   * like the admins' manual posts (they always paste the flyer). A CDN URL —
   * discord.js downloads and re-uploads it as a real attachment.
   */
  files?: string[];
  /**
   * Idempotency key for the create (see {@link announceNonce}). With
   * `enforceNonce` Discord returns the message it already made instead of making
   * a second one, so a retried POST can no longer duplicate the @-ping.
   */
  nonce?: string;
  enforceNonce?: boolean;
}

/** The bit of a fetched message the duplicate sweep needs. */
interface FetchedMessage {
  id: string;
  author: { id: string } | null;
  delete(): Promise<unknown>;
}

/**
 * The slice of a Discord text channel the announcer uses. Narrow on purpose so
 * {@link CalendarAnnouncer} is testable with a plain fake — including the
 * duplicate-send repair, which is the part that must not regress.
 */
interface AnnounceChannel {
  send(payload: AnnouncePayload): Promise<{ id: string }>;
  messages: {
    fetch(options: { limit: number } | { after: string; limit?: number }): Promise<
      Map<string, FetchedMessage>
    >;
  };
}

/** One announcement's outcome, for logs / the admin console / the dry-run script. */
export interface AnnouncementResult {
  eventId: number;
  title: string;
  startAtLocal: string;
  /** How the Discord event was resolved. */
  link: 'stored' | 'auto' | 'model' | 'none';
  discordEventId: string | null;
  discordEventUrl: string | null;
  /** The exact text posted (or that would be posted, in a dry run). */
  text: string;
  /** Cover image attached to the post (the Discord event's banner), if any. */
  imageUrl: string | null;
  posted: boolean;
  messageId: string | null;
  error?: string;
}

export interface AnnounceRunReport {
  ok: boolean;
  /** Why nothing happened, when nothing happened. */
  reason?: 'no_announce_channel' | 'channel_not_sendable' | 'not_yet' | 'nothing_today' | 'error';
  channelId: string | null;
  announced: AnnouncementResult[];
  /** Events (today/tomorrow) still missing a Discord scheduled event. */
  nudged: Array<{ eventId: number; title: string; startAtLocal: string }>;
  error?: string;
}

export interface AnnouncerDeps {
  client: Client;
  store: CalendarStore;
  /** Community channel the announcement goes to (DB setting → env fallback). */
  getAnnounceChannelId: () => string | null;
  /** Mention tokens for the announcement: role ids and/or `everyone`. */
  getAnnounceMentions: () => string[];
  /** Approver-role tokens — who to ping about a missing Discord event. */
  getModRoles: () => string[];
  /** Where mod-facing nudges go (the calendar management channel). */
  getManagementChannelId: () => string | null;
  /** Local hour from which announcing is allowed. */
  getAnnounceHour: () => number;
  now?: () => number;
}

export interface RunOptions {
  /** Ignore the announce-hour gate (used by the verify script and the console). */
  force?: boolean;
  /** Resolve and render everything, but post nothing and record nothing. */
  dryRun?: boolean;
  /** Re-announce even if the ledger says we already did (manual repost). */
  ignoreLedger?: boolean;
}

export class CalendarAnnouncer {
  private readonly now: () => number;

  constructor(private readonly deps: AnnouncerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * One pass of the daily job. Safe to call as often as the watcher ticks: the
   * hour gate and the ledger both narrow it to at most one post per occurrence.
   */
  async run(opts: RunOptions = {}): Promise<AnnounceRunReport> {
    const nowMs = this.now();
    const channelId = this.deps.getAnnounceChannelId();
    const base: AnnounceRunReport = { ok: false, channelId, announced: [], nudged: [] };
    if (!channelId) return { ...base, reason: 'no_announce_channel' };

    try {
      const channel = await this.deps.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        return { ...base, reason: 'channel_not_sendable' };
      }
      // The guild is derived from the announcement channel rather than
      // configured: the bot is in several servers, and the events that matter
      // are by definition the ones in the server we're announcing to.
      const guildId = 'guildId' in channel ? (channel.guildId as string | null) : null;
      if (!guildId) return { ...base, reason: 'channel_not_sendable' };

      const isAnnounced = (key: string) => (opts.ignoreLedger ? false : this.deps.store.isAnnounced(key));

      // Today's + tomorrow's occurrences: today's to announce, tomorrow's so the
      // "create the Discord event" nudge arrives with a day of lead time.
      const occurrences = this.occurrencesThroughTomorrow(nowMs);
      const due = announcementsDue({
        occurrences,
        nowMs,
        hour: opts.force ? 0 : this.deps.getAnnounceHour(),
        isAnnounced,
      });

      // Resolving links needs the Discord event list, which is also what the
      // nudge check keys off — fetch once for both.
      const discordEvents = await fetchScheduledEvents(this.deps.client, guildId);
      // The model may only arbitrate for an event we are about to ANNOUNCE.
      // Everything else this tick is here for the nudge check, which needs only
      // "is there plausibly a Discord event?" — a question the deterministic
      // scorer answers. Without this gate the watcher burns a model call every
      // 5 minutes, forever, on any event whose Discord counterpart nobody made
      // (observed live: one unmatched weekly series → ~288 calls/day).
      const dueKeys = new Set(due.map((o) => `${o.id}@${o.startAtMs}`));
      const targets: AnnounceTarget[] = [];
      for (const occ of occurrences) {
        targets.push(
          await this.resolveTarget(occ, guildId, discordEvents, opts, {
            allowModel: dueKeys.has(`${occ.id}@${occ.startAtMs}`),
          }),
        );
      }
      const byId = new Map(targets.map((t) => [`${t.occurrence.id}@${t.occurrence.startAtMs}`, t]));

      const report: AnnounceRunReport = { ...base, ok: true, announced: [], nudged: [] };

      for (const occ of due) {
        const target = byId.get(`${occ.id}@${occ.startAtMs}`) ?? {
          occurrence: occ,
          discordEvent: null,
          discordEventUrl: null,
        };
        report.announced.push(
          await this.announceOne(channel as unknown as AnnounceChannel, channelId, target, nowMs, opts),
        );
      }
      if (due.length === 0 && report.announced.length === 0) {
        report.reason = localParts(nowMs).hour < this.deps.getAnnounceHour() && !opts.force
          ? 'not_yet'
          : 'nothing_today';
      }

      // Nudge mods about missing Discord events (today + tomorrow), one message.
      const missing = nudgesDue({ targets, nowMs, isAnnounced });
      if (missing.length > 0) {
        const sent = await this.nudgeMods(guildId, missing, opts);
        if (sent) {
          for (const t of missing) {
            report.nudged.push({
              eventId: t.occurrence.id,
              title: t.occurrence.title,
              startAtLocal: formatInTimezone(t.occurrence.startAtMs),
            });
            if (!opts.dryRun) {
              this.deps.store.recordAnnouncement({
                announceKey: nudgeKey(t.occurrence.id, t.occurrence.startAtMs),
                eventId: t.occurrence.id,
                occurrenceStartAt: t.occurrence.startAtMs,
                channelId: this.deps.getManagementChannelId() ?? 'admin',
                messageId: null,
                discordEventId: null,
              });
            }
          }
        }
      }
      return report;
    } catch (err) {
      log.error({ err }, 'calendar.announce.failed');
      return { ...base, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  /** Occurrences from the start of today (local) through the end of tomorrow. */
  private occurrencesThroughTomorrow(nowMs: number): MatchableOccurrence[] {
    const p = localParts(nowMs);
    const startOfToday = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0) - WALL_CLOCK_OFFSET_MS;
    const endOfTomorrow = startOfToday + 2 * 86_400_000 - 1;
    return this.deps.store.listOccurrences(startOfToday, endOfTomorrow).map((o) => ({
      id: o.id,
      title: o.title,
      description: o.description,
      location: o.location,
      startAtMs: o.start_at,
    }));
  }

  /**
   * Attach the Discord scheduled event for one occurrence, cheapest path first:
   * a link we already stored, then the deterministic scorer, then the model.
   * A newly decided link is persisted on the calendar row, so the model is
   * consulted at most once per event rather than once per day.
   *
   * `allowModel` is false for occurrences we're only inspecting for the nudge
   * check (see the caller). Then an ambiguous verdict resolves to "no link" for
   * reporting but is treated as **plausibly linked** by the nudge — nagging mods
   * about an event that probably already exists is worse than staying quiet, and
   * the announcement pass will settle it properly on the day.
   */
  private async resolveTarget(
    occ: MatchableOccurrence,
    guildId: string,
    discordEvents: DiscordScheduledEvent[] | null,
    opts: RunOptions,
    { allowModel }: { allowModel: boolean },
  ): Promise<AnnounceTarget & { link: AnnouncementResult['link'] }> {
    const stored = this.deps.store.get(occ.id)?.discord_event_id ?? null;
    if (stored) {
      const found =
        discordEvents?.find((e) => e.id === stored) ??
        (await fetchScheduledEvent(this.deps.client, guildId, stored));
      if (found) return { occurrence: occ, discordEvent: found, discordEventUrl: found.url, link: 'stored' };
      // The admin deleted it — forget the stale link and try to match again.
      if (!opts.dryRun) this.deps.store.setDiscordEventId(occ.id, null);
      log.info({ eventId: occ.id, stale: stored }, 'calendar.announce.stale_link_cleared');
    }
    if (!discordEvents || discordEvents.length === 0) {
      return { occurrence: occ, discordEvent: null, discordEventUrl: null, link: 'none' };
    }

    const candidates = candidatesFor(occ, discordEvents);
    const verdict = matchVerdict(candidates);
    if (verdict.kind === 'matched') {
      const picked = discordEvents.find((e) => e.id === verdict.candidate.discordEventId)!;
      if (!opts.dryRun) this.deps.store.setDiscordEventId(occ.id, picked.id);
      log.info(
        {
          eventId: occ.id,
          discordEventId: picked.id,
          score: Number(verdict.candidate.score.toFixed(3)),
          titleScore: Number(verdict.candidate.titleScore.toFixed(3)),
          minutesApart: Math.round(verdict.candidate.minutesApart),
        },
        'calendar.announce.matched_auto',
      );
      return { occurrence: occ, discordEvent: picked, discordEventUrl: picked.url, link: 'auto' };
    }
    if (verdict.kind === 'none') {
      return { occurrence: occ, discordEvent: null, discordEventUrl: null, link: 'none' };
    }
    if (!allowModel) {
      // Ambiguous, and we're not announcing this one now: report no link, but
      // mark it plausible so the nudge stays quiet.
      return {
        occurrence: occ,
        discordEvent: null,
        discordEventUrl: null,
        link: 'none',
        maybeLinked: true,
      };
    }

    // Ambiguous → let the model arbitrate, then verify its answer against the
    // candidate list (a hallucinated id must never become a community link).
    const enriched = verdict.candidates.map((c) => {
      const de = discordEvents.find((e) => e.id === c.discordEventId)!;
      return { ...c, startAtMs: de.startAtMs, description: de.description };
    });
    let chosen: string | null = null;
    let reason = '';
    try {
      const reply = await ask({
        system: renderMatchPrompt(occ, enriched),
        messages: [{ role: 'user', content: 'Decide.' }],
        tools: NO_TOOLS,
        effort: 'medium',
      });
      const parsed = parseMatchReply(reply, enriched.map((c) => c.discordEventId));
      chosen = parsed.discordEventId;
      reason = parsed.reason;
    } catch (err) {
      log.warn({ err, eventId: occ.id }, 'calendar.announce.match_model_failed');
    }
    log.info(
      {
        eventId: occ.id,
        title: occ.title,
        candidates: enriched.map((c) => ({ id: c.discordEventId, name: c.name, score: Number(c.score.toFixed(3)) })),
        chosen,
        reason,
      },
      'calendar.announce.matched_model',
    );
    if (!chosen) return { occurrence: occ, discordEvent: null, discordEventUrl: null, link: 'none' };
    const picked = discordEvents.find((e) => e.id === chosen)!;
    if (!opts.dryRun) this.deps.store.setDiscordEventId(occ.id, picked.id);
    return { occurrence: occ, discordEvent: picked, discordEventUrl: picked.url, link: 'model' };
  }

  /** Write, post and record one announcement. */
  private async announceOne(
    channel: AnnounceChannel,
    channelId: string,
    target: AnnounceTarget & { link?: AnnouncementResult['link'] },
    nowMs: number,
    opts: RunOptions,
  ): Promise<AnnouncementResult> {
    const occ = target.occurrence;
    const body = await this.writeAnnouncement(target, nowMs);
    const mentions = renderAnnounceMentions(this.deps.getAnnounceMentions());
    const text = prefixMentions(appendEventLink(body, target.discordEventUrl), mentions.text);

    const result: AnnouncementResult = {
      eventId: occ.id,
      title: occ.title,
      startAtLocal: formatInTimezone(occ.startAtMs),
      link: target.link ?? (target.discordEvent ? 'stored' : 'none'),
      discordEventId: target.discordEvent?.id ?? null,
      discordEventUrl: target.discordEventUrl,
      text,
      imageUrl: target.discordEvent?.imageUrl ?? null,
      posted: false,
      messageId: null,
    };
    if (opts.dryRun) return result;

    // A deliberate repost is a *new* message on purpose, so it must not be
    // deduplicated against this morning's — everything else shares the
    // occurrence's stable key.
    const nonce = announceNonce(occ.id, occ.startAtMs, opts.ignoreLedger ? nowMs : undefined);
    const sent = await this.sendExactlyOnce(channel, channelId, {
      content: text,
      allowedMentions: {
        // `parse` is explicit so @everyone can only ever fire when it was
        // actually configured, and an invented role id can never ping.
        parse: mentions.everyone ? ['everyone'] : [],
        roles: mentions.roleIds,
      },
      files: result.imageUrl ? [result.imageUrl] : undefined,
      nonce,
      enforceNonce: true,
    });
    if (!sent.ok) {
      result.error = sent.error;
      log.warn({ eventId: occ.id, channelId, error: sent.error }, 'calendar.announce.post_failed');
      return result;
    }

    result.posted = true;
    result.messageId = sent.messageId;
    this.deps.store.recordAnnouncement({
      announceKey: announceKey(occ.id, occ.startAtMs),
      eventId: occ.id,
      occurrenceStartAt: occ.startAtMs,
      channelId,
      messageId: sent.messageId,
      discordEventId: target.discordEvent?.id ?? null,
    });
    log.info(
      {
        eventId: occ.id,
        title: occ.title,
        channelId,
        messageId: sent.messageId,
        duplicatesRemoved: sent.duplicatesRemoved,
        nonce,
        link: result.link,
        discordEventId: result.discordEventId,
        hasImage: result.imageUrl !== null,
      },
      'calendar.announce.posted',
    );
    return result;
  }

  /**
   * Post the announcement and guarantee the channel ends up with exactly ONE of
   * it — then return the id that actually survived.
   *
   * This is not paranoia; it is a bug we hit repeatedly in production. A create
   * whose *response* is lost is indistinguishable, client-side, from a create
   * that never happened, so `@discordjs/rest` (defaults: 15 s timeout, 3
   * retries) retries it — and on this Pi's uplink the server had already made
   * the message. Measured live, the gap between the copies was 14.8 s, 14.9 s
   * and 29.9 s: exactly one and two timeouts. Everywhere else in this bot a
   * duplicated send is a harmless repeated reply; here it is a duplicated @-ping
   * to the whole server, so the send is defended twice over:
   *
   *   **Prevention** — the payload carries `nonce` + `enforceNonce`, Discord's
   *   own idempotency key, so the retry returns the existing message rather than
   *   creating a second one. This is the part that matters, because it is the
   *   only one that acts *before* a notification fires: on 2026-08-11 three
   *   copies landed and an admin deleted two of them by hand nine seconds before
   *   the sweep below could, and the community had already been pinged 3×.
   *
   *   **Repair** — the sweep, kept as a backstop for anything the nonce doesn't
   *   cover (a copy created outside Discord's dedup window, an older gateway
   *   path): note the channel's newest message id, send, then look at what
   *   actually appeared after that mark — keep the earliest of our own messages,
   *   delete the rest.
   *
   * The sweep also repairs the opposite failure: when the send REJECTS but the
   * message got created anyway, we adopt the orphan instead of leaving no ledger
   * row and re-announcing on the next tick.
   */
  private async sendExactlyOnce(
    channel: AnnounceChannel,
    channelId: string,
    payload: AnnouncePayload,
  ): Promise<{ ok: true; messageId: string; duplicatesRemoved: number } | { ok: false; error: string }> {
    const botId = this.deps.client.user?.id ?? null;
    const sinceId = await this.newestMessageId(channel);

    let sentId: string | null = null;
    let sendError: string | null = null;
    try {
      sentId = (await channel.send(payload)).id;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    // Without a mark (or without knowing who we are) we can't tell our new
    // messages from anything else in the channel, so don't risk deleting
    // somebody's post — trust the single send. Only reachable in an empty
    // channel, i.e. at most for the very first announcement ever.
    if (sinceId === null || botId === null) {
      if (sentId !== null) return { ok: true, messageId: sentId, duplicatesRemoved: 0 };
      return { ok: false, error: sendError ?? 'send_failed' };
    }

    const mine = await this.ownMessagesAfter(channel, sinceId, botId);
    if (mine.length === 0) {
      // Nothing landed. If `send` claimed success we still trust its id (the
      // fetch itself may have failed); otherwise this is a genuine failure and
      // the absent ledger row makes the next tick retry.
      if (sentId !== null) return { ok: true, messageId: sentId, duplicatesRemoved: 0 };
      return { ok: false, error: sendError ?? 'send_failed' };
    }

    const [keep, ...extras] = mine;
    let removed = 0;
    for (const dup of extras) {
      try {
        await dup.delete();
        removed += 1;
      } catch {
        // Couldn't clean up — the duplicate stays, but the ledger still records
        // one message so we won't add a third.
      }
    }
    if (removed > 0 || sentId !== keep!.id) {
      log.warn(
        { channelId, kept: keep!.id, returned: sentId, landed: mine.length, removed },
        'calendar.announce.duplicate_send_repaired',
      );
    }
    return { ok: true, messageId: keep!.id, duplicatesRemoved: removed };
  }

  /** Newest message id in the channel, or null if it's empty / unreadable. */
  private async newestMessageId(channel: AnnounceChannel): Promise<string | null> {
    try {
      const latest = await channel.messages.fetch({ limit: 1 });
      for (const m of latest.values()) return m.id;
      return null;
    } catch {
      return null;
    }
  }

  /** Our own messages posted after `sinceId`, oldest first. */
  private async ownMessagesAfter(
    channel: AnnounceChannel,
    sinceId: string,
    botId: string,
  ): Promise<FetchedMessage[]> {
    try {
      const after = await channel.messages.fetch({ after: sinceId, limit: 10 });
      return [...after.values()]
        .filter((m) => m.author?.id === botId)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    } catch {
      return [];
    }
  }

  /** The announcement text: the model in the community's voice, else the template. */
  private async writeAnnouncement(target: AnnounceTarget, nowMs: number): Promise<string> {
    try {
      const written = (
        await ask({
          system: renderAnnouncementPrompt(target, nowMs),
          messages: [{ role: 'user', content: 'Escribe el anuncio de hoy.' }],
          tools: NO_TOOLS,
        })
      ).trim();
      // A model that returns nothing (or a refusal-length stub) must not become
      // an empty community post — fall through to the template.
      if (written.length >= 20) return written;
      log.warn({ eventId: target.occurrence.id, length: written.length }, 'calendar.announce.model_too_short');
    } catch (err) {
      log.warn({ err, eventId: target.occurrence.id }, 'calendar.announce.model_failed');
    }
    return renderFallbackAnnouncement(target);
  }

  /**
   * Tell the mods that a Discord scheduled event is missing. Goes to the
   * calendar management channel (where mods already talk to the bot) with the
   * approver roles pinged — falling back to the config channel, because a nudge
   * nobody sees is the exact failure this is meant to fix.
   */
  private async nudgeMods(
    guildId: string,
    missing: readonly AnnounceTarget[],
    opts: RunOptions,
  ): Promise<boolean> {
    const lines = [
      missing.length === 1
        ? '📌 **Falta crear el evento de Discord** para lo que viene:'
        : '📌 **Faltan eventos de Discord** para lo que viene:',
    ];
    for (const t of missing) {
      const when = formatInTimezone(t.occurrence.startAtMs);
      // The id is printed because the ask below is "díganme «… del #N»" — a
      // placeholder the mods can't resolve makes that instruction unusable, and
      // it's also what pins the referent when someone replies to this nudge.
      lines.push(
        `- **#${t.occurrence.id} ${t.occurrence.title}** — ${when} (a las ${formatLocalClock(t.occurrence.startAtMs)})`,
      );
    }
    const example = missing.length === 1 ? `#${missing[0]!.occurrence.id}` : '#<id>';
    lines.push(
      '',
      'Sin el evento de Discord el anuncio del día sale sin el enlace para apuntarse. ' +
        `Créenlo en **Eventos → Crear evento** del servidor, o **respondan a este mensaje** con *"crea el evento de Discord del ${example}"* y lo hago yo ` +
        '(díganme también en qué sala será, si no la tiene).',
    );

    const mentions = await this.resolveModMentions(guildId);
    const body = mentions.text
      ? `${lines.join('\n')}\n\n${mentions.notifies ? mentions.text : `Aviso para ${mentions.text}`}`
      : lines.join('\n');
    if (opts.dryRun) {
      log.info({ missing: missing.length, body }, 'calendar.announce.nudge_dry_run');
      return true;
    }

    const managementChannelId = this.deps.getManagementChannelId();
    if (managementChannelId) {
      try {
        const ch = await this.deps.client.channels.fetch(managementChannelId);
        if (ch && ch.isTextBased() && 'send' in ch) {
          await (ch as {
            send(o: {
              content: string;
              allowedMentions: { parse: string[]; roles: string[] };
            }): Promise<unknown>;
          }).send({
            content: body,
            allowedMentions: { parse: [], roles: mentions.notifyIds },
          });
          log.info(
            { channelId: managementChannelId, missing: missing.length, notified: mentions.notifyIds.length },
            'calendar.announce.nudge_posted',
          );
          return true;
        }
      } catch (err) {
        log.warn({ err, channelId: managementChannelId }, 'calendar.announce.nudge_failed');
      }
    }
    // Fallback surface (no mod-facing channel resolvable): the nudge still has
    // to ring the approver roles, so they're passed as the explicit allowlist.
    await sendAdminAlert(this.deps.client, [body], 'calendar.announce.nudge', mentions.notifyIds);
    return true;
  }

  /**
   * Approver roles for the nudge, restricted to roles marked **mentionable**.
   *
   * Deliberately passes `canMentionAny: false` even when the bot holds
   * MentionEveryone: a role left unmentionable is the admins saying "don't ping
   * this one", and a recurring housekeeping reminder is the last thing that
   * should override that. In this guild the difference is real — the approver set
   * is five roles, of which two are mentionable; without the restriction a
   * routine "create the Discord event" nudge would page all five.
   */
  private async resolveModMentions(guildId: string): Promise<ModMentions> {
    try {
      const guild = await this.deps.client.guilds.fetch(guildId);
      let roles = guild.roles.cache;
      if (roles.size === 0) roles = await guild.roles.fetch();
      return resolveModMentions(
        roles.map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
        this.deps.getModRoles(),
        { canMentionAny: false },
      );
    } catch (err) {
      log.warn({ err, guildId }, 'calendar.announce.mentions_failed');
      return { matched: [], notifyIds: [], silent: [], text: '', notifies: false };
    }
  }
}
