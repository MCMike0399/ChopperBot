/**
 * The Discord half of on-demand announcements: turning the words a mod used for
 * a channel into a channel we may actually post to, and posting there exactly
 * once.
 *
 * Kept apart from {@link ./broadcast.js} (the pure policy) for the usual reason
 * in this capability: everything that can be decided without Discord is decided
 * there and unit-tested, and this file is the thin, faked-in-tests boundary.
 *
 * Two guarantees live here:
 *
 *  - **A channel is only a target if the bot can genuinely post to it.** A
 *    resolution that looks fine but fails at send time would leave a mod told
 *    "listo, lo publiqué en 3 canales" when it landed in two. So sendability is
 *    checked while resolving, and an unpostable channel is reported to the mod
 *    *before* they confirm.
 *  - **Exactly once per channel.** Same failure this Pi hit with the daily
 *    announcement (a create whose response is lost gets retried after Discord
 *    already made the message), same fix: Discord's own `nonce` + `enforce_nonce`
 *    idempotency key. Deleting a duplicate does not retract its notification, so
 *    prevention is the only thing that helps.
 */
import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { log } from '../../log.js';
import { normalizeChannelQuery } from '../general_chat/server-tools.js';
import type {
  BroadcastChannel,
  BroadcastMentions,
  ChannelResolution,
  ChannelResolutionReason,
} from './broadcast.js';
import { broadcastNonce } from './broadcast.js';

/**
 * Channel types an announcement can be posted into, and how.
 *
 * Forums are included because this community organizes activities as forums
 * (`foro-poesía`), so "anúncialo en foro poesía" is an ordinary request — but a
 * forum takes no loose messages, so it's posted to by opening a new post.
 * Leaving forums out made the bot answer "no encontré ningún canal con ese
 * nombre" for a channel the mod was looking straight at.
 */
const POSTABLE_TYPES = new Map<ChannelType, BroadcastChannel['kind']>([
  [ChannelType.GuildText, 'text'],
  [ChannelType.GuildAnnouncement, 'text'],
  [ChannelType.GuildForum, 'forum'],
]);

/** A candidate target, with whether we may actually write there. */
export interface CandidateChannel extends BroadcastChannel {
  sendable: boolean;
}

