/**
 * Deciding WHO the bot @-mentions in a ticket, and whether that mention will
 * actually notify anyone. Pure (no discord.js) so it's unit-testable; the
 * watcher feeds it a plain snapshot of the guild's roles.
 *
 * The hard constraint this module encodes: Discord only *notifies* a role
 * mention when the role is `mentionable`, or when the author holds the
 * "Mention @everyone, @here and All Roles" permission. Everything else still
 * RENDERS as a role chip — which is worse than saying nothing, because it looks
 * like the mods were pinged when nobody was. So we only ever emit `<@&id>` for
 * roles we can genuinely notify, and fall back to naming the rest in plain text.
 */

import { matchModRoles, type NamedRole } from './roles.js';

/** A guild role as far as mention resolution cares. */
export interface MentionableRole extends NamedRole {
  mentionable: boolean;
}

export interface ModMentions {
  /** Approver roles that exist in this guild (notifiable or not). */
  matched: MentionableRole[];
  /** Role ids Discord will actually notify — what goes in `allowedMentions.roles`. */
  notifyIds: string[];
  /** Approver roles present but NOT notifiable (unmentionable + no permission). */
  silent: MentionableRole[];
  /** Ready to paste into a message: role mentions, else plain names, else ''. */
  text: string;
  /** Whether {@link text} will actually ping somebody. */
  notifies: boolean;
}

export const EMPTY_MOD_MENTIONS: ModMentions = {
  matched: [],
  notifyIds: [],
  silent: [],
  text: '',
  notifies: false,
};

/** How long after a role ping in a ticket we stay silent (chips still render). */
export const MOD_PING_COOLDOWN_MS = 10 * 60_000;

const ROLE_MENTION_RE = /<@&(\d{17,20})>/g;

/**
 * Resolve the approver roles of a guild into something postable.
 *
 * @param guildRoles every role of the guild (id + name + mentionable).
 * @param tokens the configured approver tokens (empty → the defaults).
 * @param opts.canMentionAny whether the bot holds MentionEveryone *here*.
 */
export function resolveModMentions(
  guildRoles: readonly MentionableRole[],
  tokens: readonly string[],
  opts: { canMentionAny: boolean },
): ModMentions {
  const matched = matchModRoles(guildRoles, tokens);
  if (matched.length === 0) return EMPTY_MOD_MENTIONS;

  const notifiable = matched.filter((r) => opts.canMentionAny || r.mentionable);
  const silent = matched.filter((r) => !notifiable.includes(r));

  if (notifiable.length > 0) {
    return {
      matched,
      notifyIds: notifiable.map((r) => r.id),
      silent,
      text: notifiable.map((r) => `<@&${r.id}>`).join(' '),
      notifies: true,
    };
  }
  // Nothing can be pinged: name the roles in plain text (no `@`, no chip) so the
  // message still says who approves, without faking a notification.
  return {
    matched,
    notifyIds: [],
    silent,
    text: matched.map((r) => r.name).join(' / '),
    notifies: false,
  };
}

/** Whether `text` mentions at least one of `ids`. */
export function hasRoleMention(text: string, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const set = new Set(ids);
  return [...text.matchAll(ROLE_MENTION_RE)].some((m) => set.has(m[1]!));
}

/** The subset of `ids` actually mentioned in `text`, in `ids` order. */
export function mentionedRoleIds(text: string, ids: readonly string[]): string[] {
  const present = new Set([...text.matchAll(ROLE_MENTION_RE)].map((m) => m[1]!));
  return ids.filter((id) => present.has(id));
}

/**
 * Drop any role mention the model invented. A `<@&id>` outside the allowed set
 * can't ping (allowedMentions gates that) but still renders as a chip — often
 * "@deleted-role" — so we strip it rather than post a broken mention.
 */
export function sanitizeRoleMentions(text: string, allowedIds: readonly string[]): string {
  const allowed = new Set(allowedIds);
  let touched = false;
  const out = text.replace(ROLE_MENTION_RE, (full, id: string) => {
    if (allowed.has(id)) return full;
    touched = true;
    return '';
  });
  return touched ? out.replace(/[ \t]{2,}/g, ' ').replace(/ +$/gm, '') : out;
}

/**
 * Append the mod call-to-action to a proposal. Deterministic on purpose — the
 * proposal is exactly the moment mods must be notified, so it can't depend on
 * the model remembering to mention them (and the prompt tells it not to).
 */
export function appendModPing(text: string, mentions: ModMentions): string {
  if (!mentions.text) return text;
  if (hasRoleMention(text, mentions.notifyIds)) return text;
  const tail = mentions.notifies
    ? `${mentions.text} ⬆️ propuesta pendiente de su aprobación.`
    : `⬆️ propuesta pendiente de aprobación por ${mentions.text}.`;
  return `${text.trimEnd()}\n\n${tail}`;
}

/** Cooldown gate: whether a role ping in this ticket may notify again. */
export function shouldNotifyRoles(
  lastNotifiedAt: number | undefined,
  now: number,
  cooldownMs: number = MOD_PING_COOLDOWN_MS,
): boolean {
  if (lastNotifiedAt === undefined) return true;
  return now - lastNotifiedAt >= cooldownMs;
}
