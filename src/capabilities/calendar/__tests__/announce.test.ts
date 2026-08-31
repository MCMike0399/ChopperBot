import { describe, test, expect } from 'vitest';
import {
  announceKey,
  announceNonce,
  announcementsDue,
  appendEventLink,
  MAX_NONCE_LENGTH,
  nudgeKey,
  nudgesDue,
  prefixMentions,
  publicEventDescription,
  renderAnnounceMentions,
  renderAnnouncementPrompt,
  renderFallbackAnnouncement,
  type AnnounceTarget,
} from '../announce.js';
import type { MatchableOccurrence } from '../match.js';

/** Local wall-clock helper: CDMX is a fixed UTC-6. */
const local = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h + 6, min);

const AUG5_8PM = local(2026, 8, 5, 20);
const AUG5_10AM = local(2026, 8, 5, 10);
const AUG5_9AM = local(2026, 8, 5, 9);
const AUG5_1PM = local(2026, 8, 5, 13);

function occ(over: Partial<MatchableOccurrence> = {}): MatchableOccurrence {
  return {
    id: 21,
    title: 'Rosario Castellanos | Club de poesía',
    description: null,
    location: null,
    startAtMs: AUG5_8PM,
    ...over,
  };
}

const never = () => false;

describe('announcementsDue', () => {
  test('stays quiet before the announce hour', () => {
    expect(announcementsDue({ occurrences: [occ()], nowMs: AUG5_9AM, isAnnounced: never })).toEqual([]);
  });

  test('announces today\'s event once the window opens', () => {
    const due = announcementsDue({ occurrences: [occ()], nowMs: AUG5_10AM, isAnnounced: never });
    expect(due.map((o) => o.id)).toEqual([21]);
  });

  test('still announces on a late boot — the window stays open until the event', () => {
    // A restart at 1pm must not lose the morning's announcement; the ledger, not
    // the clock, is what makes it happen only once.
    expect(announcementsDue({ occurrences: [occ()], nowMs: AUG5_1PM, isAnnounced: never })).toHaveLength(1);
  });

  test('never announces an event that already started', () => {
    const nowMs = local(2026, 8, 5, 20, 40);
    expect(announcementsDue({ occurrences: [occ()], nowMs, isAnnounced: never })).toEqual([]);
  });

  test('ignores events on other days, including tomorrow', () => {
    const tomorrow = occ({ id: 22, startAtMs: local(2026, 8, 6, 20) });
    const yesterday = occ({ id: 20, startAtMs: local(2026, 8, 4, 20) });
    const due = announcementsDue({
      occurrences: [tomorrow, yesterday, occ()],
      nowMs: AUG5_10AM,
      isAnnounced: never,
    });
    expect(due.map((o) => o.id)).toEqual([21]);
  });

  test('skips what the ledger already recorded (restart / next tick)', () => {
    const seen = new Set([announceKey(21, AUG5_8PM)]);
    expect(
      announcementsDue({ occurrences: [occ()], nowMs: AUG5_10AM, isAnnounced: (k) => seen.has(k) }),
    ).toEqual([]);
  });

  test('a rescheduled occurrence is a new thing to announce', () => {
    const seen = new Set([announceKey(21, AUG5_8PM)]);
    const moved = occ({ startAtMs: local(2026, 8, 5, 21) });
    expect(
      announcementsDue({ occurrences: [moved], nowMs: AUG5_10AM, isAnnounced: (k) => seen.has(k) }),
    ).toHaveLength(1);
  });

  test('orders several same-day events by start time', () => {
    const late = occ({ id: 30, startAtMs: local(2026, 8, 5, 21) });
    const early = occ({ id: 29, startAtMs: local(2026, 8, 5, 18) });
    const due = announcementsDue({ occurrences: [late, early], nowMs: AUG5_10AM, isAnnounced: never });
    expect(due.map((o) => o.id)).toEqual([29, 30]);
  });
});

