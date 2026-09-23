/**
 * Richer series rhythms (migration v11): "cada 2 semanas / quincenal",
 * "martes y jueves", "el segundo martes de cada mes", "el último viernes",
 * "cada año" — plus the named list windows ("este finde", "la próxima semana").
 *
 * Asked for by the RevZ admins 2026-09-23: before this, "cada 15 días" was
 * explicitly unsupported and the prompt told the model to offer weekly instead.
 */
import { describe, test, expect } from 'vitest';
import {
  countOccurrencesUntil,
  describeRecurrence,
  expandOccurrences,
  normalizeAnchor,
  ruleOf,
  step,
  untilFromCount,
  type RecurrenceRule,
} from '../recurrence.js';
import { rruleFor } from '../ics.js';
import { localDateKey, namedRangeWindow } from '../time.js';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';

/** UTC ms of a CDMX wall-clock time (fixed UTC-6). */
const L = (date: string, hour = 20) => Date.parse(`${date}T00:00:00Z`) + (hour + 6) * 3_600_000;
const rule = (r: Partial<RecurrenceRule> & Pick<RecurrenceRule, 'freq'>): RecurrenceRule => ({
  interval: 1, byWeekday: null, monthly: null, ...r,
});
const dates = (start: number, r: RecurrenceRule, n: number) =>
  Array.from({ length: n }, (_, i) => localDateKey(step(start, r, i)));

describe('step — rich rules', () => {
  test('quincenal = weekly every 2 weeks', () => {
    expect(dates(L('2026-09-01'), rule({ freq: 'weekly', interval: 2 }), 3)).toEqual([
      '2026-09-01', '2026-09-15', '2026-09-29',
    ]);
  });

  test('martes y jueves, every week — keeps the wall-clock time', () => {
    const r = rule({ freq: 'weekly', byWeekday: ['TU', 'TH'] });
    const start = L('2026-09-29');
    expect(dates(start, r, 5)).toEqual(['2026-09-29', '2026-10-01', '2026-10-06', '2026-10-08', '2026-10-13']);
    expect(new Date(step(start, r, 3)).toISOString()).toBe('2026-10-09T02:00:00.000Z'); // Thu 8pm CDMX
  });

  test('lunes y miércoles cada 2 semanas', () => {
    const r = rule({ freq: 'weekly', interval: 2, byWeekday: ['MO', 'WE'] });
    expect(dates(L('2026-09-28'), r, 4)).toEqual(['2026-09-28', '2026-09-30', '2026-10-12', '2026-10-14']);
  });

  test('el segundo martes de cada mes', () => {
    const r = rule({ freq: 'monthly', monthly: 'nth_weekday' });
    expect(dates(L('2026-09-08'), r, 4)).toEqual(['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08']);
  });

  test('el último viernes de cada mes', () => {
    const r = rule({ freq: 'monthly', monthly: 'last_weekday' });
    expect(dates(L('2026-09-25'), r, 4)).toEqual(['2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25']);
  });

  test('bimestral by date, and yearly', () => {
    expect(dates(L('2026-09-15'), rule({ freq: 'monthly', interval: 2 }), 3)).toEqual([
      '2026-09-15', '2026-11-15', '2027-01-15',
    ]);
    expect(dates(L('2026-09-23'), rule({ freq: 'yearly' }), 3)).toEqual(['2026-09-23', '2027-09-23', '2028-09-23']);
  });

  test('cada tercer día = daily every 2', () => {
    expect(dates(L('2026-09-01'), rule({ freq: 'daily', interval: 2 }), 3)).toEqual([
      '2026-09-01', '2026-09-03', '2026-09-05',
    ]);
  });

  test('a bare frequency still means the plain rule (pre-v11 rows unchanged)', () => {
    const s = L('2026-09-01');
    expect(step(s, 'weekly', 3)).toBe(step(s, rule({ freq: 'weekly' }), 3));
    expect(ruleOf({ start_at: s, end_at: null, recurrence_freq: 'weekly', recurrence_until: null })).toEqual(
      rule({ freq: 'weekly' }),
    );
  });

  test('ruleOf ignores modifiers that do not fit the frequency', () => {
    const r = ruleOf({
      start_at: 0, end_at: null, recurrence_freq: 'monthly', recurrence_until: null,
      recurrence_byday: 'TU,TH', recurrence_monthly: null,
    });
    expect(r?.byWeekday).toBeNull();
  });
});

