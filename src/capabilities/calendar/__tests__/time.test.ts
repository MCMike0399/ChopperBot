import { describe, test, expect } from 'vitest';
import {
  formatInTimezone,
  localDateKey,
  relativeLocalDay,
  renderTemporalAwareness,
} from '../time.js';

describe('formatInTimezone', () => {
  test('renders Mexico City time at UTC-6 even during US DST', () => {
    // 2026-05-25T16:00:00Z = 10:00 AM in America/Mexico_City (UTC-6 fixed).
    // Many models incorrectly assume CDT (UTC-5) and produce 11 AM — this
    // helper exists specifically to give the model a string it can echo.
    const ms = Date.parse('2026-05-25T16:00:00Z');
    const s = formatInTimezone(ms);
    expect(s).toContain('10:00');
    expect(s).toContain('AM');
    expect(s).toContain('May 25');
  });

  test('renders a different time deterministically', () => {
    // 2026-12-15T21:30:00Z = 3:30 PM in Mexico City (UTC-6 in winter too).
    const ms = Date.parse('2026-12-15T21:30:00Z');
    const s = formatInTimezone(ms);
    expect(s).toContain('3:30');
    expect(s).toContain('PM');
    expect(s).toContain('Dec 15');
  });

  test('respects a non-default timezone argument', () => {
    // 2026-05-25T16:00:00Z = 12:00 PM in America/New_York (UTC-4 in May DST).
    const ms = Date.parse('2026-05-25T16:00:00Z');
    const s = formatInTimezone(ms, 'America/New_York');
    expect(s).toContain('12:00');
    expect(s).toContain('PM');
  });
});

describe('localDateKey / relativeLocalDay', () => {
  // Live 2026-08-25 11:14 CDMX (Tue): UTC is already 17:14 the SAME calendar day.
  const noonTue = Date.parse('2026-08-25T17:14:00Z');
  // Cooperativas en la praxis — 8:00 PM CDMX Tue 25 = 02:00Z Wed 26.
  const coop8pm = Date.parse('2026-08-26T02:00:00Z');
  // Club de poesía Cortázar — 8:00 PM CDMX Wed 26.
  const poetry8pm = Date.parse('2026-08-27T02:00:00Z');

  test('an 8pm CDMX event is still today even though start_at_iso is the next UTC date', () => {
    expect(localDateKey(noonTue)).toBe('2026-08-25');
    expect(localDateKey(coop8pm)).toBe('2026-08-25');
    expect(relativeLocalDay(coop8pm, noonTue)).toBe('hoy');
    expect(relativeLocalDay(poetry8pm, noonTue)).toBe('mañana');
  });

  test('evening CDMX is still today when UTC has already rolled to the next date', () => {
    // 7:00 PM CDMX Tue 25 = 01:00Z Wed 26.
    const sevenPm = Date.parse('2026-08-26T01:00:00Z');
    expect(localDateKey(sevenPm)).toBe('2026-08-25');
    expect(relativeLocalDay(coop8pm, sevenPm)).toBe('hoy');
  });
});

describe('renderTemporalAwareness', () => {
  test('names hoy/mañana by local date, not UTC-6-minus-a-day (live 2026-08-25 #general)', () => {
    // 11:14 AM CDMX Tuesday 25 — the UTC timestamp is 17:14 the same day, so a
    // model that "subtracts a day because UTC-6" would call today Monday 24.
    const block = renderTemporalAwareness(new Date('2026-08-25T17:14:00Z'));
    expect(block).toContain('2026-08-25T17:14:00.000Z');
    expect(block).toMatch(/\*\*Hoy es .+\*\* \(fecha local `2026-08-25`\)/);
    expect(block).toMatch(/\*\*Mañana es .+\*\* \(`2026-08-26`\)/);
    expect(block).toMatch(/Ayer fue .+\(`2026-08-24`\)/);
    expect(block.toLowerCase()).toContain('martes');
    expect(block.toLowerCase()).toContain('miércoles');
    expect(block).not.toMatch(/\*\*Hoy es .*\(`2026-08-24`\)/);
  });

  test('an evening UTC date still prints the previous local weekday', () => {
    // 8:00 PM CDMX Tue 25 = 02:00Z Wed 26. UTC date is Wednesday; local is Tuesday.
    const block = renderTemporalAwareness(new Date('2026-08-26T02:00:00Z'));
    expect(block).toContain('`2026-08-25`');
    expect(block.toLowerCase()).toContain('martes');
    expect(block).toMatch(/\*\*Mañana es .*\(`2026-08-26`\)/);
  });
});
