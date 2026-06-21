import { describe, test, expect } from 'vitest';
import { buildCalendar, escapeText, type IcsEvent } from '../ics.js';

const NOW = Date.parse('2026-06-21T18:00:00Z');

function base(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    id: 1,
    title: 'Asamblea',
    description: null,
    location: null,
    // 2026-06-21T02:00:00Z == Sat Jun 20 2026, 20:00 (8pm) in UTC-6.
    start_at: Date.parse('2026-06-21T02:00:00Z'),
    end_at: null,
    recurrence_freq: null,
    recurrence_until: null,
    ...overrides,
  };
}

function lines(ics: string): string[] {
  return ics.split('\r\n');
}

describe('buildCalendar', () => {
  test('emits a well-formed VCALENDAR skeleton with a fixed UTC-6 VTIMEZONE', () => {
    const ics = buildCalendar([base()], { nowMs: NOW });
    expect(ics.endsWith('\r\n')).toBe(true);
    const L = lines(ics);
    expect(L[0]).toBe('BEGIN:VCALENDAR');
    expect(L).toContain('VERSION:2.0');
    expect(L).toContain('BEGIN:VTIMEZONE');
    expect(L).toContain('TZID:America/Mexico_City');
    expect(L).toContain('TZOFFSETTO:-0600');
    expect(L).toContain('X-WR-TIMEZONE:America/Mexico_City');
    expect(L[L.length - 2]).toBe('END:VCALENDAR'); // last line before trailing CRLF
  });

  test('DTSTART is local wall time with TZID; 8pm CDMX renders as 20:00', () => {
    const ics = buildCalendar([base()], { nowMs: NOW });
    expect(ics).toContain('DTSTART;TZID=America/Mexico_City:20260620T200000');
    expect(ics).toContain('UID:chopperbot-cal-1@revolucionz');
    expect(ics).toContain(`DTSTAMP:20260621T180000Z`);
  });

  test('point-in-time events omit DTEND; ranged events include it', () => {
    const pt = buildCalendar([base()], { nowMs: NOW });
    expect(pt).not.toContain('DTEND');

    const ranged = buildCalendar(
      [base({ end_at: Date.parse('2026-06-21T04:00:00Z') })],
      { nowMs: NOW },
    );
    expect(ranged).toContain('DTEND;TZID=America/Mexico_City:20260620T220000');
  });

  test('weekly recurrence emits an RRULE with a UTC UNTIL', () => {
    const ics = buildCalendar(
      [base({ recurrence_freq: 'weekly', recurrence_until: Date.parse('2026-08-01T02:00:00Z') })],
      { nowMs: NOW },
    );
    expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20260801T020000Z');
  });

  test('open-ended recurrence emits RRULE without UNTIL', () => {
    const ics = buildCalendar([base({ recurrence_freq: 'monthly' })], { nowMs: NOW });
    expect(ics).toMatch(/RRULE:FREQ=MONTHLY(\r\n|$)/);
    expect(ics).not.toContain('UNTIL');
  });

  test('multiple events produce multiple VEVENT blocks', () => {
    const ics = buildCalendar([base({ id: 1 }), base({ id: 2, title: 'Círculo' })], { nowMs: NOW });
    const count = ics.split('BEGIN:VEVENT').length - 1;
    expect(count).toBe(2);
    expect(ics).toContain('UID:chopperbot-cal-2@revolucionz');
  });

  test('SUMMARY/DESCRIPTION/LOCATION are RFC-escaped', () => {
    const ics = buildCalendar(
      [base({ title: 'Lectura: venas, sangre; sur', location: 'Sala A, piso 2' })],
      { nowMs: NOW },
    );
    expect(ics).toContain('SUMMARY:Lectura: venas\\, sangre\\; sur');
    expect(ics).toContain('LOCATION:Sala A\\, piso 2');
  });

  test('escapeText handles backslash, comma, semicolon, and newlines', () => {
    expect(escapeText('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne');
  });

  test('long lines are folded to <=75 octets with a leading space on continuations', () => {
    const long = 'x'.repeat(200);
    const ics = buildCalendar([base({ description: long })], { nowMs: NOW });
    for (const line of lines(ics)) {
      // Each *physical* line must be <= 75 octets.
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // The description must contain a fold (CRLF + space) somewhere.
    expect(ics).toContain('\r\n ');
  });

  test('multibyte accents do not push a fold over the octet limit', () => {
    const ics = buildCalendar([base({ title: 'á'.repeat(80) })], { nowMs: NOW });
    for (const line of lines(ics)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});