describe('normalizeAnchor', () => {
  test('weekly days: an off-rhythm start moves to the first listed day', () => {
    const { startMs, rule: r } = normalizeAnchor(L('2026-09-28'), rule({ freq: 'weekly', byWeekday: ['TH', 'TU'] }));
    expect(localDateKey(startMs)).toBe('2026-09-29');
    expect(r.byWeekday).toEqual(['TU', 'TH']);
  });

  test('a single listed day that is the anchor collapses to plain weekly', () => {
    const { rule: r } = normalizeAnchor(L('2026-09-29'), rule({ freq: 'weekly', byWeekday: ['TU'] }));
    expect(r.byWeekday).toBeNull();
  });

  test('a 5th weekday becomes "the last" (a 5th Tuesday is missing most months)', () => {
    const { startMs, rule: r } = normalizeAnchor(L('2026-09-29'), rule({ freq: 'monthly', monthly: 'nth_weekday' }));
    expect(r.monthly).toBe('last_weekday');
    expect(localDateKey(step(startMs, r, 1))).toBe('2026-10-27');
  });

  test('last_weekday moves an early date to the last such weekday of its month', () => {
    const { startMs } = normalizeAnchor(L('2026-09-04'), rule({ freq: 'monthly', monthly: 'last_weekday' }));
    expect(localDateKey(startMs)).toBe('2026-09-25');
  });
});

describe('counting and expansion follow the rule', () => {
  test('"martes y jueves, 6 sesiones" ends on the 6th session, not the 6th week', () => {
    const r = rule({ freq: 'weekly', byWeekday: ['TU', 'TH'] });
    const s = L('2026-09-29');
    const until = untilFromCount(s, r, 6);
    expect(localDateKey(until)).toBe('2026-10-15');
    expect(countOccurrencesUntil(s, r, until)).toBe(6);
  });

  test('expandOccurrences reads the stored columns', () => {
    const occ = expandOccurrences(
      {
        start_at: L('2026-09-01'), end_at: null, recurrence_freq: 'weekly', recurrence_until: null,
        recurrence_interval: 2, recurrence_byday: null, recurrence_monthly: null,
      },
      L('2026-09-01', 0),
      L('2026-10-01', 0),
    );
    expect(occ.map((o) => localDateKey(o.start_at))).toEqual(['2026-09-01', '2026-09-15', '2026-09-29']);
  });
});

describe('describeRecurrence — Spanish labels the model can echo', () => {
  test.each([
    [rule({ freq: 'weekly', interval: 2 }), L('2026-09-01'), 'cada 2 semanas (quincenal), los martes'],
    [rule({ freq: 'weekly', byWeekday: ['TU', 'TH'] }), L('2026-09-29'), 'semanal, los martes y jueves'],
    [rule({ freq: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] }), L('2026-09-28'), 'semanal, de lunes a viernes'],
    [rule({ freq: 'weekly', byWeekday: ['SA', 'SU'] }), L('2026-09-26'), 'semanal, los sábados y domingos'],
    [rule({ freq: 'monthly', monthly: 'nth_weekday' }), L('2026-09-08'), 'el segundo martes de cada mes'],
    [rule({ freq: 'monthly', monthly: 'last_weekday' }), L('2026-09-25'), 'el último viernes de cada mes'],
    [rule({ freq: 'monthly', interval: 3 }), L('2026-09-15'), 'el día 15 cada 3 meses (trimestral)'],
    [rule({ freq: 'monthly' }), L('2026-09-15'), 'mensual, el día 15'],
    [rule({ freq: 'daily', interval: 2 }), L('2026-09-15'), 'cada 2 días'],
    [rule({ freq: 'yearly' }), L('2026-09-23'), 'anual, cada 23 de septiembre'],
  ])('%j', (r, anchor, label) => {
    expect(describeRecurrence(r, anchor)).toBe(label);
  });
});

