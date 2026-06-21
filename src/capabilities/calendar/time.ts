export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * America/Mexico_City is a fixed UTC-6 (no DST since October 2022). Local wall
 * time = UTC + this offset. To read local Y/M/D/H/M from a UTC timestamp:
 * `new Date(utcMs + WALL_CLOCK_OFFSET_MS)` then the `getUTC*` accessors. To go
 * the other way (a wall-clock instant built with `Date.UTC(...)` back to a true
 * UTC instant): `wallMs - WALL_CLOCK_OFFSET_MS`. This mirrors recurrence.ts.
 */
export const WALL_CLOCK_OFFSET_MS = -6 * 60 * 60 * 1000;

/**
 * Format a unix-ms timestamp in the given IANA timezone for human display.
 * The output is locale-stable ("Sun, May 25, 10:00 AM") so the model can
 * echo it back verbatim without recomputing offsets — Mexico City stopped
 * observing DST in October 2022, and many models still apply CDT (UTC-5)
 * when they shouldn't.
 */
export function formatInTimezone(
  unixMs: number,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(unixMs));
}

/**
 * Just the wall-clock time, e.g. "8:00 PM" — used for the compact event chip
 * rendered inside a calendar day cell. 12-hour with an uppercase AM/PM and no
 * NBSP (Helvetica/WinAnsi-safe for the PDF renderer).
 */
export function formatLocalClock(
  unixMs: number,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(new Date(unixMs))
    .replace(/ /g, ' ') // narrow no-break space some ICUs emit before AM/PM
    .replace(/\s+/g, ' ')
    .trim();
}
