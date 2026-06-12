import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBootAndDetectCrash,
  markCleanShutdown,
  CRASH_ALERT_MIN_INTERVAL_MS,
} from '../lifecycle.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chopperbot-lifecycle-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;

describe('crash-restart detection', () => {
  test('first boot ever is not a crash', () => {
    expect(checkBootAndDetectCrash(dir, T0)).toEqual({ crashed: false, suppressAlert: false });
  });

  test('boot after a clean shutdown is not a crash, and consumes the marker', () => {
    checkBootAndDetectCrash(dir, T0);
    markCleanShutdown(dir);
    expect(checkBootAndDetectCrash(dir, T0 + 60_000)).toEqual({
      crashed: false,
      suppressAlert: false,
    });
    expect(existsSync(join(dir, '.shutdown-clean'))).toBe(false);
  });

  test('boot with no clean marker after a previous boot is a crash', () => {
    checkBootAndDetectCrash(dir, T0);
    // no markCleanShutdown — previous run "died"
    const r = checkBootAndDetectCrash(dir, T0 + CRASH_ALERT_MIN_INTERVAL_MS + 1);
    expect(r.crashed).toBe(true);
    expect(r.suppressAlert).toBe(false);
  });

  test('crashloop: rapid re-boots suppress the alert but still report the crash', () => {
    checkBootAndDetectCrash(dir, T0);
    const r = checkBootAndDetectCrash(dir, T0 + 30_000); // 30s later — crashloop
    expect(r.crashed).toBe(true);
    expect(r.suppressAlert).toBe(true);
  });

  test('clean marker only covers one boot: clean restart, then crash, is detected', () => {
    checkBootAndDetectCrash(dir, T0);
    markCleanShutdown(dir);
    checkBootAndDetectCrash(dir, T0 + 60_000); // clean restart (consumes marker)
    const r = checkBootAndDetectCrash(dir, T0 + 60_000 + CRASH_ALERT_MIN_INTERVAL_MS + 1);
    expect(r.crashed).toBe(true);
    expect(r.suppressAlert).toBe(false);
  });
});
