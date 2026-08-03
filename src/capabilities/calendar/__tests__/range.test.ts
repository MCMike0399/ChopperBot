/**
 * Bounded recurring series ("cada martes, 4 veces") and the shape of the
 * published month board.
 *
 * Motivation for both, from the live journal (2026-07-10): a mod booked a weekly
 * book club by creating FOUR separate one-off rows (Jul 7/14/21/28) because the
 * tools only offered "weekly → forever", and every one-off month key then pinned
 * a permanent card to the output channel. `recurrence_count` gives that shape one
 * row, and `desiredMonthKeys` keeps the board to the current + future months.
 */
import { describe, test, expect } from 'vitest';
import {
  countOccurrencesUntil,
  step,
  untilFromCount,
  MAX_RECURRENCE_COUNT,
} from '../recurrence.js';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import { desiredMonthKeys, monthPublishAction, type MonthCardEvent } from '../publisher.js';

const WEEK = 7 * 86_400_000;
// Tue Jul 7 2026, 20:00 CDMX = 2026-07-08T02:00:00Z — the real book-club anchor.
const S = Date.parse('2026-07-08T02:00:00Z');
const NOW = Date.parse('2026-07-06T18:00:00Z');

async function ctx() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  const s = new CalendarStore(memory.db());
  return { memory, s, src: new CalendarToolSource(s, 'MOD', NOW) }; // no publisher
}

/** The `event` object out of a successful create/update payload. */
function ev(res: { status: string; payload: unknown }) {
  return (res.payload as { event: Record<string, unknown> }).event;
}

describe('untilFromCount / countOccurrencesUntil', () => {
  test('count → the anchor of the LAST occurrence', () => {
    expect(untilFromCount(S, 'weekly', 1)).toBe(S);
    expect(untilFromCount(S, 'weekly', 4)).toBe(S + 3 * WEEK);
    expect(untilFromCount(S, 'daily', 3)).toBe(S + 2 * 86_400_000);
  });

  test('monthly count clamps short months instead of drifting', () => {
    // Jan 31 + 1 month = Feb 28, not Mar 3 (calendar-aware stepping).
    const jan31 = Date.parse('2027-01-31T20:00:00Z');
    expect(untilFromCount(jan31, 'monthly', 2)).toBe(step(jan31, 'monthly', 1));
    expect(new Date(untilFromCount(jan31, 'monthly', 2)).toISOString()).toContain('2027-02-28');
  });

  test('count and until are inverses', () => {
    for (const n of [1, 2, 5, 12]) {
      expect(countOccurrencesUntil(S, 'weekly', untilFromCount(S, 'weekly', n))).toBe(n);
    }
  });

  test('open-ended series has no count', () => {
    expect(countOccurrencesUntil(S, 'weekly', null)).toBeNull();
  });

  test('a cutoff mid-gap does not add a phantom occurrence', () => {
    // Cutoff 1ms before the 3rd anchor → still only 2 occurrences.
    expect(countOccurrencesUntil(S, 'weekly', S + 2 * WEEK - 1)).toBe(2);
    expect(countOccurrencesUntil(S, 'weekly', S + 2 * WEEK)).toBe(3);
  });

  test('a cutoff before the start yields zero', () => {
    expect(countOccurrencesUntil(S, 'weekly', S - 1)).toBe(0);
  });
});

