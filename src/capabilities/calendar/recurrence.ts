/**
 * Recurrence expansion for the calendar capability.
 *
 * Daily / weekly / monthly / yearly rules anchored to a single master event row
 * (`recurrence_freq` + optional `recurrence_until`, plus since migration v11 the
 * rule modifiers `recurrence_interval` / `recurrence_byday` / `recurrence_monthly`
 * — "cada 2 semanas", "martes y jueves", "el último viernes del mes"). Each call to
 * listUpcoming/search expands the master into virtual occurrences within the
 * requested window. A series is open-ended unless `recurrence_until` bounds it —
 * see {@link untilFromCount} for how the tools' "N veces" range is stored.
 * Per-occurrence exceptions (retime/cancel a single instance) come in via the
 * `overrides` argument; see {@link OccurrenceOverride}.
 *
 * Timezone semantics: daily and weekly are timezone-invariant (we step in
 * fixed ms). Monthly is calendar-aware — Jan 31 + 1 month → Feb 28/29, not
 * the JS default of "Mar 3". We do the month math in a fixed-offset
 * "wall-clock UTC" derived from America/Mexico_City's constant UTC-6
 * (no DST since October 2022). If we ever support tzs that observe DST,
 * `WALL_CLOCK_OFFSET_MS` becomes a per-call argument.
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const RECURRENCE_FREQUENCIES: readonly RecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'yearly'];

/** RFC 5545 weekday codes; the order is JS `getUTCDay()` order (Sunday = 0). */
export type Weekday = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';
export const WEEKDAYS: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * How a monthly series picks its day:
 *  - `day_of_month` — the same date every month ("el 15 de cada mes"; the default).
 *  - `nth_weekday`  — the same ordinal weekday ("el segundo martes de cada mes");
 *    the ordinal is read off the anchor date (day 8–14 → the 2nd).
 *  - `last_weekday` — the last such weekday ("el último viernes del mes").
 */
export type MonthlyMode = 'day_of_month' | 'nth_weekday' | 'last_weekday';
export const MONTHLY_MODES: readonly MonthlyMode[] = ['day_of_month', 'nth_weekday', 'last_weekday'];

/**
 * The full rhythm of a series. `freq` alone is the pre-2026-09 model and still
 * means exactly what it did: every rule field defaults to "plain".
 *
 *  - `interval` — every N units: weekly + 2 = quincenal, monthly + 3 = trimestral.
 *  - `byWeekday` — weekly only: several days per week ("martes y jueves",
 *    "de lunes a viernes"). Null = the anchor's own weekday.
 *  - `monthly` — monthly only, see {@link MonthlyMode}.
 */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  byWeekday: Weekday[] | null;
  monthly: MonthlyMode | null;
}

/** A bare frequency is shorthand for the plain rule of that frequency. */
export type RuleInput = RecurrenceFreq | RecurrenceRule;

/** Upper bound on "cada N …" — a guard against a model typo, not a policy. */
export const MAX_RECURRENCE_INTERVAL = 52;

const DAY_MS = 86_400_000;
// America/Mexico_City offset (no DST). Local = UTC + offset.
const WALL_CLOCK_OFFSET_MS = -6 * 60 * 60 * 1000;

function toRule(input: RuleInput): RecurrenceRule {
  return typeof input === 'string' ? { freq: input, interval: 1, byWeekday: null, monthly: null } : input;
}

/** Local (CDMX) weekday of an instant, Sunday = 0. */
export function localWeekday(utcMs: number): number {
  return new Date(utcMs + WALL_CLOCK_OFFSET_MS).getUTCDay();
}

/**
 * Day offsets (0..6) from the anchor for each weekly slot, ascending, always
 * starting with 0 — the anchor is occurrence 0 of its own series, so it is a
 * slot even if the caller's list forgot it ({@link normalizeAnchor} moves the
 * anchor onto a listed day at write time, so in practice it is already there).
 */
