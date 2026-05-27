import { describe, test, expect } from 'vitest';
import { formatEventWhen, formatPostedAt } from '../format.js';

// Reference "now" inside 2026 so the year is omitted for 2026 dates.
const NOW_2026 = Date.UTC(2026, 4, 27, 12, 0, 0);

describe('formatEventWhen', () => {
  test('renders datetime with offset, preserving the stated wall-clock', () => {
    expect(formatEventWhen('2026-05-26T16:00:00-05:00', NOW_2026)).toBe(
      'martes 26 de mayo, 16:00 h',
    );
  });

  test('ignores the offset (no time-zone conversion)', () => {
    // Same wall-clock, different offset -> identical output.
    expect(formatEventWhen('2026-05-26T16:00:00-06:00', NOW_2026)).toBe(
      'martes 26 de mayo, 16:00 h',
    );
  });

  test('date-only input omits the time', () => {
    expect(formatEventWhen('2026-05-30', NOW_2026)).toBe('sábado 30 de mayo');
  });

  test('includes the year when it differs from the current year', () => {
    expect(formatEventWhen('2027-01-01T09:00', NOW_2026)).toBe(
      'viernes 1 de enero de 2027, 09:00 h',
    );
  });

  test('accepts a space separator and trailing Z', () => {
    expect(formatEventWhen('2026-05-26 16:00:00Z', NOW_2026)).toBe(
      'martes 26 de mayo, 16:00 h',
    );
  });

  test('returns the trimmed input verbatim when it is not a date', () => {
    expect(formatEventWhen('  el próximo sábado  ', NOW_2026)).toBe('el próximo sábado');
  });

  test('rejects an out-of-range month rather than mangling it', () => {
    expect(formatEventWhen('2026-13-01', NOW_2026)).toBe('2026-13-01');
  });
});

describe('formatPostedAt', () => {
  test('converts a UTC instant to Mexico City time (UTC-6)', () => {
    // 2026-05-25T20:31:03Z -> 14:31 in CDMX.
    const ms = Date.UTC(2026, 4, 25, 20, 31, 3);
    expect(formatPostedAt(ms)).toBe('25 may 2026, 14:31');
  });

  test('handles a day rollback across the UTC boundary', () => {
    // 2026-05-26T02:00:00Z -> 2026-05-25 20:00 in CDMX.
    const ms = Date.UTC(2026, 4, 26, 2, 0, 0);
    expect(formatPostedAt(ms)).toBe('25 may 2026, 20:00');
  });
});
