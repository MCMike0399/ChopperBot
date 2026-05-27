/**
 * Spanish-friendly date formatting for the IG monitor post cards.
 *
 * Two distinct date sources, two distinct policies:
 *
 * - `formatEventWhen` renders the LLM-extracted event date (`Classification.when`).
 *   It preserves the **wall-clock time stated in the post** and never converts
 *   time zones. This is deliberate: the classifier emits offsets that can be
 *   wrong (it tends to write -05:00 for CDMX, but Mexico dropped DST in 2023 and
 *   is UTC-06:00 year-round), so converting would shift the displayed hour. The
 *   number on the flyer is what the reader needs, so we show exactly that.
 *
 * - `formatPostedAt` renders a real UTC instant (`RecentPost.takenAtMs` from the
 *   IG API), so it *can* be safely converted — we show it in Mexico City time.
 */

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

const MONTHS_FULL = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const MONTHS_ABBR = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

const CDMX_TZ = 'America/Mexico_City';

/**
 * Friendly Spanish rendering of an event date string, preserving the stated
 * wall-clock time (no time-zone conversion). Accepts `YYYY-MM-DD`, with an
 * optional `T`/space + `HH:MM` and any trailing offset (ignored). The year is
 * only shown when it differs from the current year. Returns the trimmed input
 * verbatim if it doesn't look like a date, so a misbehaving model never breaks
 * the card.
 *
 *   2026-05-26T16:00:00-05:00  ->  martes 26 de mayo, 16:00 h
 *   2026-05-30                 ->  sábado 30 de mayo
 *   2027-01-01T09:00           ->  viernes 1 de enero de 2027, 09:00 h
 */
export function formatEventWhen(iso: string, nowMs: number = Date.now()): string {
  const raw = iso.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return raw;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw;

  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const currentYear = new Date(nowMs).getUTCFullYear();
  let datePart = `${weekday} ${day} de ${MONTHS_FULL[month - 1]}`;
  if (year !== currentYear) datePart += ` de ${year}`;

  const hasTime = m[4] !== undefined;
  return hasTime ? `${datePart}, ${m[4]}:${m[5]} h` : datePart;
}

/**
 * Friendly Spanish rendering of a UTC instant in Mexico City local time.
 *
 *   1716661263000  ->  25 may 2026, 14:31
 */
export function formatPostedAt(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CDMX_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const day = Number(pick('day'));
  const month = Number(pick('month'));
  return `${day} ${MONTHS_ABBR[month - 1]} ${pick('year')}, ${pick('hour')}:${pick('minute')}`;
}