function weeklyOffsets(anchorMs: number, byWeekday: readonly Weekday[] | null): number[] {
  const anchorDow = localWeekday(anchorMs);
  const offsets = new Set<number>([0]);
  for (const d of byWeekday ?? []) offsets.add((WEEKDAYS.indexOf(d) - anchorDow + 7) % 7);
  return [...offsets].sort((a, b) => a - b);
}

/**
 * Returns the n-th occurrence from `baseMs` under the given rule (n = 0 is the
 * anchor itself). Every rule is index-addressable in O(1) — that property is
 * what lets overrides stay keyed by original anchor time and lets
 * {@link untilFromCount} turn "N veces" into a cutoff.
 *   step(base, 'weekly', 1) === base + 7 days
 *   step(base, {freq:'weekly', interval:2, …}, 1) === base + 14 days
 *   step(base, 'monthly', 2) === base + 2 calendar months (day clamped)
 */
export function step(baseMs: number, input: RuleInput, n: number): number {
  const rule = toRule(input);
  const interval = Math.max(1, Math.trunc(rule.interval || 1));
  if (n === 0) return baseMs;
  switch (rule.freq) {
    case 'daily':
      return baseMs + n * interval * DAY_MS;
    case 'weekly': {
      const offsets = weeklyOffsets(baseMs, rule.byWeekday);
      const week = Math.floor(n / offsets.length);
      const slot = n % offsets.length;
      return baseMs + (week * 7 * interval + offsets[slot]!) * DAY_MS;
    }
    case 'monthly':
      if (rule.monthly === 'nth_weekday' || rule.monthly === 'last_weekday') {
        return stepMonthsByWeekday(baseMs, n * interval, rule.monthly);
      }
      return stepMonths(baseMs, n * interval);
    case 'yearly':
      return stepMonths(baseMs, n * 12 * interval);
  }
}

function stepMonths(baseUtcMs: number, n: number): number {
  if (n === 0) return baseUtcMs;
  const wall = new Date(baseUtcMs + WALL_CLOCK_OFFSET_MS);
  const year = wall.getUTCFullYear();
  const month0 = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const hh = wall.getUTCHours();
  const mm = wall.getUTCMinutes();
  const ss = wall.getUTCSeconds();
  const ms = wall.getUTCMilliseconds();

  const tgtMonth0 = month0 + n;
  const tgtYear = year + Math.floor(tgtMonth0 / 12);
  const tgtMonthMod = ((tgtMonth0 % 12) + 12) % 12;

  // Clamp day-of-month if the target month is shorter (e.g. Jan 31 → Feb 28).
  const daysInTarget = new Date(Date.UTC(tgtYear, tgtMonthMod + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTarget);

  const resultWallMs = Date.UTC(tgtYear, tgtMonthMod, clampedDay, hh, mm, ss, ms);
  return resultWallMs - WALL_CLOCK_OFFSET_MS;
}

/** Which ordinal weekday of its month a date is: day 1–7 → 1, 8–14 → 2, … */
export function weekdayOrdinal(utcMs: number): number {
  return Math.ceil(new Date(utcMs + WALL_CLOCK_OFFSET_MS).getUTCDate() / 7);
}

/** True when no later same-weekday exists in the date's month. */
export function isLastWeekdayOfMonth(utcMs: number): boolean {
  const wall = new Date(utcMs + WALL_CLOCK_OFFSET_MS);
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  return wall.getUTCDate() + 7 > daysInMonth;
}

/**
 * The anchor's ordinal weekday (or last weekday), `n` months later. Ordinals
 * 1–4 exist in every month; a 5th-weekday anchor is stored as `last_weekday`
 * by {@link normalizeAnchor}, so this never has to skip a month.
 */
function stepMonthsByWeekday(baseUtcMs: number, n: number, mode: 'nth_weekday' | 'last_weekday'): number {
  const wall = new Date(baseUtcMs + WALL_CLOCK_OFFSET_MS);
  const dow = wall.getUTCDay();
  const tgtMonth0 = wall.getUTCMonth() + n;
  const tgtYear = wall.getUTCFullYear() + Math.floor(tgtMonth0 / 12);
  const tgtMonthMod = ((tgtMonth0 % 12) + 12) % 12;
  let day: number;
  if (mode === 'last_weekday') {
    const last = new Date(Date.UTC(tgtYear, tgtMonthMod + 1, 0));
    day = last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7);
  } else {
    const nth = Math.min(4, Math.ceil(wall.getUTCDate() / 7));
    const firstDow = new Date(Date.UTC(tgtYear, tgtMonthMod, 1)).getUTCDay();
    day = 1 + ((dow - firstDow + 7) % 7) + (nth - 1) * 7;
  }
  const resultWallMs = Date.UTC(
    tgtYear, tgtMonthMod, day,
    wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds(),
  );
  return resultWallMs - WALL_CLOCK_OFFSET_MS;
}

