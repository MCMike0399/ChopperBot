import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';

/** A file's malicious/suspicious/harmless/undetected engine counts. */
export interface VerdictStats {
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  /** Total engines that returned a categorized result (mal+susp+harm+undet). */
  total: number;
}

export type Verdict = 'clean' | 'suspicious' | 'malicious';

/** A cached scan result, keyed by the file's SHA-256. */
export interface ScanRecord {
  sha256: string;
  file_name: string | null;
  size: number | null;
  verdict: Verdict;
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  stats_json: string | null;
  first_seen_at: number;
  last_seen_at: number;
  scan_count: number;
  last_uploader: string | null;
}

/** Single-row runtime state (id=1): the rolling request-time window + alert dedup. */
export interface FileScannerRuntime {
  request_times_json: string | null;
  last_budget_alert_at: number | null;
  updated_at: number | null;
}

export const FILE_SCANNER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      -- Single-row settings (id=1): which channels the passive watcher scans.
      CREATE TABLE IF NOT EXISTS file_scanner_settings (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        watched_channels_json TEXT   NOT NULL DEFAULT '[]',
        updated_at           INTEGER
      );
      INSERT OR IGNORE INTO file_scanner_settings (id, watched_channels_json) VALUES (1, '[]');

      -- Single-row runtime (id=1): rolling-24h VT request timestamps + alert dedup.
      CREATE TABLE IF NOT EXISTS file_scanner_runtime (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        request_times_json   TEXT,
        last_budget_alert_at INTEGER,
        updated_at           INTEGER
      );
      INSERT OR IGNORE INTO file_scanner_runtime (id, request_times_json) VALUES (1, '[]');

      -- Verdict cache + audit log, keyed by file SHA-256. Doubles as an instant
      -- local lookup so a re-uploaded known file skips VirusTotal entirely.
      CREATE TABLE IF NOT EXISTS file_scanner_scans (
        sha256        TEXT    PRIMARY KEY,
        file_name     TEXT,
        size          INTEGER,
        verdict       TEXT    NOT NULL,
        malicious     INTEGER NOT NULL DEFAULT 0,
        suspicious    INTEGER NOT NULL DEFAULT 0,
        harmless      INTEGER NOT NULL DEFAULT 0,
        undetected    INTEGER NOT NULL DEFAULT 0,
        stats_json    TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        scan_count    INTEGER NOT NULL DEFAULT 1,
        last_uploader TEXT
      );
      CREATE INDEX IF NOT EXISTS file_scanner_scans_last_seen
        ON file_scanner_scans (last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS file_scanner_scans_verdict
        ON file_scanner_scans (verdict, last_seen_at DESC);
    `,
  },
];

/**
 * SQLite-backed state for the file scanner: which channels are watched, the
 * persistent rolling-24h VirusTotal request budget (survives restarts), and a
 * verdict cache keyed by file hash.
 *
 * All methods are synchronous (better-sqlite3) and safe to call from the
 * Discord message listener and the admin tools on the shared db handle.
 */
export class FileScannerStore {
  constructor(private readonly db: Database.Database) {}

  // ── Watched channels ──────────────────────────────────────────────────────

  getWatchedChannels(): string[] {
    const row = this.db
      .prepare('SELECT watched_channels_json FROM file_scanner_settings WHERE id = 1')
      .get() as { watched_channels_json: string } | undefined;
    return parseIdArray(row?.watched_channels_json);
  }

  setWatchedChannels(ids: string[]): void {
    const clean = dedupeIds(ids);
    this.db
      .prepare(
        'UPDATE file_scanner_settings SET watched_channels_json = ?, updated_at = ? WHERE id = 1',
      )
      .run(JSON.stringify(clean), Date.now());
  }

  /**
   * One-time seed from the env var on first boot: only writes if no channels
   * have been configured yet, so an operator's later edits from the config
   * channel are never clobbered by a restart. Mirrors the calendar
   * output-channel seeding pattern.
   */
  seedWatchedChannels(ids: string[]): void {
    if (ids.length === 0) return;
    if (this.getWatchedChannels().length > 0) return;
    this.setWatchedChannels(ids);
  }

  // ── Rolling request budget (persistent) ─────────────────────────────────────

  getRuntime(): FileScannerRuntime {
    return this.db
      .prepare(
        'SELECT request_times_json, last_budget_alert_at, updated_at FROM file_scanner_runtime WHERE id = 1',
      )
      .get() as FileScannerRuntime;
  }

  /** Count of VT requests recorded within `windowMs` before `nowMs`. */
  requestsInWindow(nowMs: number, windowMs: number): number {
    return this.prunedTimes(nowMs, windowMs).length;
  }

  /**
   * Atomically try to reserve one request slot against the rolling budget. If
   * the count within the window is below `budget`, record `nowMs` and return
   * true; otherwise leave state untouched and return false. This is the single
   * gate every outbound VirusTotal call passes through.
   */
  tryConsumeBudget(nowMs: number, budget: number, windowMs: number): boolean {
    const times = this.prunedTimes(nowMs, windowMs);
    if (times.length >= budget) {
      // Persist the pruned window even on rejection so it doesn't grow stale.
      this.writeTimes(times, nowMs);
      return false;
    }
    times.push(nowMs);
    this.writeTimes(times, nowMs);
    return true;
  }

  /** Records that a budget-exhausted alert was sent (for 1-per-window dedup). */
  markBudgetAlert(nowMs: number): void {
    this.db
      .prepare('UPDATE file_scanner_runtime SET last_budget_alert_at = ?, updated_at = ? WHERE id = 1')
      .run(nowMs, nowMs);
  }

  private prunedTimes(nowMs: number, windowMs: number): number[] {
    const rt = this.getRuntime();
    const cutoff = nowMs - windowMs;
    return parseNumberArray(rt.request_times_json).filter((t) => t > cutoff);
  }

  private writeTimes(times: number[], nowMs: number): void {
    this.db
      .prepare('UPDATE file_scanner_runtime SET request_times_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(times), nowMs);
  }

  // ── Verdict cache / audit ───────────────────────────────────────────────────

  getScan(sha256: string): ScanRecord | undefined {
    return this.db
      .prepare('SELECT * FROM file_scanner_scans WHERE sha256 = ?')
      .get(sha256) as ScanRecord | undefined;
  }

  /**
   * Upsert a verdict for a hash: inserts on first sight, otherwise refreshes the
   * counts + bumps `scan_count`/`last_seen_at` (a re-uploaded file re-verifies).
   */
  recordScan(input: {
    sha256: string;
    fileName: string | null;
    size: number | null;
    verdict: Verdict;
    stats: VerdictStats;
    uploader: string | null;
    nowMs: number;
  }): void {
    const { sha256, fileName, size, verdict, stats, uploader, nowMs } = input;
    this.db
      .prepare(
        `INSERT INTO file_scanner_scans
           (sha256, file_name, size, verdict, malicious, suspicious, harmless, undetected,
            stats_json, first_seen_at, last_seen_at, scan_count, last_uploader)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(sha256) DO UPDATE SET
           file_name     = excluded.file_name,
           size          = excluded.size,
           verdict       = excluded.verdict,
           malicious     = excluded.malicious,
           suspicious    = excluded.suspicious,
           harmless      = excluded.harmless,
           undetected    = excluded.undetected,
           stats_json    = excluded.stats_json,
           last_seen_at  = excluded.last_seen_at,
           scan_count    = file_scanner_scans.scan_count + 1,
           last_uploader = excluded.last_uploader`,
      )
      .run(
        sha256,
        fileName,
        size,
        verdict,
        stats.malicious,
        stats.suspicious,
        stats.harmless,
        stats.undetected,
        JSON.stringify(stats),
        nowMs,
        nowMs,
        uploader,
      );
  }

  recentScans(limit: number): ScanRecord[] {
    return this.db
      .prepare('SELECT * FROM file_scanner_scans ORDER BY last_seen_at DESC LIMIT ?')
      .all(limit) as ScanRecord[];
  }

  /** { total, malicious, suspicious, clean } counts across the cache. */
  verdictCounts(): { total: number; malicious: number; suspicious: number; clean: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(verdict = 'malicious')  AS malicious,
           SUM(verdict = 'suspicious') AS suspicious,
           SUM(verdict = 'clean')      AS clean
         FROM file_scanner_scans`,
      )
      .get() as { total: number; malicious: number | null; suspicious: number | null; clean: number | null };
    return {
      total: row.total,
      malicious: row.malicious ?? 0,
      suspicious: row.suspicious ?? 0,
      clean: row.clean ?? 0,
    };
  }
}

/** Parse a JSON array of numbers, tolerating null/garbage → []. */
function parseNumberArray(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Parse a JSON array of channel-id strings, tolerating null/garbage → []. */
function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}

/**
 * Parse the FILE_SCANNER_CHANNEL_IDS env var, which may be a JSON array
 * (`["123","456"]`) or a comma/space-separated list of snowflakes.
 */
export function parseChannelIdEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return dedupeIds(arr.map((x) => String(x)));
    } catch {
      // fall through to delimiter parsing
    }
  }
  return dedupeIds(trimmed.split(/[,\s]+/));
}
