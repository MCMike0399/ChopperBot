import { existsSync, statSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Crash-restart detection via filesystem markers in the data dir.
 *
 * The clean-shutdown paths (SIGINT/SIGTERM — i.e. `systemctl --user restart/
 * stop`, Ctrl-C) write `.shutdown-clean` before exiting. At boot we check:
 * if the bot has booted before but no clean marker exists, the previous
 * process died without running its shutdown handler (crash, OOM/SIGKILL,
 * `process.exit` from a fatal) — systemd's `Restart=always` brought us back,
 * and the operator should hear about it in the config channel, because on a
 * headless Pi nothing else surfaces it.
 *
 * Crashloop debounce: `.boot-stamp`'s mtime is the previous boot time. If the
 * previous boot was under `minAlertIntervalMs` ago we still report the crash
 * (for the log line) but suppress the Discord alert, so a crashloop posts at
 * most ~1 alert per window instead of one per restart (systemd's own guard
 * caps the loop at 10 restarts / 5 min anyway).
 */
const CLEAN_MARKER = '.shutdown-clean';
const BOOT_STAMP = '.boot-stamp';

export const CRASH_ALERT_MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface BootCrashCheck {
  /** Previous run ended without a clean shutdown. */
  crashed: boolean;
  /** Crash detected but the previous boot was too recent — likely a crashloop;
   * skip the Discord alert. */
  suppressAlert: boolean;
}

/** Call once at boot, BEFORE installing shutdown handlers. Consumes the clean
 * marker and refreshes the boot stamp as side effects. */
export function checkBootAndDetectCrash(
  dataDir: string,
  nowMs = Date.now(),
  minAlertIntervalMs = CRASH_ALERT_MIN_INTERVAL_MS,
): BootCrashCheck {
  const cleanPath = resolve(dataDir, CLEAN_MARKER);
  const stampPath = resolve(dataDir, BOOT_STAMP);

  const bootedBefore = existsSync(stampPath);
  const wasClean = existsSync(cleanPath);
  const prevBootMs = bootedBefore ? statSync(stampPath).mtimeMs : 0;

  if (wasClean) unlinkSync(cleanPath);
  writeFileSync(stampPath, new Date(nowMs).toISOString());
  // writeFileSync sets mtime to the real clock; pin it to nowMs so the
  // debounce is deterministic under injected time (tests).
  utimesSync(stampPath, nowMs / 1000, nowMs / 1000);

  const crashed = bootedBefore && !wasClean;
  return {
    crashed,
    suppressAlert: crashed && nowMs - prevBootMs < minAlertIntervalMs,
  };
}

/** Call from the SIGINT/SIGTERM shutdown path, before process.exit. */
export function markCleanShutdown(dataDir: string): void {
  writeFileSync(resolve(dataDir, CLEAN_MARKER), new Date().toISOString());
}