/**
 * Make a (start, rule) pair self-consistent at WRITE time, so every consumer
 * (expansion, ICS RRULE, the Discord event) agrees on what occurrence 0 is:
 *
 *  - weekly with days listed: an anchor that is not one of them moves forward
 *    to the first listed day ("martes y jueves, a partir del lunes 28" starts
 *    Tue 29 — what a person means, and what RFC 5545 requires of DTSTART).
 *  - `last_weekday`: the anchor moves to the last such weekday of its month.
 *  - `nth_weekday` on a 5th weekday: becomes `last_weekday` (a 5th Tuesday does
 *    not exist in most months; "el último" is what that date means).
 *  - modifiers that don't apply to the frequency are dropped, not rejected
 *    here (the tool layer rejects them with a readable message first).
 */
export function normalizeAnchor(startMs: number, input: RuleInput): { startMs: number; rule: RecurrenceRule } {
  const rule: RecurrenceRule = { ...toRule(input) };
  rule.interval = Math.max(1, Math.trunc(rule.interval || 1));
  if (rule.freq !== 'weekly') rule.byWeekday = null;
  if (rule.freq !== 'monthly') rule.monthly = null;
  if (rule.monthly === 'day_of_month') rule.monthly = null;

  let start = startMs;
  if (rule.byWeekday && rule.byWeekday.length > 0) {
    const days = [...new Set(rule.byWeekday)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    rule.byWeekday = days;
    const anchorDow = localWeekday(start);
    const shift = Math.min(...days.map((d) => (WEEKDAYS.indexOf(d) - anchorDow + 7) % 7));
    start += shift * DAY_MS;
    // A single listed day equal to the anchor's is just a plain weekly series.
    if (days.length === 1) rule.byWeekday = null;
  } else {
    rule.byWeekday = null;
  }
  if (rule.monthly === 'nth_weekday' && weekdayOrdinal(start) >= 5) rule.monthly = 'last_weekday';
  if (rule.monthly === 'last_weekday') {
    while (!isLastWeekdayOfMonth(start)) start += 7 * DAY_MS;
  }
  return { startMs: start, rule };
}

const WEEKDAY_ES: Record<Weekday, string> = {
  SU: 'domingo', MO: 'lunes', TU: 'martes', WE: 'miércoles', TH: 'jueves', FR: 'viernes', SA: 'sábado',
};
const ORDINAL_ES = ['primer', 'segundo', 'tercer', 'cuarto'];

function joinEs(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * The series rhythm in the community's words — "cada 2 semanas (quincenal),
 * los martes", "el último viernes de cada mes". Used by the tool payloads and
 * the calendar snapshot so the model confirms the rhythm without having to
 * translate enum values (and so it never echoes `weekly`/`nth_weekday`).
 */
export function describeRecurrence(input: RuleInput, anchorMs: number): string {
  const rule = toRule(input);
  const n = Math.max(1, rule.interval);
  const wall = new Date(anchorMs + WALL_CLOCK_OFFSET_MS);
  const anchorDay = WEEKDAY_ES[WEEKDAYS[wall.getUTCDay()]!];
  switch (rule.freq) {
    case 'daily':
      return n === 1 ? 'diaria' : `cada ${n} días`;
    case 'weekly': {
      const days = rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [WEEKDAYS[wall.getUTCDay()]!];
      const isWeekdays = days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d as Weekday));
      const when = isWeekdays ? 'de lunes a viernes' : `los ${joinEs(days.map((d) => pluralWeekday(WEEKDAY_ES[d])))}`;
      if (n === 1) return `semanal, ${when}`;
      if (n === 2) return `cada 2 semanas (quincenal), ${when}`;
      return `cada ${n} semanas, ${when}`;
    }
    case 'monthly': {
      const every = n === 1 ? 'de cada mes' : n === 2 ? 'cada 2 meses (bimestral)' : n === 3 ? 'cada 3 meses (trimestral)' : `cada ${n} meses`;
      if (rule.monthly === 'last_weekday') return `el último ${anchorDay} ${every}`;
      if (rule.monthly === 'nth_weekday') {
        return `el ${ORDINAL_ES[Math.min(4, Math.ceil(wall.getUTCDate() / 7)) - 1]} ${anchorDay} ${every}`;
      }
      return n === 1 ? `mensual, el día ${wall.getUTCDate()}` : `el día ${wall.getUTCDate()} ${every}`;
    }
    case 'yearly': {
      const date = new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(wall);
      return n === 1 ? `anual, cada ${date}` : `cada ${n} años, el ${date}`;
    }
  }
}