describe('calendar_create_event with a bounded range', () => {
  test('recurrence_count creates ONE row covering exactly N occurrences', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Círculo de lectura: Raíz que no desaparece',
      start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly',
      recurrence_count: 4,
    });
    expect(res.status).toBe('success');

    // ONE master row — this is the regression the four hand-made rows motivated.
    expect(s.listAll()).toHaveLength(1);
    const master = s.listAll()[0];
    expect(master.recurrence_freq).toBe('weekly');
    expect(master.recurrence_until).toBe(S + 3 * WEEK);

    // Exactly 4 occurrences, and nothing past the bound.
    const occs = s.listOccurrences(S - 1, S + 100 * WEEK);
    expect(occs.map((o) => o.start_at)).toEqual([S, S + WEEK, S + 2 * WEEK, S + 3 * WEEK]);

    // The payload lets the bot confirm the range concretely.
    expect(ev(res).occurrence_count).toBe(4);
    expect(ev(res).recurrence_open_ended).toBe(false);
    expect(ev(res).recurrence_until_local).toBeTruthy();
    memory.close();
  });

  test('recurrence_until_iso bounds the series the same way', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Taller',
      start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly',
      recurrence_until_iso: new Date(S + 3 * WEEK).toISOString(),
    });
    expect(res.status).toBe('success');
    expect(ev(res).occurrence_count).toBe(4);
    expect(s.listAll()[0].recurrence_until).toBe(S + 3 * WEEK);
    memory.close();
  });

  test('no range → open-ended series (still supported)', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Asamblea ordinaria',
      start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly',
    });
    expect(res.status).toBe('success');
    expect(s.listAll()[0].recurrence_until).toBeNull();
    expect(ev(res).recurrence_open_ended).toBe(true);
    expect(ev(res).occurrence_count).toBeNull();
    memory.close();
  });

  test('recurrence_count: 1 collapses to a one-off, not a 1-instance series', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Charla única',
      start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly',
      recurrence_count: 1,
    });
    expect(res.status).toBe('success');
    const master = s.listAll()[0];
    expect(master.recurrence_freq).toBeNull();
    expect(master.recurrence_until).toBeNull();
    expect(ev(res).occurrence_count).toBe(1);
    memory.close();
  });

  test('passing both range params is rejected as a contradiction', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Taller',
      start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly',
      recurrence_count: 4,
      recurrence_until_iso: new Date(S + 9 * WEEK).toISOString(),
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/not both/i);
    expect(s.listAll()).toHaveLength(0); // nothing written
    memory.close();
  });

  test('a range without a frequency is rejected', async () => {
    const { memory, s, src } = await ctx();
    for (const range of [{ recurrence_count: 4 }, { recurrence_until_iso: new Date(S + WEEK).toISOString() }]) {
      const res = await src.handle('calendar_create_event', {
        title: 'Evento', start_at_iso: new Date(S).toISOString(), ...range,
      });
      expect(res.status).toBe('error');
      expect(JSON.stringify(res.payload)).toMatch(/requires recurrence_freq/i);
    }
    expect(s.listAll()).toHaveLength(0);
    memory.close();
  });

  test('an out-of-range count is rejected without writing', async () => {
    const { memory, s, src } = await ctx();
    for (const bad of [0, -3, 2.5, MAX_RECURRENCE_COUNT + 1]) {
      const res = await src.handle('calendar_create_event', {
        title: 'Evento', start_at_iso: new Date(S).toISOString(),
        recurrence_freq: 'daily', recurrence_count: bad,
      });
      expect(res.status).toBe('error');
    }
    expect(s.listAll()).toHaveLength(0);
    memory.close();
  });

  test('a cutoff before the first occurrence is rejected', async () => {
    const { memory, s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Evento', start_at_iso: new Date(S).toISOString(),
      recurrence_freq: 'weekly', recurrence_until_iso: new Date(S - WEEK).toISOString(),
    });
    expect(res.status).toBe('error');
    memory.close();
  });
});

describe('calendar_update_event re-bounding a series', () => {
  const weekly = (s: CalendarStore) =>
    s.create({ created_by: 'MOD', title: 'Círculo', start_at: S, recurrence_freq: 'weekly' });

  test('recurrence_count re-bounds an open-ended series', async () => {
    const { memory, s, src } = await ctx();
    const m = weekly(s);
    const res = await src.handle('calendar_update_event', { id: m.id, recurrence_count: 6 });
    expect(res.status).toBe('success');
    expect(s.get(m.id)!.recurrence_until).toBe(S + 5 * WEEK);
    expect(ev(res).occurrence_count).toBe(6);
    memory.close();
  });

  test('recurrence_until_iso: null makes a bounded series open-ended again', async () => {
    const { memory, s, src } = await ctx();
    const m = s.create({
      created_by: 'MOD', title: 'Círculo', start_at: S,
      recurrence_freq: 'weekly', recurrence_until: S + 3 * WEEK,
    });
    const res = await src.handle('calendar_update_event', { id: m.id, recurrence_until_iso: null });
    expect(res.status).toBe('success');
    expect(s.get(m.id)!.recurrence_until).toBeNull();
    expect(ev(res).recurrence_open_ended).toBe(true);
    memory.close();
  });

  test('count is measured from the NEW start when the same call moves the series', async () => {
    const { memory, s, src } = await ctx();
    const m = weekly(s);
    const newStart = S + WEEK;
    const res = await src.handle('calendar_update_event', {
      id: m.id, start_at_iso: new Date(newStart).toISOString(), recurrence_count: 3,
    });
    expect(res.status).toBe('success');
    const row = s.get(m.id)!;
    expect(row.start_at).toBe(newStart);
    expect(row.recurrence_until).toBe(newStart + 2 * WEEK);
    memory.close();
  });

  test('count is measured under the NEW frequency when the same call changes it', async () => {
    const { memory, s, src } = await ctx();
    const m = weekly(s);
    const res = await src.handle('calendar_update_event', {
      id: m.id, recurrence_freq: 'daily', recurrence_count: 5,
    });
    expect(res.status).toBe('success');
    expect(s.get(m.id)!.recurrence_until).toBe(S + 4 * 86_400_000);
    memory.close();
  });

  test('dropping recurrence also clears a stale cutoff', async () => {
    const { memory, s, src } = await ctx();
    const m = s.create({
      created_by: 'MOD', title: 'Círculo', start_at: S,
      recurrence_freq: 'weekly', recurrence_until: S + 3 * WEEK,
    });
    const res = await src.handle('calendar_update_event', { id: m.id, recurrence_freq: null });
    expect(res.status).toBe('success');
    const row = s.get(m.id)!;
    expect(row.recurrence_freq).toBeNull();
    expect(row.recurrence_until).toBeNull();
    memory.close();
  });

  test('an unrelated edit leaves the range untouched', async () => {
    const { memory, s, src } = await ctx();
    const m = s.create({
      created_by: 'MOD', title: 'Círculo', start_at: S,
      recurrence_freq: 'weekly', recurrence_until: S + 3 * WEEK,
    });
    const res = await src.handle('calendar_update_event', { id: m.id, location: 'Sala 2' });
    expect(res.status).toBe('success');
    expect(s.get(m.id)!.recurrence_until).toBe(S + 3 * WEEK);
    memory.close();
  });
});

