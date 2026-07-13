/**
 * Pure "is this member a moderator?" role matching — no discord.js imports so
 * it's unit-testable. A configured token is either a role id (snowflake) or a
 * role NAME (matched accent/case-insensitively). With nothing configured we
 * fall back to the community's actual approver roles.
 */

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

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Whether any of the member's roles matches an approver token. Tokens that look
 * like snowflakes match by role id; the rest match by normalized role name.
 * Empty `tokens` uses {@link DEFAULT_MOD_ROLES}.
 */
export function isModByRole(
  memberRoles: ReadonlyArray<{ id: string; name: string }>,
  tokens: readonly string[],
): boolean {
  const active = tokens.length > 0 ? tokens : DEFAULT_MOD_ROLES;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const t of active) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (SNOWFLAKE_RE.test(trimmed)) ids.add(trimmed);
    else names.add(norm(trimmed));
  }
  return memberRoles.some((r) => ids.has(r.id) || names.has(norm(r.name)));
}