function pluralWeekday(day: string): string {
  // lunes/martes/miércoles/jueves/viernes are invariant; sábado/domingo take -s.
  return day.endsWith('s') ? day : `${day}s`;
}

/** The rule carried by a stored row (null for a one-off). */
export function ruleOf(e: MasterEventLike): RecurrenceRule | null {
  if (e.recurrence_freq === null) return null;
  const byday = (e.recurrence_byday ?? '')
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
  const monthly = e.recurrence_monthly;
  return {
    freq: e.recurrence_freq,
    interval: e.recurrence_interval && e.recurrence_interval > 1 ? e.recurrence_interval : 1,
    // A modifier that doesn't fit the frequency is ignored, never applied: a
    // freq change from a path that doesn't know the modifiers (the admin
    // console) must not leave a monthly series with a weekly BYDAY.
    byWeekday: e.recurrence_freq === 'weekly' && byday.length > 0 ? byday : null,
    monthly:
      e.recurrence_freq === 'monthly' && (monthly === 'nth_weekday' || monthly === 'last_weekday') ? monthly : null,
  };
}

/** Columns a rule is stored in (null = plain), the inverse of {@link ruleOf}. */
export function ruleColumns(rule: RecurrenceRule | null): {
  recurrence_freq: RecurrenceFreq | null;
  recurrence_interval: number | null;
  recurrence_byday: string | null;
  recurrence_monthly: MonthlyMode | null;
} {
  if (!rule) return { recurrence_freq: null, recurrence_interval: null, recurrence_byday: null, recurrence_monthly: null };
  return {
    recurrence_freq: rule.freq,
    recurrence_interval: rule.interval > 1 ? rule.interval : null,
    recurrence_byday: rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday.join(',') : null,
    recurrence_monthly: rule.monthly,
  };
}

export interface MasterEventLike {
  start_at: number;
  end_at: number | null;
  recurrence_freq: RecurrenceFreq | null;
  recurrence_until: number | null;
  /** Rule modifiers (migration v11); absent/null = the plain rule of `recurrence_freq`. */
  recurrence_interval?: number | null;
  recurrence_byday?: string | null;
  recurrence_monthly?: string | null;
}

/**
 * A per-occurrence exception to a recurring series, keyed by the occurrence's
 * ORIGINAL anchor time (`occurrence_start_at` = the time the series would put it
 * at). `cancelled` skips it; the other fields override the master for just that
 * occurrence (null = inherit). Retimes are same-day (the renderer/window logic
 * still buckets by the original anchor's day).
 */
export interface OccurrenceOverride {
  occurrence_start_at: number;
  cancelled: boolean;
  start_at: number | null;
  end_at: number | null;
  title: string | null;
  description: string | null;
  location: string | null;
}

