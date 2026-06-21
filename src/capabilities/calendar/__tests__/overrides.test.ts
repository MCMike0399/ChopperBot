/**
 * Per-occurrence exceptions for recurring series: cancel-one, retime-one, and
 * the "this and following" series split. Covers the pure expansion, the store,
 * the ICS, and the tool-layer scope logic (driven directly, no LLM).
 */
import { describe, test, expect } from 'vitest';
import { expandOccurrences, type OccurrenceOverride } from '../recurrence.js';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import { buildCalendar, type IcsEvent } from '../ics.js';

const WEEK = 7 * 86_400_000;
// Sun Jun 21 2026, 20:00 CDMX = 2026-06-22T02:00:00Z. Weekly anchors: +WEEK each.
const S = Date.parse('2026-06-22T02:00:00Z');
const occ = (i: number) => S + i * WEEK; // original anchor of the i-th occurrence
const NOW = Date.parse('2026-06-20T00:00:00Z');

function store() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  // migrate runs synchronously enough for tests via the promise
  return memory.migrate('calendar', CALENDAR_MIGRATIONS).then(() => ({
    memory,
    store: new CalendarStore(memory.db()),
  }));
}

function weeklyMaster(s: CalendarStore) {
  return s.create({ created_by: 'MOD', title: 'Círculo', start_at: S, recurrence_freq: 'weekly' });
}

describe('expandOccurrences with overrides', () => {
  const base = { end_at: null, recurrence_freq: 'weekly' as const, recurrence_until: null };

  test('cancel skips just that occurrence', () => {
    const overrides = new Map<number, OccurrenceOverride>([
      [occ(1), { occurrence_start_at: occ(1), cancelled: true, start_at: null, end_at: null, title: null, description: null, location: null }],
    ]);
    const out = expandOccurrences({ ...base, start_at: S }, S, S + 3 * WEEK, 10, overrides);
    expect(out.map((o) => o.start_at)).toEqual([occ(0), occ(2), occ(3)]);
  });

  test('retime shifts only that occurrence and carries the override', () => {
    const overrides = new Map<number, OccurrenceOverride>([
      [occ(1), { occurrence_start_at: occ(1), cancelled: false, start_at: occ(1) + 1_800_000, end_at: null, title: 'Especial', description: null, location: null }],
    ]);
    const out = expandOccurrences({ ...base, start_at: S }, S, S + 2 * WEEK, 10, overrides);
    expect(out[0].start_at).toBe(occ(0));
    expect(out[1].start_at).toBe(occ(1) + 1_800_000); // +30 min
    expect(out[1].override?.title).toBe('Especial');
    expect(out[2].start_at).toBe(occ(2));
  });
});

describe('CalendarStore overrides', () => {
  test('upsert retimes one occurrence; others unchanged; is_overridden flag set', async () => {
    const { memory, store: s } = await store();
    const m = weeklyMaster(s);
    s.upsertOverride(m.id, occ(1), { start_at: occ(1) + 1_800_000, title: 'Especial' });
    const rows = s.listUpcoming(NOW, 4);
    expect(rows[0].start_at).toBe(occ(0));
    expect(rows[0].is_overridden).toBe(false);
    expect(rows[1].start_at).toBe(occ(1) + 1_800_000);
    expect(rows[1].is_overridden).toBe(true);
    expect(rows[1].title).toBe('Especial');
    expect(rows[2].start_at).toBe(occ(2));
    memory.close();
  });

  test('cancel removes one occurrence', async () => {
    const { memory, store: s } = await store();
    const m = weeklyMaster(s);
    s.cancelOccurrence(m.id, occ(2));
    expect(s.listUpcoming(NOW, 4).map((r) => r.start_at)).toEqual([occ(0), occ(1), occ(3), occ(4)]);
    memory.close();
  });

  test('clearOverridesFrom drops overrides at/after a cutoff', async () => {
    const { memory, store: s } = await store();
    const m = weeklyMaster(s);
    s.cancelOccurrence(m.id, occ(1));
    s.cancelOccurrence(m.id, occ(3));
    s.clearOverridesFrom(m.id, occ(3));
    expect(s.listOverridesForMaster(m.id).map((o) => o.occurrence_start_at)).toEqual([occ(1)]);
    memory.close();
  });

  test('deleting the master cascades its overrides', async () => {
    const { memory, store: s } = await store();
    const m = weeklyMaster(s);
    s.cancelOccurrence(m.id, occ(1));
    s.delete(m.id);
    expect(s.listOverridesForMaster(m.id)).toEqual([]);
    memory.close();
  });
});

