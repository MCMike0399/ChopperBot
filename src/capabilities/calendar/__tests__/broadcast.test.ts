/**
 * The pure half of on-demand announcements: channel partitioning, the mention
 * policy, mention stripping, message composition, timing and the token.
 *
 * These are the decisions that can embarrass the community in front of itself —
 * posting where nobody asked, pinging who nobody authorized, or posting text
 * nobody approved — so they live outside Discord and are pinned here.
 */
import { describe, test, expect } from 'vitest';
import {
  broadcastNonce,
  broadcastTiming,
  composeBroadcast,
  DRAFT_TTL_MS,
  forumPostTitle,
  isDraftExpired,
  LATE_BROADCAST_GRACE_MS,
  newDraftToken,
  NO_MENTIONS,
  partitionResolutions,
  renderBroadcastMentions,
  renderBroadcastPrompt,
  resolveBroadcastMentions,
  stripModelMentions,
  type ChannelResolution,
} from '../broadcast.js';
import type { AnnounceTarget } from '../announce.js';

const ROLE = '1436225305898389604'; // the live Usuarix role
const OTHER_ROLE = '1483734077944365149';

function ok(query: string, id: string, name: string): ChannelResolution {
  return { query, reason: 'ok', match: { id, name, kind: 'text' }, candidates: [] };
}

describe('partitionResolutions', () => {
  test('keeps the mod order and drops a channel named twice', () => {
    const { resolved, problems } = partitionResolutions([
      ok('eventos', '1', 'eventos'),
      ok('general', '2', 'general'),
      ok('#eventos', '1', 'eventos'),
    ]);
    expect(resolved.map((c) => c.id)).toEqual(['1', '2']);
    expect(problems).toHaveLength(0);
  });

  test('separates ambiguous / unknown / unwritable from the targets', () => {
    const { resolved, problems } = partitionResolutions([
      ok('general', '2', 'general'),
      { query: 'foro', reason: 'ambiguous', match: null, candidates: [{ id: '9', name: 'foro-poesia', kind: 'forum' }] },
      { query: 'nolotengo', reason: 'unknown', match: null, candidates: [] },
      { query: 'staff', reason: 'not_sendable', match: null, candidates: [{ id: '7', name: 'staff', kind: 'text' }] },
    ]);
    expect(resolved.map((c) => c.name)).toEqual(['general']);
    expect(problems.map((p) => p.reason)).toEqual(['ambiguous', 'unknown', 'not_sendable']);
  });

  test('a resolution flagged not-ok is never a target even if it carries a match', () => {
    // Defense in depth: `reason` is the authority, not the presence of `match`.
    const { resolved } = partitionResolutions([
      { query: 'staff', reason: 'not_sendable', match: { id: '7', name: 'staff', kind: 'text' }, candidates: [] },
    ]);
    expect(resolved).toEqual([]);
  });
});

describe('resolveBroadcastMentions', () => {
  test('defaults to pinging nobody', () => {
    expect(resolveBroadcastMentions([], [ROLE]).mentions).toEqual(NO_MENTIONS);
  });

  test('honours an allowed role, accepting a <@&id> spelling', () => {
    const { mentions, rejected } = resolveBroadcastMentions([`<@&${ROLE}>`], [ROLE]);
    expect(mentions).toEqual({ roleIds: [ROLE], everyone: false });
    expect(rejected).toEqual([]);
  });

  test('refuses a role outside the configured announce mentions', () => {
    const { mentions, rejected } = resolveBroadcastMentions([OTHER_ROLE], [ROLE]);
    expect(mentions.roleIds).toEqual([]);
    expect(rejected).toEqual([`<@&${OTHER_ROLE}>`]);
  });

  test('@everyone only fires when it was actually configured', () => {
    expect(resolveBroadcastMentions(['everyone'], [ROLE]).mentions.everyone).toBe(false);
    expect(resolveBroadcastMentions(['everyone'], [ROLE]).rejected).toEqual(['@everyone']);
    expect(resolveBroadcastMentions(['everyone'], ['everyone']).mentions.everyone).toBe(true);
  });

  test('@here is refused unless everyone is configured (it is not its own token)', () => {
    expect(resolveBroadcastMentions(['@here'], [ROLE]).rejected).toEqual(['@everyone']);
  });

  test('deduplicates and rejects junk tokens', () => {
    const { mentions, rejected } = resolveBroadcastMentions([ROLE, ROLE, 'moderación'], [ROLE]);
    expect(mentions.roleIds).toEqual([ROLE]);
    expect(rejected).toEqual(['moderación']);
  });
});