describe('desiredMonthKeys (the published board)', () => {
  const oneOff = (iso: string): MonthCardEvent => ({ start_at: Date.parse(iso), recurrence_freq: null });
  const series = (iso: string): MonthCardEvent => ({ start_at: Date.parse(iso), recurrence_freq: 'weekly' });
  const AUG = Date.parse('2026-08-03T14:00:00Z'); // Mon Aug 3 2026, 08:00 CDMX

  test('the current month is always on the board, even with no events', () => {
    expect(desiredMonthKeys([], AUG)).toEqual(['2026-08']);
  });

  test('past months are pruned — the live June/July regression', () => {
    // Exactly the 2026-08-03 production state: one-offs in June and July.
    const events = [
      oneOff('2026-06-26T01:30:00Z'), oneOff('2026-06-28T02:00:00Z'), // June
      oneOff('2026-07-02T02:00:00Z'), oneOff('2026-07-30T02:00:00Z'), // July
      series('2026-06-23T02:00:00Z'),                                  // open-ended weekly
    ];
    expect(desiredMonthKeys(events, AUG)).toEqual(['2026-08']);
  });

  test('a future month with a one-off gets its own card', () => {
    expect(desiredMonthKeys([oneOff('2026-10-10T02:00:00Z')], AUG)).toEqual(['2026-08', '2026-10']);
  });

  test('a recurring series never spawns future-month cards', () => {
    // The 2026-06-21 bug: one weekly event blasting a card for every month.
    expect(desiredMonthKeys([series('2026-08-05T02:00:00Z')], AUG)).toEqual(['2026-08']);
  });

  test('months without a template are dropped', () => {
    // Templates only cover 2026-06..2026-12.
    expect(desiredMonthKeys([oneOff('2027-03-10T02:00:00Z')], AUG)).toEqual(['2026-08']);
    expect(desiredMonthKeys([], Date.parse('2027-03-10T18:00:00Z'))).toEqual([]);
  });

  test('the board rolls over on the local month boundary, not the UTC one', () => {
    // 2026-08-01T04:00:00Z is still Jul 31 22:00 in CDMX (UTC-6).
    expect(desiredMonthKeys([], Date.parse('2026-08-01T04:00:00Z'))).toEqual(['2026-07']);
    expect(desiredMonthKeys([], Date.parse('2026-08-01T06:00:00Z'))).toEqual(['2026-08']);
  });
});

describe('monthPublishAction (month-rollover trigger)', () => {
  const published = (...keys: string[]) => (k: string) => keys.includes(k);

  test('a month with no card yet is published', () => {
    expect(monthPublishAction('2026-08', published())).toBe('publish');
    expect(monthPublishAction('2026-08', published('pdf:2026-07', 'ics'))).toBe('publish');
  });

  test('an already-posted month is left alone — a restart cannot double-post', () => {
    expect(monthPublishAction('2026-08', published('pdf:2026-08'))).toBe('already_published');
  });

  test('a month with no template reports no_template instead of publishing', () => {
    expect(monthPublishAction('2027-01', published())).toBe('no_template');
    // …and stays that way even if some other card is tracked.
    expect(monthPublishAction('2027-01', published('pdf:2026-12'))).toBe('no_template');
  });

  test('a failed publish retries: the verdict stays "publish" until a row exists', () => {
    const rows = new Set<string>();
    const isPublished = (k: string) => rows.has(k);
    expect(monthPublishAction('2026-08', isPublished)).toBe('publish'); // attempt fails, no row
    expect(monthPublishAction('2026-08', isPublished)).toBe('publish'); // → retried
    rows.add('pdf:2026-08');                                            // attempt succeeds
    expect(monthPublishAction('2026-08', isPublished)).toBe('already_published');
  });

  test('the trigger and the board agree: a publishable month is one the board wants', () => {
    // The trigger only works because desiredMonthKeys ALWAYS keeps the current
    // month — otherwise a row would never appear and it would loop forever.
    for (const now of ['2026-08-03T14:00:00Z', '2026-12-25T14:00:00Z']) {
      const cur = desiredMonthKeys([], Date.parse(now));
      expect(monthPublishAction(cur[0], () => false)).toBe('publish');
      expect(cur).toHaveLength(1);
    }
  });
});
