import { describe, test, expect } from 'vitest';
import {
  formatEventWhen,
  formatPostedAt,
  formatDurationEs,
  formatAgeEs,
  formatStatusDigest,
} from '../format.js';
import type { MonitoredAccount, RuntimeState } from '../store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function runtime(p: Partial<RuntimeState> = {}): RuntimeState {
  return {
    global_stop: 0,
    stop_reason: null,
    stopped_at: null,
    recent_auth_json: null,
    recent_429_json: null,
    auth_cooldown_until: null,
    rate_cooldown_until: null,
    budget_pause_until: null,
    requests_24h: 0,
    heartbeat_at: null,
    poll_stretch: 1,
    last_digest_at: null,
    ...p,
  };
}

function account(p: Partial<MonitoredAccount> = {}): MonitoredAccount {
  return {
    id: 1,
    username: 'cuenta',
    added_by: 'U',
    added_at: 0,
    paused: 0,
    last_polled_at: null,
    last_post_id: null,
    last_post_at: null,
    consecutive_failures: 0,
    consecutive_auth_failures: 0,
    poll_interval_ms: null,
    posts_per_day: null,
    cadence_updated_at: null,
    ...p,
  };
}

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

describe('formatDurationEs', () => {
  test('renders up to two units', () => {
    expect(formatDurationEs(45 * MIN)).toBe('45 min');
    expect(formatDurationEs(2 * HOUR + 14 * MIN)).toBe('2 h 14 min');
    expect(formatDurationEs(3 * DAY + 5 * HOUR)).toBe('3 d 5 h');
    expect(formatDurationEs(20_000)).toBe('menos de 1 min');
  });
});

describe('formatAgeEs', () => {
  test('compact age buckets', () => {
    expect(formatAgeEs(45 * MIN)).toBe('45m');
    expect(formatAgeEs(3 * HOUR)).toBe('3h');
    expect(formatAgeEs(2 * DAY)).toBe('2d');
    expect(formatAgeEs(20_000)).toBe('<1m');
  });
});

describe('formatStatusDigest', () => {
  const now = Date.UTC(2026, 4, 30, 18, 0, 0);

  test('degrades gracefully when cadence columns are null', () => {
    const text = formatStatusDigest({
      runtime: runtime({ requests_24h: 10 }),
      accounts: [account({ username: 'foo', last_polled_at: now - 30 * MIN })],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(text).toContain('?'); // unknown cadence
    expect(text).toContain('60m'); // falls back to the default interval
    expect(text).not.toContain('NaN');
    expect(text).toContain('sondeando con normalidad');
  });

  test('renders learned cadence + budget headroom', () => {
    const text = formatStatusDigest({
      runtime: runtime({ requests_24h: 80 }),
      accounts: [
        account({
          username: 'activa',
          posts_per_day: 4,
          poll_interval_ms: 3 * HOUR,
          last_post_at: now - 2 * HOUR,
          last_polled_at: now - 30 * MIN,
        }),
      ],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(text).toContain('4.0/d'); // posts_per_day
    expect(text).toContain('margen 40'); // 120 - 80
  });

  test('state line reflects kill-switch and budget pause', () => {
    const stopped = formatStatusDigest({
      runtime: runtime({ global_stop: 1, stop_reason: 'IG flagged session' }),
      accounts: [],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(stopped).toContain('🔴 DETENIDO');
    expect(stopped).toContain('IG flagged session');

    const paused = formatStatusDigest({
      runtime: runtime({ budget_pause_until: now + 3 * HOUR, requests_24h: 120 }),
      accounts: [],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(paused).toContain('🟡 pausado');
    expect(paused).toContain('presupuesto');
    expect(paused).toContain('sin margen');
  });

  test('governor stretch line appears only when > 1', () => {
    const withStretch = formatStatusDigest({
      runtime: runtime({ poll_stretch: 1.5 }),
      accounts: [],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(withStretch).toContain('Ajuste de presupuesto');
    const without = formatStatusDigest({
      runtime: runtime({ poll_stretch: 1 }),
      accounts: [],
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(without).not.toContain('Ajuste de presupuesto');
  });

  test('stays under 2000 chars and truncates with a +N tail', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      account({
        id: i + 1,
        username: `cuenta_numero_${i}`,
        posts_per_day: 1,
        poll_interval_ms: HOUR,
        last_polled_at: now - i * MIN,
      }),
    );
    const text = formatStatusDigest({
      runtime: runtime({ requests_24h: 50 }),
      accounts: many,
      dailyRequestBudget: 120,
      defaultPollIntervalMs: HOUR,
      nowMs: now,
    }).join('\n');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/y \d+ cuentas más/);
  });
});
