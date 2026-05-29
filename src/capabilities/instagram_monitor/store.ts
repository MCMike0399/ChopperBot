import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';

/**
 * Monitored Instagram account. Accounts are GLOBAL — there is one row per
 * username, and posts are fanned out at detection time to every channel
 * currently bound to the `instagram_monitor` capability.
 *
 * Dedup is still per-channel (see {@link SeenPost} below), so a channel
 * bound after the account already has post history sees only newly-detected
 * posts (no backfill).
 */
export interface MonitoredAccount {
  id: number;
  username: string;
  /** Discord user who first added this account. Kept for audit, never used for filtering. */
  added_by: string;
  added_at: number;
  paused: number;
  last_polled_at: number | null;
  last_post_id: string | null;
  /**
   * Capture time (`takenAtMs`) of the post `last_post_id` points at. The dedup
   * anchor's *timestamp*, not just its id. Used to gate detection by time when
   * IG returns a window that omits the anchor post, and to guarantee the anchor
   * never moves backward in time. Null only for fresh/legacy rows.
   */
  last_post_at: number | null;
  consecutive_failures: number;
  /**
   * Auth-class failures (IG session bad / checkpoint / challenge) in a row.
   * Reset on any successful poll, and also on `clearFailureBackoff()` at
   * scheduler start so a freshly-restarted bot retries immediately after the
   * operator refreshes cookies. Used by {@link InstagramMonitorStore.dueAccounts}
   * as a hard gate — accounts with ≥ {@link AUTH_PAUSE_THRESHOLD} are skipped
   * entirely (no more "marching into a wall" once IG has flagged the session).
   * Separate from `consecutive_failures` so a transient DNS hiccup doesn't
   * trip the auto-pause.
   */
  consecutive_auth_failures: number;
}

export interface SeenPost {
  ig_post_id: string;
  account_username: string;
  channel_id: string;
  caption: string | null;
  media_type: string | null;
  posted_at: number | null;
  detected_at: number;
  classification_json: string | null;
  pushed: number;
  discord_message_id: string | null;
}

/**
 * Global runtime/circuit-breaker state (one row, id=1). Shared between the
 * scheduler (writes the breaker + heartbeat) and the admin tool (reads for the
 * `status` action, clears the breaker via `resume_monitor`).
 */
export interface RuntimeState {
  global_stop: number;
  stop_reason: string | null;
  stopped_at: number | null;
  recent_auth_json: string | null;
  recent_429_json: string | null;
  auth_cooldown_until: number | null;
  rate_cooldown_until: number | null;
  budget_pause_until: number | null;
  requests_24h: number | null;
  heartbeat_at: number | null;
}