describe('ICS RRULE mirrors the rule', () => {
  const ics = (start: number, extra: Record<string, unknown>) =>
    rruleFor({
      id: 1, title: 't', description: null, location: null, start_at: start, end_at: null,
      recurrence_until: null, recurrence_freq: null, ...extra,
    } as Parameters<typeof rruleFor>[0]);
  test.each([
    [L('2026-09-01'), { recurrence_freq: 'weekly', recurrence_interval: 2 }, 'RRULE:FREQ=WEEKLY;INTERVAL=2'],
    [L('2026-09-29'), { recurrence_freq: 'weekly', recurrence_byday: 'TU,TH' }, 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH'],
    [L('2026-09-08'), { recurrence_freq: 'monthly', recurrence_monthly: 'nth_weekday' }, 'RRULE:FREQ=MONTHLY;BYDAY=2TU'],
    [L('2026-09-25'), { recurrence_freq: 'monthly', recurrence_monthly: 'last_weekday' }, 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'],
    [L('2026-09-23'), { recurrence_freq: 'yearly' }, 'RRULE:FREQ=YEARLY'],
    [L('2026-09-01'), { recurrence_freq: 'weekly' }, 'RRULE:FREQ=WEEKLY'],
  ])('%#', (start, extra, expected) => {
    expect(ics(start, extra)).toBe(expected);
  });
  test('one-off → no RRULE', () => expect(ics(L('2026-09-01'), {})).toBeNull());
});

describe('namedRangeWindow (CDMX, Monday-first)', () => {
  // Wednesday 23 Sep 2026, 12:00 CDMX.
  const NOW = L('2026-09-23', 12);
  const win = (r: Parameters<typeof namedRangeWindow>[0]) => {
    const w = namedRangeWindow(r, NOW);
    return [new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString()];
  };
  test('hoy / mañana start at local midnight', () => {
    expect(win('hoy')).toEqual(['2026-09-23T06:00:00.000Z', '2026-09-24T05:59:59.999Z']);
    expect(win('manana')).toEqual(['2026-09-24T06:00:00.000Z', '2026-09-25T05:59:59.999Z']);
  });
  test('fin de semana = Friday 6pm → Sunday night', () => {
    expect(win('fin_de_semana')).toEqual(['2026-09-26T00:00:00.000Z', '2026-09-28T05:59:59.999Z']);
  });
  test('on Saturday, "este finde" starts today', () => {
    const w = namedRangeWindow('fin_de_semana', L('2026-09-26', 15));
    expect(localDateKey(w.fromMs)).toBe('2026-09-26');
  });
  test('próxima semana = next Monday → Sunday', () => {
    expect(win('proxima_semana')).toEqual(['2026-09-28T06:00:00.000Z', '2026-10-05T05:59:59.999Z']);
  });
  test('este mes / próximo mes', () => {
    expect(win('este_mes')[1]).toBe('2026-10-01T05:59:59.999Z');
    expect(win('proximo_mes')).toEqual(['2026-10-01T06:00:00.000Z', '2026-11-01T05:59:59.999Z']);
  });
});

describe('tools — create/update/list with rhythms', () => {
  const NOW = L('2026-09-23', 12);
  async function ctx() {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    await memory.migrate('calendar', CALENDAR_MIGRATIONS);
    const s = new CalendarStore(memory.db());
    return { s, src: new CalendarToolSource(s, 'MOD', NOW) };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const payload = (r: { payload: unknown }) => r.payload as Record<string, any>;

  test('"martes y jueves, 4 sesiones, desde el lunes 28" → one row, shifted anchor, concrete label', async () => {
    const { s, src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'Taller de serigrafía',
      start_at_iso: iso(L('2026-09-28')),
      recurrence_freq: 'weekly',
      recurrence_weekdays: ['jueves', 'TU'],
      recurrence_count: 4,
    });
    expect(res.status).toBe('success');
    const p = payload(res);
    expect(p.event.recurrence_label).toBe('semanal, los martes y jueves');
    expect(p.event.occurrence_count).toBe(4);
    expect(p.start_adjusted).toMatch(/primera sesión/);
    const row = s.listAll()[0]!;
    expect(row.recurrence_byday).toBe('TU,TH');
    expect(localDateKey(row.start_at)).toBe('2026-09-29');
    expect(localDateKey(row.recurrence_until!)).toBe('2026-10-08');
  });

  test('quincenal create, then "ahora también los jueves" keeps the interval', async () => {
    const { s, src } = await ctx();
    await src.handle('calendar_create_event', {
      title: 'Círculo', start_at_iso: iso(L('2026-09-29')), recurrence_freq: 'weekly', recurrence_interval: 2,
    });
    const id = s.listAll()[0]!.id;
    const res = await src.handle('calendar_update_event', { id, recurrence_weekdays: ['TU', 'TH'] });
    expect(payload(res).event.recurrence_label).toBe('cada 2 semanas (quincenal), los martes y jueves');
  });

  test('changing the frequency resets modifiers that no longer apply', async () => {
    const { s, src } = await ctx();
    await src.handle('calendar_create_event', {
      title: 'Círculo', start_at_iso: iso(L('2026-09-29')), recurrence_freq: 'weekly', recurrence_weekdays: ['TU', 'TH'],
    });
    const id = s.listAll()[0]!.id;
    await src.handle('calendar_update_event', { id, recurrence_freq: 'monthly' });
    const row = s.get(id)!;
    expect(row.recurrence_byday).toBeNull();
    expect(row.recurrence_freq).toBe('monthly');
  });

  test('weekdays on a monthly series is refused with a usable message', async () => {
    const { src } = await ctx();
    const res = await src.handle('calendar_create_event', {
      title: 'x', start_at_iso: iso(L('2026-09-29')), recurrence_freq: 'monthly', recurrence_weekdays: ['TU'],
    });
    expect(res.status).toBe('error');
    expect((res.payload as { error: string }).error).toMatch(/only applies to recurrence_freq "weekly"/);
  });

  test('scope "following" keeps the rhythm on the new half', async () => {
    const { s, src } = await ctx();
    await src.handle('calendar_create_event', {
      title: 'Club', start_at_iso: iso(L('2026-09-01')), recurrence_freq: 'weekly', recurrence_interval: 2,
    });
    const id = s.listAll()[0]!.id;
    const res = await src.handle('calendar_update_event', {
      id, scope: 'following', occurrence_date_iso: '2026-09-29', title: 'Club (nueva sede)',
    });
    expect(payload(res).new_series.recurrence_label).toBe('cada 2 semanas (quincenal), los martes');
  });

  test('list_upcoming with range: "este finde" only returns the weekend', async () => {
    const { src } = await ctx();
    for (const [title, date] of [['jueves', '2026-09-24'], ['sábado', '2026-09-26'], ['lunes', '2026-09-28']]) {
      await src.handle('calendar_create_event', { title, start_at_iso: iso(L(date!)) });
    }
    const res = await src.handle('calendar_list_upcoming', { range: 'fin_de_semana' });
    const p = payload(res);
    expect(p.events.map((e: { title: string }) => e.title)).toEqual(['sábado']);
    expect(p.range).toMatch(/fin de semana/);
    const explicit = payload(await src.handle('calendar_list_upcoming', { from_date: '2026-09-24', to_date: '2026-09-26' }));
    expect(explicit.events.map((e: { title: string }) => e.title)).toEqual(['jueves', 'sábado']);
  });
});