/** Resolving mod words → channels, and posting to them. Faked in tests. */
export interface CalendarBroadcaster {
  /**
   * Resolve each channel the mod named. Order and arity mirror the input, so
   * the caller can report per-query outcomes ("no encontré «foro poesia»").
   */
  resolve(queries: readonly string[]): Promise<ChannelResolution[]>;
  /** Post one message to one channel, idempotently. */
  post(input: {
    target: BroadcastChannel;
    content: string;
    mentions: BroadcastMentions;
    imageUrl: string | null;
    /** Title for the forum post; required when the target is a forum. */
    threadTitle: string | null;
    /** Draft token — the idempotency key's stable half. */
    token: string;
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;
}

export interface BroadcasterDeps {
  client: Client;
  guildId: string;
}

export function createBroadcaster({ client, guildId }: BroadcasterDeps): CalendarBroadcaster {
  /**
   * Every channel in the guild the BOT can post an announcement into.
   *
   * Note this is the bot's view, not the asking mod's: the caller has already
   * established the author is an approver (`isModTurn`), and the approver roles
   * in this guild can see the channels that matter. What we cannot do is offer a
   * channel the bot itself can't write to — that's the failure the mod would
   * otherwise discover from a half-completed fan-out.
   */
  async function listCandidates(guild: Guild): Promise<CandidateChannel[]> {
    const me = await guild.members.fetchMe().catch(() => null);
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return [];
    const out: CandidateChannel[] = [];
    for (const c of channels.values()) {
      const kind = c ? POSTABLE_TYPES.get(c.type) : undefined;
      if (!c || !kind) continue;
      const perms = me ? c.permissionsFor(me) : null;
      const sendable =
        perms !== null &&
        perms.has(PermissionFlagsBits.ViewChannel) &&
        // In a forum, `SendMessages` IS "create posts" — same flag, so one check
        // covers both shapes.
        perms.has(PermissionFlagsBits.SendMessages);
      out.push({ id: c.id, name: c.name, kind, sendable });
    }
    return out;
  }

  return {
    async resolve(queries): Promise<ChannelResolution[]> {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        return queries.map((query) => ({ query, reason: 'unknown' as const, match: null, candidates: [] }));
      }
      const all = await listCandidates(guild);
      return queries.map((query) => resolveOne(all, query));
    },

    async post({ target, content, mentions, imageUrl, threadTitle, token }) {
      const allowedMentions = {
        // Explicit, like the daily announcement: @everyone can only fire
        // when it was actually resolved, and an invented role id can't ping.
        parse: mentions.everyone ? ['everyone'] : [],
        roles: mentions.roleIds,
      };
      const files = imageUrl ? [imageUrl] : undefined;

      try {
        const channel = await client.channels.fetch(target.id);
        if (!channel) return { ok: false, error: 'channel_not_found' };

        if (target.kind === 'forum') {
          return await postForum({ channel, content, allowedMentions, files, threadTitle, target });
        }

        if (!channel.isTextBased() || !('send' in channel)) {
          return { ok: false, error: 'channel_not_sendable' };
        }
        const sent = await (
          channel as unknown as {
            send(o: {
              content: string;
              allowedMentions: { parse: string[]; roles: string[] };
              files?: string[];
              nonce?: string;
              enforceNonce?: boolean;
            }): Promise<{ id: string }>;
          }
        ).send({
          content,
          allowedMentions,
          files,
          nonce: broadcastNonce(token, target.id),
          enforceNonce: true,
        });
        return { ok: true, messageId: sent.id };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn({ err, channelId: target.id, kind: target.kind }, 'calendar.broadcast.post_failed');
        return { ok: false, error };
      }
    },
  };
}

/**
 * Open a forum post for the announcement.
 *
 * Thread creation has no `nonce`/`enforce_nonce` (that's a message-create
 * feature), so the exactly-once guarantee the text path gets from Discord has to
 * be approximated here: before creating, look for a post the bot already opened
 * under this exact title. Combined with the single-use draft token this covers
 * the case that actually bites on this Pi — a create whose response was lost to
 * a timeout, retried after Discord already made the post.
 */
async function postForum(input: {
  channel: unknown;
  content: string;
  allowedMentions: { parse: string[]; roles: string[] };
  files: string[] | undefined;
  threadTitle: string | null;
  target: BroadcastChannel;
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const { channel, content, allowedMentions, files, threadTitle, target } = input;
  const forum = channel as {
    threads?: {
      create(o: {
        name: string;
        message: {
          content: string;
          allowedMentions: { parse: string[]; roles: string[] };
          files?: string[];
        };
      }): Promise<{ id: string }>;
      fetchActive?(): Promise<{ threads: Map<string, { id: string; name: string }> }>;
    };
  };
  if (!forum.threads) return { ok: false, error: 'forum_not_postable' };

  const name = (threadTitle ?? '').trim();
  if (!name) return { ok: false, error: 'forum_needs_title' };

  const active = await forum.threads.fetchActive?.().catch(() => null);
  const existing = active
    ? [...active.threads.values()].find((t) => t.name === name)
    : undefined;
  if (existing) {
    log.info({ channelId: target.id, threadId: existing.id }, 'calendar.broadcast.forum_post_exists');
    return { ok: true, messageId: existing.id };
  }

  const thread = await forum.threads.create({
    name,
    message: { content, allowedMentions, files },
  });
  return { ok: true, messageId: thread.id };
}

/**
 * Match one of the mod's words to a channel: an id/`<#id>` wins outright, then
 * an exact normalized name, then a unique substring. Several substring hits are
 * returned as candidates rather than guessed — "foro" naming three foros is a
 * question for the mod, not a coin flip in somebody else's channel.
 *
 * A channel the bot can't write in resolves to `not_sendable` rather than
 * `unknown`, because those need opposite answers from the mod ("dame permiso
 * ahí" vs "quisiste decir cuál?").
 *
 * Exported (with the internal candidate shape) so the whole matcher is
 * unit-testable without a guild.
 */
export function resolveOne(
  channels: readonly CandidateChannel[],
  query: string,
): ChannelResolution {
  const sendable = channels.filter((c) => c.sendable);
  const strip = (c: CandidateChannel): BroadcastChannel => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
  });
  const nope = (reason: ChannelResolutionReason, candidates: CandidateChannel[] = []) => ({
    query,
    reason,
    match: null,
    candidates: candidates.slice(0, 6).map(strip),
  });

  const idMatch = query.trim().match(/^(?:<#)?(\d{17,20})>?$/);
  if (idMatch) {
    const byId = sendable.find((c) => c.id === idMatch[1]);
    if (byId) return { query, reason: 'ok', match: strip(byId), candidates: [] };
    const unsendable = channels.find((c) => c.id === idMatch[1]);
    return unsendable ? nope('not_sendable', [unsendable]) : nope('unknown');
  }

  const q = normalizeChannelQuery(query);
  if (!q) return nope('unknown');

  const matches = (name: string): boolean => name === q || name.includes(q) || q.includes(name);

  const exact = sendable.filter((c) => normalizeChannelQuery(c.name) === q);
  if (exact.length === 1) return { query, reason: 'ok', match: strip(exact[0]!), candidates: [] };
  if (exact.length > 1) return nope('ambiguous', exact);

  // Substring both ways: the mod's word may be shorter than the decorated
  // channel name ("general" → "💬│general-revz") or longer than it.
  const partial = sendable.filter((c) => matches(normalizeChannelQuery(c.name)));
  if (partial.length === 1) return { query, reason: 'ok', match: strip(partial[0]!), candidates: [] };
  if (partial.length > 1) return nope('ambiguous', [...partial].sort((a, b) => a.name.length - b.name.length));

  // Nothing sendable matched — is it a channel we simply can't write in?
  const blocked = channels.filter((c) => !c.sendable && matches(normalizeChannelQuery(c.name)));
  return blocked.length > 0 ? nope('not_sendable', blocked) : nope('unknown');
}