describe('stripModelMentions', () => {
  test('removes role mentions and neutralizes @everyone / @here', () => {
    const out = stripModelMentions('Banda <@&123456789012345678> @everyone hoy @here nos vemos');
    expect(out).not.toMatch(/<@&/);
    expect(out).not.toMatch(/@everyone/i);
    expect(out).not.toMatch(/@here/i);
    expect(out).toContain('todxs');
    expect(out).toContain('por aquí');
  });

  test('leaves ordinary text alone', () => {
    const text = 'Bandaaaa, mañana a las 8pm hay Círculo de poemas propios 💚';
    expect(stripModelMentions(text)).toBe(text);
  });
});

describe('composeBroadcast', () => {
  const url = 'https://discord.com/events/1/2';

  test('appends the event link and prefixes nothing when silent', () => {
    const out = composeBroadcast({ body: 'Hoy hay poesía', mentions: NO_MENTIONS, eventUrl: url });
    expect(out).toBe(`Hoy hay poesía\n\n${url}`);
  });

  test('prefixes the mention line above the body', () => {
    const out = composeBroadcast({
      body: 'Hoy hay poesía',
      mentions: { roleIds: [ROLE], everyone: false },
      eventUrl: null,
    });
    expect(out.startsWith(`<@&${ROLE}>\n\n`)).toBe(true);
  });

  test('never duplicates a link the model already wrote', () => {
    const out = composeBroadcast({ body: `Vengan ${url}`, mentions: NO_MENTIONS, eventUrl: url });
    expect(out.match(new RegExp(url.replace(/[/.]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  test('a model-written @everyone cannot survive into the posted text', () => {
    const out = composeBroadcast({
      body: '@everyone hoy hay asamblea',
      mentions: NO_MENTIONS,
      eventUrl: null,
    });
    expect(out).not.toMatch(/@everyone/i);
  });

  test('the only @everyone possible is the resolved prefix', () => {
    const out = composeBroadcast({
      body: 'hoy hay asamblea',
      mentions: { roleIds: [], everyone: true },
      eventUrl: null,
    });
    expect(out.startsWith('@everyone\n\n')).toBe(true);
    expect(out.match(/@everyone/g)).toHaveLength(1);
  });
});

describe('renderBroadcastMentions', () => {
  test('everyone comes first, then roles', () => {
    expect(renderBroadcastMentions({ roleIds: [ROLE], everyone: true })).toBe(`@everyone <@&${ROLE}>`);
    expect(renderBroadcastMentions(NO_MENTIONS)).toBe('');
  });
});

describe('broadcastTiming', () => {
  const eightPm = Date.parse('2026-08-19T02:00:00Z'); // Aug 18, 8:00 PM CDMX

  test('same local day reads as today', () => {
    expect(broadcastTiming(eightPm, Date.parse('2026-08-18T20:00:00Z'))).toEqual({
      kind: 'today',
      ok: true,
    });
  });

  test('a future day reads as advance — the live case (announced the day before)', () => {
    expect(broadcastTiming(eightPm, Date.parse('2026-08-18T00:00:00Z')).kind).toBe('advance');
  });

  test('an event just started is still announceable inside the grace window', () => {
    const res = broadcastTiming(eightPm, eightPm + LATE_BROADCAST_GRACE_MS - 60_000);
    expect(res).toEqual({ kind: 'today', ok: true });
  });

  test('well after the start it is refused, not posted wrong', () => {
    const res = broadcastTiming(eightPm, eightPm + LATE_BROADCAST_GRACE_MS + 60_000);
    expect(res).toEqual({ kind: 'started', ok: false });
  });
});

describe('forumPostTitle', () => {
  const eightPm = Date.parse('2026-08-19T02:00:00Z'); // Aug 18, 8:00 PM CDMX

  test('carries the event on its own — a forum lists titles, not bodies', () => {
    const title = forumPostTitle('Poesía propia: Club de poesía abierto', eightPm);
    expect(title).toContain('Poesía propia: Club de poesía abierto');
    expect(title).toMatch(/8:00 PM/);
    expect(title).toMatch(/18/);
  });

  test('stays inside Discord\'s 100-char limit, cutting on a word', () => {
    const long = 'Círculo de poemas propios para desempolvar libretas y compartir versos con la banda entera';
    const title = forumPostTitle(long, eightPm);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toContain('…');
    // Truncated mid-word would read as a typo in a channel listing.
    expect(title.split('…')[0]).toBe(title.split('…')[0]!.trimEnd());
  });

  test('a title that is only whitespace still produces something postable', () => {
    expect(forumPostTitle('   ', eightPm).startsWith('Evento —')).toBe(true);
  });

  test('is deterministic, so the confirmed draft and the created post agree', () => {
    expect(forumPostTitle('Club de poesía', eightPm)).toBe(forumPostTitle('Club de poesía', eightPm));
  });
});

describe('draft token + nonce', () => {
  test('the nonce is stable per (token, channel) and inside Discord\'s 25-char cap', () => {
    const a = broadcastNonce('abc12345', '1483675563871961248');
    expect(a).toBe(broadcastNonce('abc12345', '1483675563871961248'));
    expect(a.length).toBeLessThanOrEqual(25);
  });

  test('different channels of one fan-out get different nonces', () => {
    expect(broadcastNonce('abc12345', '111111111111111111')).not.toBe(
      broadcastNonce('abc12345', '222222222222222222'),
    );
  });

  test('a redraft gets a different nonce, so it is not swallowed as a duplicate', () => {
    expect(broadcastNonce('aaaaaaaa', '111111111111111111')).not.toBe(
      broadcastNonce('bbbbbbbb', '111111111111111111'),
    );
  });

  test('tokens are 8 chars and do not collide across draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newDraftToken();
      expect(t).toHaveLength(8);
      seen.add(t);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  test('a stuck RNG still yields a full-length token', () => {
    expect(newDraftToken(() => 0)).toHaveLength(8);
  });
});

describe('draft expiry', () => {
  test('fresh drafts are live, stale ones are not', () => {
    const created = Date.parse('2026-08-18T20:00:00Z');
    expect(isDraftExpired(created, created + 60_000)).toBe(false);
    expect(isDraftExpired(created, created + DRAFT_TTL_MS + 1)).toBe(true);
  });
});

describe('renderBroadcastPrompt', () => {
  const target: AnnounceTarget = {
    occurrence: {
      id: 38,
      title: 'Poesía propia: Club de poesía abierto',
      description: null,
      location: null,
      startAtMs: Date.parse('2026-08-20T02:00:00Z'), // Aug 19, 8:00 PM CDMX
    },
    discordEvent: null,
    discordEventUrl: null,
  };

  test("carries the mod's own instruction verbatim — the reason they asked at all", () => {
    const prompt = renderBroadcastPrompt({
      target,
      nowMs: Date.parse('2026-08-18T20:00:00Z'),
      instruction: 'que diga bandaaaa, para q desempolven sus libretas',
      channelNames: ['eventos', 'general', 'foro-poesia'],
      timing: 'advance',
    });
    expect(prompt).toContain('que diga bandaaaa, para q desempolven sus libretas');
    expect(prompt).toContain('#eventos');
    expect(prompt).toContain('#foro-poesia');
  });

  test('an advance announcement is forbidden from saying "hoy"', () => {
    const prompt = renderBroadcastPrompt({
      target,
      nowMs: Date.parse('2026-08-18T20:00:00Z'),
      instruction: null,
      channelNames: ['general'],
      timing: 'advance',
    });
    expect(prompt).toMatch(/nunca digas ni insinúes que es hoy/i);
  });

  test('a same-day announcement says HOY', () => {
    const prompt = renderBroadcastPrompt({
      target,
      nowMs: Date.parse('2026-08-19T20:00:00Z'),
      instruction: null,
      channelNames: ['general'],
      timing: 'today',
    });
    expect(prompt).toMatch(/\*\*HOY\*\*/);
  });

  test('forbids the model from writing mentions or links (both are added deterministically)', () => {
    const prompt = renderBroadcastPrompt({
      target,
      nowMs: Date.now(),
      instruction: null,
      channelNames: [],
      timing: 'advance',
    });
    expect(prompt).toMatch(/NO escribas menciones/);
    expect(prompt).toMatch(/NO escribas ningún enlace/);
  });

  test('never invents a location it does not have', () => {
    const prompt = renderBroadcastPrompt({
      target,
      nowMs: Date.now(),
      instruction: null,
      channelNames: [],
      timing: 'advance',
    });
    expect(prompt).toMatch(/no lo inventes/);
  });
});
