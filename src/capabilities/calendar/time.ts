export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * The "Conciencia temporal" system-prompt block: the current UTC + local time,
 * today's weekday, the fixed UTC-6 rule (no DST since Oct 2022), and how to
 * resolve relative dates into ISO 8601 UTC for the `start_at_iso` tool field.
 *
 * Shared by the calendar capability and event_intake so BOTH resolve fuzzy
 * dates like "domingo" / "8pm" with identical rules (one source of truth for
 * the UTC-6 offset — many models still wrongly apply CDT/UTC-5).
 */
export function renderTemporalAwareness(now: Date): string {
  const weekday = new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
  }).format(now);
  return `# Conciencia temporal
- UTC actual: ${now.toISOString()}
- Hora local actual: ${formatInTimezone(now.getTime())} (${DEFAULT_TIMEZONE})
- **Hoy es ${weekday}.** Cuenta los días de la semana a partir de hoy: "el próximo jueves" / "todos los jueves" es el siguiente jueves en el calendario desde esta fecha (no el día de hoy ni mañana salvo que coincidan).
- ${DEFAULT_TIMEZONE} es **UTC-6 todo el año** (sin horario de verano desde octubre 2022). El desfase es fijo −06:00; no uses "CDT".
- Resuelve tiempos relativos ("mañana", "el sábado", "hoy a las 8") contra la hora **local**, luego conviértelos a ISO 8601 UTC para la herramienta.
  - Ejemplo: sábado 20 de junio 2026 a las 8:00 PM (CDMX) = 2026-06-20T20:00:00−06:00 = **2026-06-21T02:00:00Z** → pásalo como \`start_at_iso\`.`;
}

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
