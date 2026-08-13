/**
 * Who the moderators are, and how to @-mention them so Discord really notifies.
 *
 * Pure (no discord.js imports) so it's unit-testable — callers feed it a plain
 * snapshot of the guild's roles. A configured token is either a role id
 * (snowflake) or a role NAME (matched accent/case-insensitively); with nothing
 * configured we fall back to the community's actual approver roles.
 *
 * This lives under `src/discord/` rather than inside a capability because three
 * places now need the SAME answer: event_intake (who may approve a ticket + who
 * to ping there), the configuration console (reporting pingability), and the
 * calendar announcer (nudging mods about a missing Discord event). One matcher
 * means "who gets pinged" can never drift from "who may approve".
 */

/** The minimum a role needs to be matched against the approver tokens. */
export interface NamedRole {
  id: string;
  name: string;
}

/**
 * Default approver roles when none are configured. These are the Revolución Z
 * Moderador / Administrador / Administradora (+ staff) role IDS — deterministic
 * (a rename can't silently change who can approve). Names are still accepted as
 * configured tokens, but the out-of-the-box default is by id on purpose.
 */
export const DEFAULT_MOD_ROLES = [
  '1483734077944365149',
  '1436259908222713917',
  '1517610228969902130',
  '1436055845392879778',
  '1483694810253492235',
] as const;

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Fold a role name / token for comparison: accents off, lowercase, and all
 * decoration dropped. That last part matters here \u2014 this community's roles are
 * emoji-wrapped ("\ud83d\ude93Moderaci\u00f3n\ud83d\ude93", "\u2b50Administrador\u2b50"), so a mod configuring
 * `set_mod_roles roles:"Moderaci\u00f3n, Administrador"` would otherwise match NOTHING
 * and silently leave nobody able to approve a ticket.
 */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The tokens actually in force: the configured ones, else the defaults. */
export function effectiveModTokens(tokens: readonly string[]): readonly string[] {
  return tokens.length > 0 ? tokens : DEFAULT_MOD_ROLES;
}

/**
 * The subset of `roles` that matches an approver token. Tokens that look like
 * snowflakes match by role id; the rest match by normalized role name. Empty
 * `tokens` uses {@link DEFAULT_MOD_ROLES}.
 *
 * This is the single matcher behind BOTH "who may approve" (`isModByRole`) and
 * "who do we @-mention in a ticket" (`resolveModMentions`), so the roles the bot
 * pings can never drift from the roles it actually accepts an approval from.
 */
export function matchModRoles<T extends NamedRole>(
  roles: readonly T[],
  tokens: readonly string[],
): T[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const t of effectiveModTokens(tokens)) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (SNOWFLAKE_RE.test(trimmed)) ids.add(trimmed);
    else names.add(norm(trimmed));
  }
  return roles.filter((r) => ids.has(r.id) || names.has(norm(r.name)));
}

/** Whether any of the member's roles matches an approver token. */
export function isModByRole(
  memberRoles: ReadonlyArray<NamedRole>,
  tokens: readonly string[],
): boolean {
  return matchModRoles(memberRoles, tokens).length > 0;
}

/**
 * Who is asking, as far as authorization goes — the snapshot the message
 * handler takes of the Discord member and hands to `buildTurn`.
 *
 * `memberRoles` is `undefined` (not `[]`) when the member could not be resolved
 * at all (a DM, a fetch failure): {@link isModCaller} treats that as "not a
 * mod", never as "no roles, therefore allowed".
 */
export interface TurnAuthority {
  memberRoles?: readonly NamedRole[];
  isAdministrator?: boolean;
}

/**
 * The single privileged-action gate for channel-bound capabilities: an approver
 * role, or Discord's Administrator permission. **Fails closed** — an unresolved
 * member is not a mod.
 *
 * This exists because channel permissions were the *only* thing standing
 * between a member and the admin console / the calendar's write tools. That was
 * already thin; it stopped being acceptable when the bot was granted
 * Administrator in the guild (2026-08-13), which is also what made every role
 * pingable — see `createClient`'s `allowedMentions`.
 */
export function isModCaller(caller: TurnAuthority, tokens: readonly string[]): boolean {
  if (caller.isAdministrator === true) return true;
  if (!caller.memberRoles) return false;
  return isModByRole(caller.memberRoles, tokens);
}

// ── Mentioning them ─────────────────────────────────────────────────────────
//
// The hard constraint this half encodes: Discord only *notifies* a role mention
// when the role is `mentionable`, or when the author holds the "Mention
// @everyone, @here and All Roles" permission. Everything else still RENDERS as
// a role chip — which is worse than saying nothing, because it looks like the
// mods were pinged when nobody was. So we only ever emit `<@&id>` for roles we
// can genuinely notify, and fall back to naming the rest in plain text.

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
 * The two moments the whole team is told about, whatever the model writes:
 * a request arriving (needs approval) and a request becoming a real event.
 */
export type ModPingKind = 'proposal' | 'created';

function pingTail(kind: ModPingKind, mentions: ModMentions): string {
  if (kind === 'created') {
    return mentions.notifies
      ? `${mentions.text} ✅ aprobado y agendado — ya está en el calendario.`
      : `✅ aprobado y agendado — aviso para ${mentions.text}.`;
  }
  return mentions.notifies
    ? `${mentions.text} ⬆️ propuesta pendiente de su aprobación.`
    : `⬆️ propuesta pendiente de aprobación por ${mentions.text}.`;
}

/**
 * Append the mod notice. Deterministic on purpose — a request arriving and a
 * request being approved are exactly the two moments the team must hear about,
 * so neither can depend on the model remembering to mention anyone (and the
 * prompts tell it not to).
 */
export function appendModPing(
  text: string,
  mentions: ModMentions,
  kind: ModPingKind = 'proposal',
): string {
  if (!mentions.text) return text;
  if (hasRoleMention(text, mentions.notifyIds)) return text;
  return `${text.trimEnd()}\n\n${pingTail(kind, mentions)}`;
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