export const INSTAGRAM_MONITOR_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS instagram_monitor_accounts (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id            TEXT    NOT NULL,
        username              TEXT    NOT NULL,
        added_by              TEXT    NOT NULL,
        added_at              INTEGER NOT NULL,
        paused                INTEGER NOT NULL DEFAULT 0,
        last_polled_at        INTEGER,
        last_post_id          TEXT,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (channel_id, username)
      );
      CREATE INDEX IF NOT EXISTS instagram_monitor_accounts_channel
        ON instagram_monitor_accounts (channel_id, paused);

      CREATE TABLE IF NOT EXISTS instagram_monitor_seen_posts (
        ig_post_id           TEXT    NOT NULL,
        account_username     TEXT    NOT NULL,
        channel_id           TEXT    NOT NULL,
        caption              TEXT,
        media_type           TEXT,
        posted_at            INTEGER,
        detected_at          INTEGER NOT NULL,
        classification_json  TEXT,
        pushed               INTEGER NOT NULL DEFAULT 0,
        discord_message_id   TEXT,
        PRIMARY KEY (ig_post_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS instagram_monitor_seen_posts_account_time
        ON instagram_monitor_seen_posts (account_username, detected_at DESC);
      CREATE INDEX IF NOT EXISTS instagram_monitor_seen_posts_channel_pushed_time
        ON instagram_monitor_seen_posts (channel_id, pushed, detected_at DESC);
    `,
  },
  {
    // v2 — accounts go GLOBAL. Drop channel_id from the accounts table.
    // Existing rows are deduped by username, keeping the earliest add
    // (preserves added_by + last_post_id of whoever set it up first).
    // seen_posts stays per-channel — that's the dedup substrate for
    // fan-out, and it's what gives "new channel binding gets no backfill".
    version: 2,
    up: `
      CREATE TABLE instagram_monitor_accounts_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        username              TEXT    NOT NULL,
        added_by              TEXT    NOT NULL,
        added_at              INTEGER NOT NULL,
        paused                INTEGER NOT NULL DEFAULT 0,
        last_polled_at        INTEGER,
        last_post_id          TEXT,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (username)
      );

      INSERT OR IGNORE INTO instagram_monitor_accounts_new
        (username, added_by, added_at, paused, last_polled_at, last_post_id, consecutive_failures)
      SELECT username, added_by, added_at, paused, last_polled_at, last_post_id, consecutive_failures
      FROM instagram_monitor_accounts
      ORDER BY added_at ASC, id ASC;

      DROP TABLE instagram_monitor_accounts;
      ALTER TABLE instagram_monitor_accounts_new RENAME TO instagram_monitor_accounts;

      CREATE INDEX IF NOT EXISTS instagram_monitor_accounts_paused
        ON instagram_monitor_accounts (paused);
    `,
  },
  {
    // v3 — record the dedup anchor's capture time alongside its id.
    //
    // The old detection walked the fetched feed until it hit the anchor *id*
    // and treated everything above it as new. That breaks catastrophically
    // when IG returns a stale/paginated window that OMITS the anchor post:
    // the walk never finds it, classifies the entire (old) batch as new, and
    // backfills weeks-old posts — and `markPollSuccess` then moves the anchor
    // BACKWARD to that batch's (older) newest. Tracking the anchor's timestamp
    // lets the scheduler time-gate the anchor-missing case and refuse to
    // regress the anchor.
    //
    // Backfill from each account's newest already-seen post so existing rows
    // get a correct anchor time immediately (accounts with no seen history
    // stay NULL → the scheduler re-seeds them without backfilling).
    version: 3,
    up: `
      ALTER TABLE instagram_monitor_accounts ADD COLUMN last_post_at INTEGER;

      UPDATE instagram_monitor_accounts
        SET last_post_at = (
          SELECT MAX(s.posted_at)
          FROM instagram_monitor_seen_posts s
          WHERE s.account_username = instagram_monitor_accounts.username
        );
    `,
  },
  {
    // v4 — auth-class failure counter, separate from general `consecutive_failures`.
    // Lets the scheduler distinguish "the IG session is dead" from "the network
    // burped" so we can auto-stop polling a checkpointed session without also
    // shutting things down on a transient DNS hiccup.
    version: 4,
    up: `
      ALTER TABLE instagram_monitor_accounts
        ADD COLUMN consecutive_auth_failures INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v5 — global runtime state, separate from the per-account table.
    //
    // A single row (id=1) holding the PERSISTENT circuit-breaker / kill-switch
    // (`global_stop`). This deliberately lives in its own table because
    // `clearFailureBackoff()` (run on every scheduler start) zeroes the
    // per-account failure counters — but a tripped breaker MUST survive a
    // restart (otherwise restarting the service would silently un-stop a
    // monitor that IG just flagged). The scheduler reads `global_stop` first
    // thing each tick and only the admin `resume_monitor` action clears it.
    //
    // The `recent_*_json` columns hold windowed event timestamps the breaker
    // uses to decide when to trip (e.g. ≥2 throttles in 6h). The heartbeat
    // columns are written by the scheduler each tick so the admin `status`
    // tool can observe the scheduler's in-memory cooldowns and 24h request
    // count (which live in a different object it can't reach directly).
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS instagram_monitor_runtime (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        global_stop          INTEGER NOT NULL DEFAULT 0,
        stop_reason          TEXT,
        stopped_at           INTEGER,
        recent_auth_json     TEXT,
        recent_429_json      TEXT,
        auth_cooldown_until  INTEGER,
        rate_cooldown_until  INTEGER,
        budget_pause_until   INTEGER,
        requests_24h         INTEGER,
        heartbeat_at         INTEGER
      );
      INSERT OR IGNORE INTO instagram_monitor_runtime (id, global_stop) VALUES (1, 0);
    `,
  },
];

/** Window over which the circuit breaker counts soft-block events (6h). */
export const EVENT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Threshold of consecutive auth-class failures (per account) at which
 * {@link InstagramMonitorStore.dueAccounts} stops returning the account. Reset
 * on any successful poll, and zeroed by `clearFailureBackoff()` on scheduler
 * start, so the operator's "refresh cookies + restart" flow re-enables polling
 * with zero per-account toggling.
 */
export const AUTH_PAUSE_THRESHOLD = 5;

/** Backoff: next allowed poll is min(POLL_INTERVAL * 2^failures, MAX_BACKOFF). */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Per-account jitter in [0, maxJitterMs). Added to an account's next-due time
 * so polls scatter irregularly across the interval instead of marching in
 * lockstep — anti-bot signal vs. IG's pattern detectors.
 *
 * Truly random (Math.random) rather than seeded: from IG's side the gap
 * between consecutive polls is what matters, not whether our internal seed
 * was deterministic. A fresh draw per tick widens the effective distribution
 * (a tick can defer or surface an account based on the roll), at the price of
 * a small amount of tick-level flicker that's harmless — once `dueAccounts`
 * picks an account, `last_polled_at` advances and it's not due again for
 * roughly another interval anyway.
 *
 * The id/lastPolledAt args are kept on the signature for API stability; only
 * `lastPolledAt === null` is meaningful (a never-polled account skips jitter
 * so its first poll fires immediately).
 */
export function pollJitterMs(
  _id: number,
  lastPolledAt: number | null,
  maxJitterMs: number,
): number {
  if (maxJitterMs <= 0 || lastPolledAt === null) return 0;
  return Math.floor(Math.random() * maxJitterMs);
}

export interface AddAccountInput {
  username: string;
  added_by: string;
}

export class InstagramMonitorStore {
  constructor(private readonly db: Database.Database) {}

  /** Returns the new row, or the existing row if already present. */
  upsertAccount(input: AddAccountInput): { account: MonitoredAccount; created: boolean } {
    const existing = this.getAccount(input.username);
    if (existing) return { account: existing, created: false };
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instagram_monitor_accounts
           (username, added_by, added_at, paused, consecutive_failures)
         VALUES (?, ?, ?, 0, 0)`,
      )
      .run(input.username, input.added_by, now);
    const account = this.getAccount(input.username);
    if (!account) throw new Error('Failed to read back inserted account');
    return { account, created: true };
  }

  removeAccount(username: string): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(`DELETE FROM instagram_monitor_accounts WHERE username = ?`)
      .run(username);
    return existing;
  }

  setPaused(username: string, paused: boolean): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(`UPDATE instagram_monitor_accounts SET paused = ? WHERE username = ?`)
      .run(paused ? 1 : 0, username);
    return this.getAccount(username);
  }

  getAccount(username: string): MonitoredAccount | null {
    const row = this.db
      .prepare(`SELECT * FROM instagram_monitor_accounts WHERE username = ?`)
      .get(username) as MonitoredAccount | undefined;
    return row ?? null;
  }

  listAccounts(): MonitoredAccount[] {
    return this.db
      .prepare(`SELECT * FROM instagram_monitor_accounts ORDER BY username ASC`)
      .all() as MonitoredAccount[];
  }

  /**
   * Accounts due for polling: paused=0 AND consecutive_auth_failures below the
   * auto-stop threshold AND (never polled OR enough time has elapsed accounting
   * for exponential backoff on consecutive_failures). Ordered oldest-first so
   * naturally-staggered polls don't burst.
   */
  dueAccounts(
    nowMs: number,
    pollIntervalMs: number,
    limit: number,
    jitterMaxMs = 0,
  ): MonitoredAccount[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM instagram_monitor_accounts
         WHERE paused = 0
           AND consecutive_auth_failures < ?
         ORDER BY COALESCE(last_polled_at, 0) ASC`,
      )
      .all(AUTH_PAUSE_THRESHOLD) as MonitoredAccount[];
    const out: MonitoredAccount[] = [];
    for (const r of rows) {
      const dueAt =
        (r.last_polled_at ?? 0) +
        Math.min(pollIntervalMs * 2 ** Math.min(r.consecutive_failures, 10), MAX_BACKOFF_MS) +
        pollJitterMs(r.id, r.last_polled_at, jitterMaxMs);
      if (r.last_polled_at === null || nowMs >= dueAt) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  markPollSuccess(
    id: number,
    nowMs: number,
    newLastPostId: string | null,
    newLastPostAt: number | null = null,
  ): void {
    if (newLastPostId === null) {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = 0,
               consecutive_auth_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, id);
    } else {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?, last_post_id = ?, last_post_at = ?,
               consecutive_failures = 0,
               consecutive_auth_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, newLastPostId, newLastPostAt, id);
    }
  }

  /**
   * Record a poll failure. Pass `{ auth: true }` for auth-class failures (the
   * IG session is bad: 401/403, checkpoint_required, challenge_required,
   * require_login). Auth failures also increment {@link MonitoredAccount.consecutive_auth_failures}
   * and, at the {@link AUTH_PAUSE_THRESHOLD}, cause `dueAccounts` to skip the
   * account until a successful poll resets the counter (or `clearFailureBackoff`
   * is called at restart).
   */
  markPollFailure(id: number, nowMs: number, opts: { auth?: boolean } = {}): void {
    if (opts.auth) {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = consecutive_failures + 1,
               consecutive_auth_failures = consecutive_auth_failures + 1
           WHERE id = ?`,
        )
        .run(nowMs, id);
    } else {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?,
               consecutive_failures = consecutive_failures + 1
           WHERE id = ?`,
        )
        .run(nowMs, id);
    }
  }

  /**
   * Zero out both failure counters across every account. Called by the
   * scheduler on `start()` so that the operator's "refresh cookies and restart"
   * flow re-enables polling immediately — no per-account unpause needed, no
   * waiting for an 8-hour exponential backoff window to elapse.
   */
  clearFailureBackoff(): { cleared: number } {
    const info = this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET consecutive_failures = 0,
             consecutive_auth_failures = 0
         WHERE consecutive_failures > 0 OR consecutive_auth_failures > 0`,
      )
      .run();
    return { cleared: info.changes };
  }

  /** Reset the dedup anchor so the next poll re-classifies the most recent posts. */
  resetLastPost(username: string): MonitoredAccount | null {
    const existing = this.getAccount(username);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET last_post_id = NULL, last_post_at = NULL, last_polled_at = NULL
         WHERE username = ?`,
      )
      .run(username);
    return this.getAccount(username);
  }

  hasSeen(channelId: string, igPostId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM instagram_monitor_seen_posts
         WHERE channel_id = ? AND ig_post_id = ?`,
      )
      .get(channelId, igPostId);
    return row !== undefined;
  }

  recordSeen(input: {
    channel_id: string;
    ig_post_id: string;
    account_username: string;
    caption: string | null;
    media_type: string | null;
    posted_at: number | null;
    classification_json: string | null;
    pushed: boolean;
    discord_message_id: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO instagram_monitor_seen_posts
           (ig_post_id, account_username, channel_id, caption, media_type, posted_at,
            detected_at, classification_json, pushed, discord_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ig_post_id,
        input.account_username,
        input.channel_id,
        input.caption,
        input.media_type,
        input.posted_at,
        Date.now(),
        input.classification_json,
        input.pushed ? 1 : 0,
        input.discord_message_id,
      );
  }

  recentPushed(channelId: string, limit: number): SeenPost[] {
    return this.db
      .prepare(
        `SELECT * FROM instagram_monitor_seen_posts
         WHERE channel_id = ? AND pushed = 1
         ORDER BY detected_at DESC
         LIMIT ?`,
      )
      .all(channelId, limit) as SeenPost[];
  }

  // ---- Global runtime / circuit breaker (v5) ------------------------------

  /** Read the singleton runtime row. The row is guaranteed to exist (seeded by
   * the v5 migration), but we coerce defensively for older test DBs. */
  getRuntime(): RuntimeState {
    const row = this.db
      .prepare(`SELECT * FROM instagram_monitor_runtime WHERE id = 1`)
      .get() as RuntimeState | undefined;
    return (
      row ?? {
        global_stop: 0,
        stop_reason: null,
        stopped_at: null,
        recent_auth_json: null,
        recent_429_json: null,
        auth_cooldown_until: null,
        rate_cooldown_until: null,
        budget_pause_until: null,
        requests_24h: null,
        heartbeat_at: null,
      }
    );
  }

  /** Whether the persistent kill-switch is engaged. */
  isGlobalStopped(): boolean {
    return this.getRuntime().global_stop === 1;
  }

  /** Engage the persistent kill-switch. Idempotent — a second trip keeps the
   * original reason/timestamp so we don't lose the first cause. */
  tripGlobalStop(reason: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET global_stop = 1,
             stop_reason = COALESCE(stop_reason, ?),
             stopped_at = COALESCE(stopped_at, ?)
         WHERE id = 1`,
      )
      .run(reason, nowMs);
  }

  /** Clear the kill-switch (the only way back — driven by `resume_monitor`).
   * Also clears the windowed event arrays so a resumed monitor starts fresh. */
  clearGlobalStop(): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET global_stop = 0, stop_reason = NULL, stopped_at = NULL,
             recent_auth_json = NULL, recent_429_json = NULL
         WHERE id = 1`,
      )
      .run();
  }

  /** Append `nowMs` to the auth-failure window, prune entries older than
   * {@link EVENT_WINDOW_MS}, and return the resulting count. */
  recordAuthEvent(nowMs: number): number {
    return this.appendEvent('recent_auth_json', nowMs);
  }

  /** Append `nowMs` to the 429 window, prune, and return the resulting count. */
  record429Event(nowMs: number): number {
    return this.appendEvent('recent_429_json', nowMs);
  }

  private appendEvent(column: 'recent_auth_json' | 'recent_429_json', nowMs: number): number {
    const runtime = this.getRuntime();
    const raw = column === 'recent_auth_json' ? runtime.recent_auth_json : runtime.recent_429_json;
    let arr: number[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed.filter((n) => typeof n === 'number');
      } catch {
        arr = [];
      }
    }
    arr.push(nowMs);
    const cutoff = nowMs - EVENT_WINDOW_MS;
    arr = arr.filter((t) => t >= cutoff);
    this.db
      .prepare(`UPDATE instagram_monitor_runtime SET ${column} = ? WHERE id = 1`)
      .run(JSON.stringify(arr));
    return arr.length;
  }

  /** Scheduler heartbeat: mirror the in-memory cooldowns + 24h request count
   * into the runtime row so the admin `status` tool can observe them. */
  writeHeartbeat(h: {
    authCooldownUntil: number | null;
    rateCooldownUntil: number | null;
    budgetPauseUntil: number | null;
    requests24h: number;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_runtime
         SET auth_cooldown_until = ?, rate_cooldown_until = ?, budget_pause_until = ?,
             requests_24h = ?, heartbeat_at = ?
         WHERE id = 1`,
      )
      .run(h.authCooldownUntil, h.rateCooldownUntil, h.budgetPauseUntil, h.requests24h, h.nowMs);
  }
}
