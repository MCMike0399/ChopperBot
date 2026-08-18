/**
 * The channel matcher for on-demand announcements: the mod's words → a channel
 * we may actually post in.
 *
 * The names here are the real, emoji-decorated shape of this guild's channels,
 * because that decoration is exactly what a naive match breaks on ("general"
 * must find "💬│general-revz"). The other half is the distinction between "no
 * such channel" and "I can't write there" — those need opposite answers from
 * the mod, and collapsing them produces the worst reply available: telling a mod
 * a channel they can see doesn't exist.
 */
import { describe, test, expect } from 'vitest';
import { resolveOne, type CandidateChannel } from '../broadcast-channels.js';

const CHANNELS: CandidateChannel[] = [
  { id: '100000000000000001', name: '📣│anuncios', kind: 'text', sendable: true },
  { id: '100000000000000002', name: '💬│general-revz', kind: 'text', sendable: true },
  { id: '100000000000000003', name: '📅│eventos', kind: 'text', sendable: true },
  // Forums, like the real thing: this guild runs its activity spaces as forum
  // channels, which is why the live "foro poesia" ask came back unresolved
  // before forums were postable at all.
  { id: '100000000000000004', name: '🖋│foro-poesía', kind: 'forum', sendable: true },
  { id: '100000000000000005', name: '🎬│foro-cine', kind: 'forum', sendable: true },
  { id: '100000000000000006', name: '🔒│staff-only', kind: 'text', sendable: false },
];

describe('resolveOne', () => {
  test('an id and a <#id> mention win outright', () => {
    expect(resolveOne(CHANNELS, '100000000000000003')).toMatchObject({
      reason: 'ok',
      match: { name: '📅│eventos' },
    });
    expect(resolveOne(CHANNELS, '<#100000000000000003>')).toMatchObject({ reason: 'ok' });
  });

  test('a plain word matches through emoji/pipe decoration', () => {
    expect(resolveOne(CHANNELS, 'eventos').match?.name).toBe('📅│eventos');
    expect(resolveOne(CHANNELS, 'general').match?.name).toBe('💬│general-revz');
    expect(resolveOne(CHANNELS, 'anuncios').match?.name).toBe('📣│anuncios');
  });

  test('accents and casing do not matter — the live "foro poesia" case', () => {
    expect(resolveOne(CHANNELS, 'foro poesia').match?.name).toBe('🖋│foro-poesía');
    expect(resolveOne(CHANNELS, 'Foro Poesía').match?.name).toBe('🖋│foro-poesía');
  });

  test('a forum resolves, and carries its kind so the send opens a post', () => {
    // The live failure this covers: the mod said "anuncialo … y foro poesia" and
    // got "no encontré ningún canal con ese nombre", because a forum takes no
    // plain messages and so was left out of the candidate list entirely.
    expect(resolveOne(CHANNELS, 'foro poesia')).toMatchObject({
      reason: 'ok',
      match: { id: '100000000000000004', kind: 'forum' },
    });
    expect(resolveOne(CHANNELS, 'eventos').match?.kind).toBe('text');
  });

  test('a word matching several channels is ambiguous, not a coin flip', () => {
    const res = resolveOne(CHANNELS, 'foro');
    expect(res.reason).toBe('ambiguous');
    expect(res.match).toBeNull();
    expect(res.candidates.map((c) => c.name).sort()).toEqual(['🎬│foro-cine', '🖋│foro-poesía']);
  });

  test('an unknown word is unknown (no candidates to offer)', () => {
    expect(resolveOne(CHANNELS, 'zzz-no-existe')).toMatchObject({ reason: 'unknown', candidates: [] });
  });

  test('a channel the bot cannot write in is not_sendable, never unknown', () => {
    const res = resolveOne(CHANNELS, 'staff-only');
    expect(res.reason).toBe('not_sendable');
    expect(res.match).toBeNull();
    expect(res.candidates.map((c) => c.name)).toEqual(['🔒│staff-only']);
  });

  test('an unwritable channel named by id is also not_sendable', () => {
    expect(resolveOne(CHANNELS, '<#100000000000000006>').reason).toBe('not_sendable');
  });

  test('an unwritable channel is never returned as a target', () => {
    for (const query of ['staff-only', 'staff', '100000000000000006']) {
      expect(resolveOne(CHANNELS, query).match).toBeNull();
    }
  });

  test('an empty or punctuation-only query resolves to unknown, not to everything', () => {
    expect(resolveOne(CHANNELS, '   ').reason).toBe('unknown');
    expect(resolveOne(CHANNELS, '###').reason).toBe('unknown');
  });

  test('the mod naming a channel more verbosely than it is still lands', () => {
    // "el canal de eventos" contains the channel's own significant name.
    expect(resolveOne(CHANNELS, 'eventos').match?.name).toBe('📅│eventos');
    expect(
      resolveOne([{ id: '1', name: 'eventos', kind: 'text', sendable: true }], 'eventos').match?.id,
    ).toBe('1');
  });

  test('an empty guild resolves everything to unknown rather than throwing', () => {
    expect(resolveOne([], 'general')).toEqual({
      query: 'general',
      reason: 'unknown',
      match: null,
      candidates: [],
    });
  });
});