describe('ICS exceptions', () => {
  const master: IcsEvent = {
    id: 7, title: 'Círculo', description: null, location: null,
    start_at: S, end_at: null, recurrence_freq: 'weekly', recurrence_until: null,
  };

  test('cancelled occurrence → EXDATE; retimed → RECURRENCE-ID instance', () => {
    const overrides = new Map<number, OccurrenceOverride[]>([
      [7, [
        { occurrence_start_at: occ(1), cancelled: true, start_at: null, end_at: null, title: null, description: null, location: null },
        { occurrence_start_at: occ(2), cancelled: false, start_at: occ(2) + 1_800_000, end_at: null, title: 'Especial', description: null, location: null },
      ]],
    ]);
    const ics = buildCalendar([master], { nowMs: NOW, overrides });
    // EXDATE for the cancelled one (Jun 28 20:00 local).
    expect(ics).toContain('EXDATE;TZID=America/Mexico_City:20260628T200000');
    // A standalone instance for the retimed one (Jul 5: original 20:00 → 20:30).
    expect(ics).toContain('RECURRENCE-ID;TZID=America/Mexico_City:20260705T200000');
    expect(ics).toContain('DTSTART;TZID=America/Mexico_City:20260705T203000');
    expect(ics).toContain('SUMMARY:Especial');
    expect(ics.split('BEGIN:VEVENT').length - 1).toBe(2); // master + 1 override instance
  });
});

describe('CalendarToolSource scope', () => {
  const ctx = async () => {
    const { memory, store: s } = await store();
    const src = new CalendarToolSource(s, 'MOD', NOW); // no publisher
    return { memory, s, src };
  };

  test('scope=occurrence retimes only that day (same-day enforced)', async () => {
    const { memory, s, src } = await ctx();
    const m = weeklyMaster(s);
    const res = await src.handle('calendar_update_event', {
      id: m.id, scope: 'occurrence', occurrence_date_iso: '2026-06-28',
      start_at_iso: new Date(occ(1) + 1_800_000).toISOString(),
    });
    expect(res.status).toBe('success');
    const rows = s.listUpcoming(NOW, 3);
    expect(rows[1].start_at).toBe(occ(1) + 1_800_000);
    expect(rows[0].start_at).toBe(occ(0));
    memory.close();
  });

  test('scope=occurrence rejects moving to a different day', async () => {
    const { memory, s, src } = await ctx();
    const m = weeklyMaster(s);
    const res = await src.handle('calendar_update_event', {
      id: m.id, scope: 'occurrence', occurrence_date_iso: '2026-06-28',
      start_at_iso: '2026-06-30T02:00:00Z', // different day
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/MISMO día|same day/i);
    memory.close();
  });

  test('scope=occurrence delete cancels just that day', async () => {
    const { memory, s, src } = await ctx();
    const m = weeklyMaster(s);
    const res = await src.handle('calendar_delete_event', { id: m.id, scope: 'occurrence', occurrence_date_iso: '2026-06-28' });
    expect(res.status).toBe('success');
    expect(s.listUpcoming(NOW, 4).map((r) => r.start_at)).toEqual([occ(0), occ(2), occ(3), occ(4)]);
    memory.close();
  });

  test('scope=following splits the series at the chosen occurrence', async () => {
    const { memory, s, src } = await ctx();
    const m = weeklyMaster(s);
    // From Jul 12 onward, move to 21:00 (occ(3) = Jul 12 anchor).
    const res = await src.handle('calendar_update_event', {
      id: m.id, scope: 'following', occurrence_date_iso: '2026-07-12',
      start_at_iso: new Date(occ(3) + 3_600_000).toISOString(),
    });
    expect(res.status).toBe('success');
    const masters = s.listAll();
    expect(masters).toHaveLength(2);
    // Original truncated before Jul 12; new series starts Jul 12 at 21:00.
    const original = masters.find((x) => x.id === m.id)!;
    expect(original.recurrence_until).toBe(occ(3) - 1);
    const split = masters.find((x) => x.id !== m.id)!;
    expect(split.start_at).toBe(occ(3) + 3_600_000);
    expect(split.recurrence_freq).toBe('weekly');
    // Occurrences before the split keep 20:00; from Jul 12 they're 21:00.
    const rows = s.listUpcoming(NOW, 6);
    expect(rows.find((r) => r.start_at === occ(2))).toBeTruthy(); // Jul 5 unchanged
    expect(rows.find((r) => r.start_at === occ(3) + 3_600_000)).toBeTruthy(); // Jul 12 moved
    expect(rows.find((r) => r.start_at === occ(3))).toBeFalsy(); // old Jul 12 gone
    memory.close();
  });

  test('scope=following delete truncates from the chosen occurrence', async () => {
    const { memory, s, src } = await ctx();
    const m = weeklyMaster(s);
    const res = await src.handle('calendar_delete_event', { id: m.id, scope: 'following', occurrence_date_iso: '2026-07-05' });
    expect(res.status).toBe('success');
    expect(s.get(m.id)!.recurrence_until).toBe(occ(2) - 1);
    const rows = s.listUpcoming(NOW, 10);
    expect(rows.every((r) => r.start_at < occ(2))).toBe(true);
    memory.close();
  });

  test('one-off events ignore scope (no occurrence concept)', async () => {
    const { memory, s, src } = await ctx();
    const one = s.create({ created_by: 'MOD', title: 'Asamblea', start_at: occ(0) });
    const res = await src.handle('calendar_update_event', { id: one.id, scope: 'occurrence', occurrence_date_iso: '2026-06-21', start_at_iso: new Date(occ(0) + 1_800_000).toISOString() });
    expect(res.status).toBe('success');
    // Treated as a series (whole) edit → the single event moved.
    expect(s.get(one.id)!.start_at).toBe(occ(0) + 1_800_000);
    memory.close();
  });
});