describe('nudgesDue', () => {
  const target = (o: MatchableOccurrence, linked: boolean): AnnounceTarget => ({
    occurrence: o,
    discordEvent: linked ? { id: 'D1', name: o.title, description: null, startAtMs: o.startAtMs } : null,
    discordEventUrl: linked ? 'https://discord.com/events/G/D1' : null,
  });

  test('nudges for today and tomorrow when the Discord event is missing', () => {
    const today = target(occ(), false);
    const tomorrow = target(occ({ id: 22, startAtMs: local(2026, 8, 6, 20) }), false);
    const out = nudgesDue({ targets: [today, tomorrow], nowMs: AUG5_10AM, isAnnounced: never });
    expect(out.map((t) => t.occurrence.id)).toEqual([21, 22]);
  });

  test('says nothing about events that already have a Discord event', () => {
    expect(nudgesDue({ targets: [target(occ(), true)], nowMs: AUG5_10AM, isAnnounced: never })).toEqual([]);
  });

  test('does not nudge about events that already passed', () => {
    const past = target(occ({ startAtMs: local(2026, 8, 5, 8) }), false);
    expect(nudgesDue({ targets: [past], nowMs: AUG5_10AM, isAnnounced: never })).toEqual([]);
  });

  test('nudges once per occurrence, not once per tick', () => {
    const seen = new Set([nudgeKey(21, AUG5_8PM)]);
    expect(
      nudgesDue({ targets: [target(occ(), false)], nowMs: AUG5_10AM, isAnnounced: (k) => seen.has(k) }),
    ).toEqual([]);
  });

  test('stays quiet when a plausible Discord event exists but is unconfirmed', () => {
    // `maybeLinked` is set for an ambiguous match we didn't spend a model call
    // on. Nagging mods about an event that probably already exists is worse than
    // saying nothing; the announcement pass resolves it properly on the day.
    const unsure: AnnounceTarget = { ...target(occ(), false), maybeLinked: true };
    expect(nudgesDue({ targets: [unsure], nowMs: AUG5_10AM, isAnnounced: never })).toEqual([]);
  });
});

describe('renderAnnounceMentions', () => {
  test('turns role ids into chips and keeps them for allowedMentions', () => {
    const m = renderAnnounceMentions(['1436225305898389604']);
    expect(m.text).toBe('<@&1436225305898389604>');
    expect(m.roleIds).toEqual(['1436225305898389604']);
    expect(m.everyone).toBe(false);
  });

  test('supports the everyone token explicitly', () => {
    const m = renderAnnounceMentions(['everyone', '1436225305898389604']);
    expect(m.everyone).toBe(true);
    expect(m.text).toContain('@everyone');
    expect(m.roleIds).toEqual(['1436225305898389604']);
  });

  test('drops junk tokens rather than posting a broken mention', () => {
    const m = renderAnnounceMentions(['', 'Usuarix', '  ']);
    expect(m).toEqual({ text: '', roleIds: [], everyone: false });
  });
});

describe('message assembly', () => {
  const target: AnnounceTarget = {
    occurrence: occ({ location: 'Sala de Eventos', description: 'Ponente: Burbuja' }),
    discordEvent: null,
    discordEventUrl: 'https://discord.com/events/G/D1',
  };

  test('the fallback names the day and hour, place and details', () => {
    const text = renderFallbackAnnouncement(target);
    expect(text).toMatch(/Hoy a las 8:00 PM/);
    expect(text).toContain('Sala de Eventos');
    expect(text).toContain('Ponente: Burbuja');
  });

  test('the fallback drops Agitprop/flyer credits from the public details', () => {
    const text = renderFallbackAnnouncement({
      ...target,
      occurrence: occ({
        description:
          'Ponente: Mermelada. 🎨 Flyer a cargo de la Comisión de Agitprop.',
      }),
    });
    expect(text).toContain('Ponente: Mermelada');
    expect(text).not.toMatch(/Agitprop/i);
  });

  test('the event link is appended, once', () => {
    const once = appendEventLink('texto', target.discordEventUrl);
    expect(once).toContain(target.discordEventUrl!);
    expect(appendEventLink(once, target.discordEventUrl)).toBe(once);
  });

  test('no link means no trailing noise', () => {
    expect(appendEventLink('texto', null)).toBe('texto');
  });

  test('mentions go on top, and nothing is prefixed when there are none', () => {
    expect(prefixMentions('cuerpo', '@everyone')).toBe('@everyone\n\ncuerpo');
    expect(prefixMentions('cuerpo', '')).toBe('cuerpo');
  });
});

