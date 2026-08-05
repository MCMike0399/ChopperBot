import { describe, test, expect } from 'vitest';
import {
  appendModPing,
  hasRoleMention,
  mentionedRoleIds,
  resolveModMentions,
  sanitizeRoleMentions,
  shouldNotifyRoles,
  MOD_PING_COOLDOWN_MS,
  type MentionableRole,
  DEFAULT_MOD_ROLES,
} from '../mod-roles.js';

const MOD = '1436055845392879778'; // 🚓Moderación🚓 — mentionable in the live guild
const ADMIN = '1436259908222713917'; // ⭐Administrador⭐ — mentionable
const TECH = '1517610228969902130'; // Técnico — NOT mentionable
const MEMBER = '111111111111111111';

const guild: MentionableRole[] = [
  { id: MEMBER, name: 'Miembro', mentionable: true },
  { id: ADMIN, name: '⭐Administrador⭐', mentionable: true },
  { id: MOD, name: '🚓Moderación🚓', mentionable: true },
  { id: TECH, name: 'Técnico', mentionable: false },
];

describe('resolveModMentions', () => {
  test('mentions the default approver roles, skipping the ones Discord will not notify', () => {
    const r = resolveModMentions(guild, [], { canMentionAny: false });
    expect(r.notifyIds).toEqual([ADMIN, MOD]);
    expect(r.text).toBe(`<@&${ADMIN}> <@&${MOD}>`);
    expect(r.notifies).toBe(true);
    // Técnico is an approver but unmentionable → surfaced, never rendered as a chip.
    expect(r.silent.map((x) => x.name)).toEqual(['Técnico']);
    expect(r.text).not.toContain(TECH);
    // and a plain member is never in the ping
    expect(r.notifyIds).not.toContain(MEMBER);
  });

  test('MentionEveryone lets the bot ping unmentionable approver roles too', () => {
    const r = resolveModMentions(guild, [], { canMentionAny: true });
    expect(r.notifyIds).toEqual([ADMIN, MOD, TECH]);
    expect(r.silent).toEqual([]);
  });

  test('falls back to naming the roles in plain text when none can be notified', () => {
    const locked = guild.map((r) => ({ ...r, mentionable: false }));
    const r = resolveModMentions(locked, [], { canMentionAny: false });
    expect(r.notifies).toBe(false);
    expect(r.notifyIds).toEqual([]);
    expect(r.text).not.toContain('<@&'); // no chip that pings nobody
    expect(r.text).toContain('Administrador');
    expect(r.silent).toHaveLength(r.matched.length);
  });

  test('configured role NAMES resolve accent/case-insensitively', () => {
    const r = resolveModMentions(guild, ['moderacion'], { canMentionAny: false });
    expect(r.notifyIds).toEqual([MOD]);
  });

  test('no approver role present in the guild → nothing to mention', () => {
    const r = resolveModMentions([{ id: MEMBER, name: 'Miembro', mentionable: true }], [], {
      canMentionAny: false,
    });
    expect(r).toMatchObject({ notifyIds: [], text: '', notifies: false, matched: [] });
  });

  test('the pinged roles are exactly the roles that may approve (same matcher)', () => {
    // every default token that exists in the guild shows up as matched
    const r = resolveModMentions(guild, [], { canMentionAny: true });
    const matchedIds = r.matched.map((x) => x.id);
    for (const id of DEFAULT_MOD_ROLES) {
      if (guild.some((g) => g.id === id)) expect(matchedIds).toContain(id);
    }
  });
});

describe('sanitizeRoleMentions', () => {
  test('drops role mentions the model invented, keeps the allowed ones', () => {
    const out = sanitizeRoleMentions(`hola <@&999999999999999999> y <@&${MOD}> ya`, [MOD]);
    expect(out).not.toContain('999999999999999999');
    expect(out).toContain(`<@&${MOD}>`);
  });

  test('leaves user mentions and ordinary text untouched', () => {
    const text = 'gracias <@187289179871248384>, va el martes 11';
    expect(sanitizeRoleMentions(text, [MOD])).toBe(text);
  });
});

describe('appendModPing', () => {
  const mentions = resolveModMentions(guild, [], { canMentionAny: false });

  test('appends the ping so the proposal never depends on the model', () => {
    const out = appendModPing('Propuesta lista.', mentions);
    expect(out).toContain(`<@&${ADMIN}>`);
    expect(out).toContain(`<@&${MOD}>`);
    expect(out.startsWith('Propuesta lista.')).toBe(true);
  });

  test('does not double-ping when the text already mentions an approver role', () => {
    const out = appendModPing(`ojo <@&${MOD}>`, mentions);
    expect(out).toBe(`ojo <@&${MOD}>`);
  });

  test('with nothing mentionable it still names who approves, without a chip', () => {
    const locked = resolveModMentions(
      guild.map((r) => ({ ...r, mentionable: false })),
      [],
      { canMentionAny: false },
    );
    const out = appendModPing('Propuesta lista.', locked);
    expect(out).toContain('Administrador');
    expect(out).not.toContain('<@&');
  });

  test('no approver roles at all → message unchanged', () => {
    const none = resolveModMentions([], [], { canMentionAny: false });
    expect(appendModPing('Propuesta lista.', none)).toBe('Propuesta lista.');
  });

  test('the approval notice is a distinct tail from the pending-approval one', () => {
    const created = appendModPing('Listo, quedó el martes 11 a las 8pm.', mentions, 'created');
    expect(created).toContain(`<@&${MOD}>`);
    expect(created).toContain('agendado');
    expect(created).not.toContain('pendiente');
    expect(appendModPing('Propuesta.', mentions, 'proposal')).toContain('pendiente');
  });
});

describe('hasRoleMention / mentionedRoleIds', () => {
  test('detects only the ids asked about', () => {
    expect(hasRoleMention(`x <@&${MOD}>`, [MOD])).toBe(true);
    expect(hasRoleMention(`x <@&${MOD}>`, [ADMIN])).toBe(false);
    expect(hasRoleMention('sin menciones', [MOD])).toBe(false);
    expect(mentionedRoleIds(`<@&${MOD}> y <@&${ADMIN}>`, [ADMIN, MOD])).toEqual([ADMIN, MOD]);
    expect(mentionedRoleIds('nada', [MOD])).toEqual([]);
  });
});

describe('shouldNotifyRoles', () => {
  test('first ping in a ticket always notifies', () => {
    expect(shouldNotifyRoles(undefined, 1_000)).toBe(true);
  });

  test('re-pings are suppressed inside the cooldown and allowed after it', () => {
    const t0 = 1_000_000;
    expect(shouldNotifyRoles(t0, t0 + MOD_PING_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldNotifyRoles(t0, t0 + MOD_PING_COOLDOWN_MS)).toBe(true);
  });
});
