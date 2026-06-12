import { describe, test, expect } from 'vitest';
import {
  LlmHealthMonitor,
  classifyLlmError,
  ALERT_COOLDOWN_MS,
  TRANSIENT_ALERT_THRESHOLD,
} from '../health.js';

function apiError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function harness() {
  const monitor = new LlmHealthMonitor();
  const alerts: string[][] = [];
  monitor.setSink(async (lines) => {
    alerts.push(lines);
  });
  return { monitor, alerts };
}

describe('classifyLlmError', () => {
  test('protocol/config 4xx are deterministic', () => {
    expect(classifyLlmError(apiError(400, 'invalid temperature'))).toBe('deterministic');
    expect(classifyLlmError(apiError(401, 'bad key'))).toBe('deterministic');
    expect(classifyLlmError(apiError(403, 'UA gated'))).toBe('deterministic');
    expect(classifyLlmError(apiError(404, 'no such model'))).toBe('deterministic');
  });

  test('throttle, server errors, and network errors are transient', () => {
    expect(classifyLlmError(apiError(429, 'rate limited'))).toBe('transient');
    expect(classifyLlmError(apiError(500, 'oops'))).toBe('transient');
    expect(classifyLlmError(apiError(408, 'timeout'))).toBe('transient');
    expect(classifyLlmError(new Error('ECONNRESET'))).toBe('transient'); // no .status
  });
});

describe('LlmHealthMonitor', () => {
  test('deterministic error alerts on the FIRST failure (the temperature case)', () => {
    const { monitor, alerts } = harness();
    monitor.reportFailure(apiError(400, '400 invalid temperature: only 1 is allowed'), 1_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].join('\n')).toContain('invalid temperature');
    expect(alerts[0].join('\n')).toContain('no se va a resolver solo');
  });

  test('transient errors alert only at the consecutive threshold', () => {
    const { monitor, alerts } = harness();
    for (let i = 1; i < TRANSIENT_ALERT_THRESHOLD; i++) {
      monitor.reportFailure(apiError(429, 'throttled'), i * 1_000);
    }
    expect(alerts).toHaveLength(0);
    monitor.reportFailure(apiError(429, 'throttled'), TRANSIENT_ALERT_THRESHOLD * 1_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].join('\n')).toContain('transitorio');
  });

  test('a success resets the consecutive-failure counter', () => {
    const { monitor, alerts } = harness();
    monitor.reportFailure(apiError(500, 'a'), 1_000);
    monitor.reportFailure(apiError(500, 'b'), 2_000);
    monitor.reportSuccess();
    monitor.reportFailure(apiError(500, 'c'), 3_000);
    monitor.reportFailure(apiError(500, 'd'), 4_000);
    expect(alerts).toHaveLength(0); // never reached 3 consecutive
  });

  test('failure alerts are rate-limited to one per cooldown window', () => {
    const { monitor, alerts } = harness();
    monitor.reportFailure(apiError(400, 'first'), 1_000);
    monitor.reportFailure(apiError(400, 'second'), 2_000);
    monitor.reportFailure(apiError(400, 'third'), ALERT_COOLDOWN_MS / 2);
    expect(alerts).toHaveLength(1);
    monitor.reportFailure(apiError(400, 'fourth'), 1_000 + ALERT_COOLDOWN_MS + 1);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].join('\n')).toContain('fourth');
  });

  test('recovery notice fires once after an alerted outage, and only then', () => {
    const { monitor, alerts } = harness();
    monitor.reportSuccess(); // healthy → no notice
    expect(alerts).toHaveLength(0);
    monitor.reportFailure(apiError(429, 'x'), 1_000); // below threshold → no alert
    monitor.reportSuccess(); // un-alerted blip → no notice
    expect(alerts).toHaveLength(0);
    monitor.reportFailure(apiError(400, 'broken'), 2_000); // alert #1
    monitor.reportSuccess(); // recovery #2
    monitor.reportSuccess(); // no duplicate
    expect(alerts).toHaveLength(2);
    expect(alerts[1].join('\n')).toContain('recuperado');
  });

  test('a rejecting or missing sink never throws into the caller', () => {
    const monitor = new LlmHealthMonitor();
    expect(() => monitor.reportFailure(apiError(400, 'no sink'), 1_000)).not.toThrow();
    monitor.setSink(async () => {
      throw new Error('discord down');
    });
    expect(() =>
      monitor.reportFailure(apiError(400, 'sink rejects'), ALERT_COOLDOWN_MS * 2),
    ).not.toThrow();
    expect(() => monitor.reportSuccess()).not.toThrow();
  });
});
