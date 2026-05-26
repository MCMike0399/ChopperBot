import { describe, test, expect } from 'vitest';
import { formatInTimezone } from '../time.js';

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
