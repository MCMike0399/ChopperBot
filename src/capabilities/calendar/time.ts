export const DEFAULT_TIMEZONE = 'America/Mexico_City';

const DAY_MS = 86_400_000;

/**
 * The "Conciencia temporal" system-prompt block: the current UTC + local time,
 * today's local calendar date (not just the weekday), the fixed UTC-6 rule
 * (no DST since Oct 2022), and how to resolve relative dates into ISO 8601 UTC
 * for the `start_at_iso` tool field.
 *
 * Shared by the calendar capability, event_intake, and general_chat so ALL
 * resolve fuzzy dates like "hoy" / "mañana" / "domingo" / "8pm" with identical
 * rules. One source of truth for the UTC-6 offset — many models still wrongly
 * apply CDT/UTC-5, or worse, treat "UTC-6" as "subtract a whole calendar day"
 * from the UTC timestamp (live 2026-08-25 in #general: "qué evento hay mañana"
 * on Tuesday 25 at 11:14 CDMX, UTC already 17:14 the SAME day, answered as if
 * today were Monday).
 */
export function renderTemporalAwareness(now: Date): string {
  const nowMs = now.getTime();
  const todayKey = localDateKey(nowMs);
  const tomorrowMs = nowMs + DAY_MS;
  const yesterdayMs = nowMs - DAY_MS;
  return `# Conciencia temporal
- UTC actual: ${now.toISOString()}
- Hora local actual: ${formatInTimezone(nowMs)} (${DEFAULT_TIMEZONE})
- **Hoy es ${formatLocalDateLong(nowMs)}** (fecha local \`${todayKey}\`).
- **Mañana es ${formatLocalDateLong(tomorrowMs)}** (\`${localDateKey(tomorrowMs)}\`). Ayer fue ${formatLocalDateLong(yesterdayMs)} (\`${localDateKey(yesterdayMs)}\`).
- Cuenta los días de la semana a partir de HOY: "el próximo jueves" / "todos los jueves" es el siguiente jueves en el calendario desde esta fecha (no el día de hoy ni mañana salvo que coincidan).
- ${DEFAULT_TIMEZONE} es **UTC-6 todo el año** (sin horario de verano desde octubre 2022). El desfase es fijo −06:00; no uses "CDT".
- **No restes un día al ver UTC-6.** La fecha de "hoy" es la línea de arriba, nunca la parte de fecha del timestamp UTC ni un UTC-6 mal restado. A mediodía CDMX el UTC ya es la tarde del MISMO día civil; un evento a las 8pm CDMX cae al día siguiente en UTC (\`2026-08-25T20:00:00-06:00\` = \`2026-08-26T02:00:00Z\`).
- Resuelve tiempos relativos ("mañana", "el sábado", "hoy a las 8") contra la fecha **local** de arriba, luego conviértelos a ISO 8601 UTC para la herramienta.
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

/** Local YYYY-MM-DD for a UTC ms (CDMX wall clock). */
export function localDateKey(utcMs: number): string {
  const wall = new Date(utcMs + WALL_CLOCK_OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wall.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Where an event's local calendar day sits relative to "now", also in CDMX.
 * The model must not recompute this from `start_at_iso` (an 8pm CDMX event is
 * the next UTC date).
 */
export type RelativeLocalDay = 'past' | 'today' | 'tomorrow' | 'later';

export function relativeLocalDay(eventMs: number, nowMs: number): RelativeLocalDay {
  const eventKey = localDateKey(eventMs);
  const todayKey = localDateKey(nowMs);
  if (eventKey === todayKey) return 'today';
  if (eventKey < todayKey) return 'past';
  if (eventKey === localDateKey(nowMs + DAY_MS)) return 'tomorrow';
  return 'later';
}

/** "martes 25 de agosto de 2026" — weekday + date the model can echo. */
export function formatLocalDateLong(unixMs: number): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(new Date(unixMs))
    .replace(/,/g, '');
}

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
