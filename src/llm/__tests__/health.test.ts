import { describe, test, expect } from 'vitest';
import {
  LlmHealthMonitor,
  classifyLlmError,
  isContentFilterRejection,
  ALERT_COOLDOWN_MS,
  TRANSIENT_ALERT_THRESHOLD,
} from '../health.js';

function apiError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** The exact error Moonshot returned on 2026-08-06 for a political question. */
function highRiskError(): Error {
  const err = apiError(400, '400 The request was rejected because it was considered high risk') as
    Error & { status: number; param: string; code: number };
  err.param = 'prompt';
  err.code = 400;
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

  test('a provider moderation refusal is its own kind, not a config error', () => {
    // The 2026-08-06 incident: classifying this as deterministic paged the
    // admin channel with "no se va a resolver solo" while the backend was fine.
    expect(classifyLlmError(highRiskError())).toBe('content_filter');
    expect(isContentFilterRejection(highRiskError())).toBe(true);
    expect(classifyLlmError(apiError(403, 'blocked by the safety system'))).toBe('content_filter');
    expect(classifyLlmError(apiError(400, 'content_filter triggered'))).toBe('content_filter');
  });

  test('genuine bad-parameter 4xx keep their deterministic classification', () => {
    // The match must stay narrow: these are real config breakage and must keep
    // paging on the first failure.
    expect(classifyLlmError(apiError(400, 'invalid temperature: only 1 is allowed'))).toBe(
      'deterministic',
    );
    expect(classifyLlmError(apiError(401, 'Invalid Authentication'))).toBe('deterministic');
    expect(
      classifyLlmError(apiError(403, 'Kimi For Coding is currently only available for Coding Agents')),
    ).toBe('deterministic');
    expect(isContentFilterRejection(apiError(429, 'high risk of throttling'))).toBe(false);
    expect(isContentFilterRejection(apiError(500, 'content filter service down'))).toBe(false);
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

  test('a content-filter rejection never alerts and never touches the health state', () => {
    const { monitor, alerts } = harness();
    for (let i = 1; i <= TRANSIENT_ALERT_THRESHOLD + 2; i++) {
      monitor.reportFailure(highRiskError(), i * 1_000);
    }
    expect(alerts).toHaveLength(0);
    const snap = monitor.snapshot();
    expect(snap.consecutive_failures).toBe(0);
    expect(snap.degraded).toBe(false);
    expect(snap.content_filter_rejections).toBe(TRANSIENT_ALERT_THRESHOLD + 2);
    expect(snap.last_content_filter_error).toContain('high risk');
    // …and it must not arm the recovery notice on the next ordinary reply,
    // which is how "🚨 config error" + "✅ LLM recuperado" both fired for a
    // single moderated prompt on 2026-08-06.
    monitor.reportSuccess();
    expect(alerts).toHaveLength(0);
  });

  test('moderated prompts do not mask a real failure streak', () => {
    const { monitor, alerts } = harness();
    monitor.reportFailure(apiError(500, 'a'), 1_000);
    monitor.reportFailure(highRiskError(), 2_000); // must not reset the streak
    monitor.reportFailure(apiError(500, 'b'), 3_000);
    monitor.reportFailure(apiError(500, 'c'), 4_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].join('\n')).toContain('transitorio');
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
