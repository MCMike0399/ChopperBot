/**
 * ICS (RFC 5545) generation for the global calendar — the "backbone" that lets
 * anyone subscribe from a real calendar client (Google/Apple/Outlook).
 *
 * Each master event becomes one VEVENT; recurring masters carry an RRULE so the
 * client expands occurrences itself (we do NOT pre-expand into the file). Times
 * are emitted as local wall-clock with `TZID=America/Mexico_City` plus a
 * matching fixed-offset VTIMEZONE, so clients render the right hour without
 * guessing DST (Mexico City has been fixed at UTC-6 since October 2022).
 *
 * UIDs are stable (`chopperbot-cal-<id>@revolucionz`) so regenerating the file
 * after an edit updates the existing event in subscribers' clients instead of
 * duplicating it.
 */
import { DEFAULT_TIMEZONE, WALL_CLOCK_OFFSET_MS } from './time.js';
import type { OccurrenceOverride, RecurrenceFreq } from './recurrence.js';

export interface IcsEvent {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  start_at: number; // UTC ms
  end_at: number | null; // UTC ms
  recurrence_freq: RecurrenceFreq | null;
  recurrence_until: number | null; // UTC ms, inclusive last-occurrence cap
}

export interface BuildCalendarOptions {
  /** DTSTAMP for every VEVENT (injected for deterministic tests). */
  nowMs: number;
  /** Shown to clients as the calendar name. */
  calendarName?: string;
  /** Per-occurrence exceptions, keyed by master event id. */
  overrides?: ReadonlyMap<number, OccurrenceOverride[]>;
}

const PRODID = '-//ChopperBot//Revolucion Z Calendar//ES';
const RRULE_FREQ: Record<RecurrenceFreq, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
};

/** Build a complete VCALENDAR document (CRLF-terminated, folded). */
export function buildCalendar(events: IcsEvent[], opts: BuildCalendarOptions): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.calendarName ?? 'Revolución Z')}`,
    `X-WR-TIMEZONE:${DEFAULT_TIMEZONE}`,
    ...vtimezone(),
  ];
  for (const e of events) {
    const ovs = opts.overrides?.get(e.id) ?? [];
    lines.push(...vevent(e, opts.nowMs, ovs));
    // Retimed occurrences become standalone instances (same UID + RECURRENCE-ID).
    for (const ov of ovs) {
      if (!ov.cancelled) lines.push(...veventOverride(e, ov, opts.nowMs));
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Fixed UTC-6 zone (no DST since 2022-10-30). */
function vtimezone(): string[] {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${DEFAULT_TIMEZONE}`,
    `X-LIC-LOCATION:${DEFAULT_TIMEZONE}`,
    'BEGIN:STANDARD',
    'TZNAME:CST',
    'TZOFFSETFROM:-0600',
    'TZOFFSETTO:-0600',
    'DTSTART:20221030T020000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

function vevent(e: IcsEvent, nowMs: number, overrides: OccurrenceOverride[]): string[] {
  const out: string[] = [
    'BEGIN:VEVENT',
    `UID:chopperbot-cal-${e.id}@revolucionz`,
    `DTSTAMP:${utcStamp(nowMs)}`,
    `DTSTART;TZID=${DEFAULT_TIMEZONE}:${localStamp(e.start_at)}`,
  ];
  if (e.end_at !== null && e.end_at > e.start_at) {
    out.push(`DTEND;TZID=${DEFAULT_TIMEZONE}:${localStamp(e.end_at)}`);
  }
  if (e.recurrence_freq !== null) {
    let rrule = `RRULE:FREQ=${RRULE_FREQ[e.recurrence_freq]}`;
    if (e.recurrence_until !== null) {
      // UNTIL must be UTC when DTSTART carries a TZID (RFC 5545 §3.3.10).
      rrule += `;UNTIL=${utcStamp(e.recurrence_until)}`;
    }
    out.push(rrule);
    // Cancelled occurrences → EXDATE at their ORIGINAL anchor time.
    const cancelled = overrides.filter((o) => o.cancelled);
    if (cancelled.length > 0) {
      out.push(
        `EXDATE;TZID=${DEFAULT_TIMEZONE}:${cancelled.map((o) => localStamp(o.occurrence_start_at)).join(',')}`,
      );
    }
  }
  out.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.description) out.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) out.push(`LOCATION:${escapeText(e.location)}`);
  out.push('END:VEVENT');
  return out;
}

/** A single retimed/edited occurrence as a RECURRENCE-ID instance of its series. */
function veventOverride(e: IcsEvent, ov: OccurrenceOverride, nowMs: number): string[] {
  const duration = e.end_at !== null && e.end_at > e.start_at ? e.end_at - e.start_at : null;
  const start = ov.start_at ?? ov.occurrence_start_at;
  const end = ov.end_at ?? (duration !== null ? start + duration : null);
  const out: string[] = [
    'BEGIN:VEVENT',
    `UID:chopperbot-cal-${e.id}@revolucionz`,
    `RECURRENCE-ID;TZID=${DEFAULT_TIMEZONE}:${localStamp(ov.occurrence_start_at)}`,
    `DTSTAMP:${utcStamp(nowMs)}`,
    `DTSTART;TZID=${DEFAULT_TIMEZONE}:${localStamp(start)}`,
  ];
  if (end !== null && end > start) out.push(`DTEND;TZID=${DEFAULT_TIMEZONE}:${localStamp(end)}`);
  out.push(`SUMMARY:${escapeText(ov.title ?? e.title)}`);
  const description = ov.description ?? e.description;
  const location = ov.location ?? e.location;
  if (description) out.push(`DESCRIPTION:${escapeText(description)}`);
  if (location) out.push(`LOCATION:${escapeText(location)}`);
  out.push('END:VEVENT');
  return out;
}

/** "YYYYMMDDTHHMMSS" in local (UTC-6) wall time — pairs with the TZID param. */
function localStamp(utcMs: number): string {
  const w = new Date(utcMs + WALL_CLOCK_OFFSET_MS); // read local parts via getUTC*
  return (
    pad4(w.getUTCFullYear()) + pad2(w.getUTCMonth() + 1) + pad2(w.getUTCDate()) + 'T' +
    pad2(w.getUTCHours()) + pad2(w.getUTCMinutes()) + pad2(w.getUTCSeconds())
  );
}

/** "YYYYMMDDTHHMMSSZ" in UTC — for DTSTAMP and RRULE UNTIL. */
function utcStamp(utcMs: number): string {
  const d = new Date(utcMs);
  return (
    pad4(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
    pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z'
  );
}

/** RFC 5545 §3.3.11 TEXT escaping. Backslash first, then ; , and newlines. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to ≤75 octets (RFC 5545 §3.1) by inserting CRLF + a
 * single leading space. Counts UTF-8 bytes so multibyte chars (á, ñ, …) don't
 * push a fold past the limit.
 */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    const limit = first ? 75 : 74; // continuation lines start with a space
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
      first = false;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
