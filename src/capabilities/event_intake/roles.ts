/**
 * Pure "is this member a moderator?" role matching — no discord.js imports so
 * it's unit-testable. A configured token is either a role id (snowflake) or a
 * role NAME (matched accent/case-insensitively). With nothing configured we
 * fall back to the community's actual approver roles.
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
