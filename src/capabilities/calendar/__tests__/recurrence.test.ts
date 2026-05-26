import { describe, test, expect } from 'vitest';
import { expandOccurrences, step, type MasterEventLike } from '../recurrence.js';

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(iso);

const base: MasterEventLike = {
  start_at: ms('2026-05-27T02:00:00Z'), // Wed 8pm CDMX = Thu 2am UTC… actually Wed 8pm CDMX = Thu 02:00 UTC; ISO date is correct
  end_at: null,
  recurrence_freq: null,
  recurrence_until: null,
};

describe('step', () => {
  test('daily: n*1 day', () => {
    expect(step(ms('2026-05-27T02:00:00Z'), 'daily', 3) - ms('2026-05-27T02:00:00Z')).toBe(3 * DAY);
  });

  test('weekly: n*7 days', () => {
    expect(step(ms('2026-05-27T02:00:00Z'), 'weekly', 4) - ms('2026-05-27T02:00:00Z')).toBe(28 * DAY);
  });

  test('monthly: preserves day-of-month in local tz', () => {
    // May 27 + 1 month → Jun 27, same wall-clock time.
    expect(step(ms('2026-05-27T02:00:00Z'), 'monthly', 1)).toBe(ms('2026-06-27T02:00:00Z'));
  });

  test('monthly: clamps day when target month is shorter (Jan 31 → Feb 28)', () => {
    // Jan 31 at 8pm CDMX = Feb 1 at 02:00 UTC.
    // + 1 month should give Feb 28 at 8pm CDMX = Mar 1 at 02:00 UTC.
    expect(step(ms('2026-02-01T02:00:00Z'), 'monthly', 1)).toBe(ms('2026-03-01T02:00:00Z'));
  });

  test('monthly: handles year rollover', () => {
    expect(step(ms('2026-12-15T18:00:00Z'), 'monthly', 1)).toBe(ms('2027-01-15T18:00:00Z'));
  });
});

describe('expandOccurrences', () => {
  test('non-recurring event in window → 1 occurrence', () => {
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-05-27T02:00:00Z') },
      ms('2026-05-01T00:00:00Z'),
      ms('2026-06-01T00:00:00Z'),
    );
    expect(out).toEqual([{ start_at: ms('2026-05-27T02:00:00Z'), end_at: null, occurrence_index: 0 }]);
  });

  test('non-recurring event outside window → empty', () => {
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-04-01T00:00:00Z') },
      ms('2026-05-01T00:00:00Z'),
      ms('2026-06-01T00:00:00Z'),
    );
    expect(out).toEqual([]);
  });

  test('weekly: 4 Wednesdays in a 4-week window', () => {
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-05-27T02:00:00Z'), recurrence_freq: 'weekly' },
      ms('2026-05-27T02:00:00Z'),
      ms('2026-06-24T02:00:00Z'),
    );
    expect(out.map((o) => new Date(o.start_at).toISOString())).toEqual([
      '2026-05-27T02:00:00.000Z',
      '2026-06-03T02:00:00.000Z',
      '2026-06-10T02:00:00.000Z',
      '2026-06-17T02:00:00.000Z',
      '2026-06-24T02:00:00.000Z',
    ]);
  });

  test('weekly with recurrence_until: stops at the cap', () => {
    const out = expandOccurrences(
      {
        ...base,
        start_at: ms('2026-05-27T02:00:00Z'),
        recurrence_freq: 'weekly',
        recurrence_until: ms('2026-06-10T23:59:59Z'),
      },
      ms('2026-05-27T02:00:00Z'),
      ms('2027-01-01T00:00:00Z'),
    );
    expect(out.map((o) => new Date(o.start_at).toISOString())).toEqual([
      '2026-05-27T02:00:00.000Z',
      '2026-06-03T02:00:00.000Z',
      '2026-06-10T02:00:00.000Z',
    ]);
  });

  test('weekly starting BEFORE window: only in-window occurrences are returned', () => {
    // Master started May 6; window starts May 27. Should see only May 27, Jun 3, …
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-05-06T02:00:00Z'), recurrence_freq: 'weekly' },
      ms('2026-05-27T00:00:00Z'),
      ms('2026-06-10T23:59:59Z'),
    );
    expect(out.map((o) => new Date(o.start_at).toISOString())).toEqual([
      '2026-05-27T02:00:00.000Z',
      '2026-06-03T02:00:00.000Z',
      '2026-06-10T02:00:00.000Z',
    ]);
    // occurrence_index reflects the offset from the master, not the window.
    expect(out[0].occurrence_index).toBe(3);
  });

  test('preserves event duration across occurrences', () => {
    const out = expandOccurrences(
      {
        start_at: ms('2026-05-27T02:00:00Z'),
        end_at: ms('2026-05-27T03:30:00Z'), // 90-minute event
        recurrence_freq: 'weekly',
        recurrence_until: null,
      },
      ms('2026-05-27T00:00:00Z'),
      ms('2026-06-10T23:59:59Z'),
    );
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect(o.end_at).not.toBeNull();
      expect((o.end_at as number) - o.start_at).toBe(90 * 60 * 1000);
    }
  });

  test('daily: respects maxOccurrences cap', () => {
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-05-01T12:00:00Z'), recurrence_freq: 'daily' },
      ms('2026-05-01T00:00:00Z'),
      ms('2027-05-01T00:00:00Z'),
      7,
    );
    expect(out).toHaveLength(7);
  });

  test('monthly: 12 months across a year', () => {
    const out = expandOccurrences(
      { ...base, start_at: ms('2026-01-15T18:00:00Z'), recurrence_freq: 'monthly' },
      ms('2026-01-01T00:00:00Z'),
      ms('2027-01-01T00:00:00Z'),
    );
    expect(out).toHaveLength(12);
    expect(new Date(out[11].start_at).toISOString()).toBe('2026-12-15T18:00:00.000Z');
  });
});