describe('renderAnnouncementPrompt', () => {
  test('forbids the model from writing mentions or links (both are appended)', () => {
    const p = renderAnnouncementPrompt(
      { occurrence: occ(), discordEvent: null, discordEventUrl: null },
      AUG5_10AM,
    );
    expect(p).toMatch(/NO escribas menciones/);
    expect(p).toMatch(/NO escribas ningún enlace/);
    expect(p).toMatch(/8:00 PM/);
  });

  test('tells the model not to invent a place when there is none', () => {
    const p = renderAnnouncementPrompt(
      { occurrence: occ({ location: null }), discordEvent: null, discordEventUrl: null },
      AUG5_10AM,
    );
    expect(p).toMatch(/no lo inventes/);
  });

  test('advance framing is an upcoming-event notice that must never say "today"', () => {
    const p = renderAnnouncementPrompt(
      { occurrence: occ(), discordEvent: null, discordEventUrl: null },
      AUG5_10AM,
      'advance',
    );
    expect(p).toMatch(/aviso anticipado/);
    expect(p).toMatch(/nunca digas ni insinúes que es hoy/);
    expect(p).toMatch(/8:00 PM/);
    // The same-day rules survive: no mentions, no links from the model.
    expect(p).toMatch(/NO escribas menciones/);
    expect(p).toMatch(/NO escribas ningún enlace/);
  });

  test('default framing stays the same-day announcement', () => {
    const p = renderAnnouncementPrompt(
      { occurrence: occ(), discordEvent: null, discordEventUrl: null },
      AUG5_10AM,
    );
    expect(p).toMatch(/anuncio del día/);
    expect(p).toMatch(/ocurre HOY/);
  });
});

describe('publicEventDescription', () => {
  test('keeps speaker and topic, drops the Agitprop credit', () => {
    // The live #37 description that leaked onto the Discord event card.
    expect(
      publicEventDescription(
        'Ponente: Mermelada. Plática sobre la vivencia neurodivergente y el capacitismo. 🎨 Flyer a cargo de la Comisión de Agitprop.',
      ),
    ).toBe(
      'Ponente: Mermelada. Plática sobre la vivencia neurodivergente y el capacitismo.',
    );
  });

  test('drops "Flyer: hará el solicitante" the same way', () => {
    expect(
      publicEventDescription('Ponentes: Abeja y Luna. Flyer: hará el solicitante.'),
    ).toBe('Ponentes: Abeja y Luna.');
  });

  test('null/empty stays null', () => {
    expect(publicEventDescription(null)).toBeNull();
    expect(publicEventDescription('')).toBeNull();
    expect(publicEventDescription('🎨 Flyer a cargo de la Comisión de Agitprop.')).toBeNull();
  });
});

/**
 * The nonce is what makes the create idempotent, so Discord's 25-character cap
 * is a correctness boundary, not a style note: an over-long nonce is rejected
 * and the announcement falls back to being duplicable again.
 */
describe('announceNonce', () => {
  test('is stable for the same occurrence, so a retry is recognised as one', () => {
    expect(announceNonce(21, AUG5_8PM)).toBe(announceNonce(21, AUG5_8PM));
  });

  test('separates different events and different occurrences of one series', () => {
    expect(announceNonce(21, AUG5_8PM)).not.toBe(announceNonce(22, AUG5_8PM));
    expect(announceNonce(21, AUG5_8PM)).not.toBe(announceNonce(21, AUG5_8PM + 86_400_000));
  });

  test('a salted repost is a different message on purpose', () => {
    expect(announceNonce(21, AUG5_8PM, AUG5_10AM)).not.toBe(announceNonce(21, AUG5_8PM));
  });

  test('stays inside Discord’s 25-character limit, salted or not', () => {
    // Far past any id or date this bot will see, salted included.
    const cases: Array<[number, number, number | undefined]> = [
      [1, AUG5_8PM, undefined],
      [21, AUG5_8PM, AUG5_10AM],
      [999_999_999, Date.UTC(2999, 11, 31), Date.UTC(2999, 11, 31)],
    ];
    for (const [id, start, salt] of cases) {
      expect(announceNonce(id, start, salt).length).toBeLessThanOrEqual(MAX_NONCE_LENGTH);
    }
  });
});
