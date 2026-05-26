/**
 * Recurrence expansion for the calendar capability.
 *
 * V1 supports daily / weekly / monthly frequencies anchored to a single
 * master event row (`recurrence_freq` + optional `recurrence_until`). Each
 * call to listUpcoming/search expands the master into virtual occurrences
 * within the requested window. There is no per-instance override yet —
 * update/delete by id always affects the entire series.
 *
 * Timezone semantics: daily and weekly are timezone-invariant (we step in
 * fixed ms). Monthly is calendar-aware — Jan 31 + 1 month → Feb 28/29, not
 * the JS default of "Mar 3". We do the month math in a fixed-offset
 * "wall-clock UTC" derived from America/Mexico_City's constant UTC-6
 * (no DST since October 2022). If we ever support tzs that observe DST,
 * `WALL_CLOCK_OFFSET_MS` becomes a per-call argument.
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly';

export const RECURRENCE_FREQUENCIES: readonly RecurrenceFreq[] = ['daily', 'weekly', 'monthly'];

const DAY_MS = 86_400_000;
// America/Mexico_City offset (no DST). Local = UTC + offset.
const WALL_CLOCK_OFFSET_MS = -6 * 60 * 60 * 1000;

/**
 * Returns the n-th step from `baseMs` for the given frequency.
 *   step(base, 'weekly', 0) === base
 *   step(base, 'weekly', 1) === base + 7 days
 *   step(base, 'monthly', 2) === base + 2 calendar months (day clamped)
 */
export function step(baseMs: number, freq: RecurrenceFreq, n: number): number {
  if (freq === 'daily') return baseMs + n * DAY_MS;
  if (freq === 'weekly') return baseMs + n * 7 * DAY_MS;
  return stepMonths(baseMs, n);
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

export interface MasterEventLike {
  start_at: number;
  end_at: number | null;
  recurrence_freq: RecurrenceFreq | null;
  recurrence_until: number | null;
}

export interface ExpandedOccurrence {
  start_at: number;
  end_at: number | null;
  occurrence_index: number; // 0 = the master itself
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
): ExpandedOccurrence[] {
  const out: ExpandedOccurrence[] = [];
  const upperBound = event.recurrence_until !== null
    ? Math.min(windowEndMs, event.recurrence_until)
    : windowEndMs;
  const duration = event.end_at !== null ? event.end_at - event.start_at : null;

  if (event.recurrence_freq === null) {
    if (event.start_at >= windowStartMs && event.start_at <= windowEndMs) {
      out.push({
        start_at: event.start_at,
        end_at: event.end_at,
        occurrence_index: 0,
      });
    }
    return out;
  }

  // Recurring: walk forward from start_at.
  for (let i = 0; out.length < maxOccurrences; i++) {
    const occStart = step(event.start_at, event.recurrence_freq, i);
    if (occStart > upperBound) break;
    if (occStart >= windowStartMs) {
      out.push({
        start_at: occStart,
        end_at: duration !== null ? occStart + duration : null,
        occurrence_index: i,
      });
    }
    // Safety: monthly stepping with n very large is fine, but for daily series
    // with a far-future window we cap on maxOccurrences via the loop condition.
  }
  return out;
}

export function isRecurrenceFreq(v: unknown): v is RecurrenceFreq {
  return typeof v === 'string' && (RECURRENCE_FREQUENCIES as readonly string[]).includes(v);
}