export interface ExpandedOccurrence {
  start_at: number;
  end_at: number | null;
  occurrence_index: number; // 0 = the master itself
  /** The override applied to this occurrence, if any (null for plain ones). */
  override: OccurrenceOverride | null;
}

/**
 * Generate occurrences of an event within [windowStartMs, windowEndMs].
 * Non-recurring events: returns the single master if it falls in window.
 * Recurring events: steps forward from start_at until either windowEndMs
 * or recurrence_until is exceeded. Always bounded by maxOccurrences as a
 * safety net (large daily series + huge window otherwise unbounded).
 */
export function expandOccurrences(
  event: MasterEventLike,
  windowStartMs: number,
  windowEndMs: number,
  maxOccurrences: number = 100,
  overrides?: ReadonlyMap<number, OccurrenceOverride>,
): ExpandedOccurrence[] {
  const out: ExpandedOccurrence[] = [];
  const upperBound = event.recurrence_until !== null
    ? Math.min(windowEndMs, event.recurrence_until)
    : windowEndMs;
  const duration = event.end_at !== null ? event.end_at - event.start_at : null;

  const rule = ruleOf(event);
  if (rule === null) {
    if (event.start_at >= windowStartMs && event.start_at <= windowEndMs) {
      out.push({ start_at: event.start_at, end_at: event.end_at, occurrence_index: 0, override: null });
    }
    return out;
  }

  // Recurring: walk forward from start_at. Occurrences are keyed by their
  // ORIGINAL anchor time; an override at that key cancels or retimes them.
  for (let i = 0; out.length < maxOccurrences; i++) {
    const occStart = step(event.start_at, rule, i);
    if (occStart > upperBound) break;
    if (occStart >= windowStartMs) {
      const ov = overrides?.get(occStart) ?? null;
      if (!ov?.cancelled) {
        const effStart = ov?.start_at ?? occStart;
        out.push({
          start_at: effStart,
          end_at: ov?.end_at ?? (duration !== null ? effStart + duration : null),
          occurrence_index: i,
          override: ov,
        });
      }
    }
    // Safety: monthly stepping with n very large is fine, but for daily series
    // with a far-future window we cap on maxOccurrences via the loop condition.
  }
  return out;
}

export function isRecurrenceFreq(v: unknown): v is RecurrenceFreq {
  return typeof v === 'string' && (RECURRENCE_FREQUENCIES as readonly string[]).includes(v);
}

/** Upper bound on a bounded series, so "cada día por N veces" can't explode. */
export const MAX_RECURRENCE_COUNT = 260;

/**
 * The `recurrence_until` that bounds a series to exactly `count` occurrences:
 * the anchor time of the LAST one. `count = 1` returns the anchor itself.
 *
 * This is how the tools' `recurrence_count` ("cada martes, 4 veces") is stored —
 * there is no separate count column. Collapsing a count to a concrete cutoff at
 * write time means the renderer, the ICS RRULE (`UNTIL=`) and `expandOccurrences`
 * all keep working off the single `recurrence_until` field they already handle.
 */
export function untilFromCount(startMs: number, freq: RuleInput, count: number): number {
  return step(startMs, freq, count - 1);
}

/**
 * How many occurrences a series actually yields — i.e. how many anchors fall at
 * or before `untilMs`. Returns null for an open-ended series (no cutoff), so
 * callers can render "indefinida" instead of a number. Used to confirm a
 * bounded series back to the mod in concrete terms ("semanal, 4 sesiones").
 */
export function countOccurrencesUntil(
  startMs: number,
  freq: RuleInput,
  untilMs: number | null,
  cap: number = MAX_RECURRENCE_COUNT,
): number | null {
  if (untilMs === null) return null;
  if (untilMs < startMs) return 0;
  let n = 0;
  for (let i = 0; i < cap; i++) {
    if (step(startMs, freq, i) > untilMs) break;
    n++;
  }
  return n;
}
