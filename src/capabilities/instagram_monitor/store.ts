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
];

/** Backoff: next allowed poll is min(POLL_INTERVAL * 2^failures, MAX_BACKOFF). */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Deterministic per-(account, poll-cycle) jitter in [0, maxJitterMs). Added to
 * an account's next-due time so accounts decorrelate and polls scatter
 * irregularly across the interval instead of firing in a synchronized burst.
 *
 * It's stable within a cycle (depends only on id + last_polled_at, both fixed
 * until the next poll) so an account never flickers in/out of "due" between
 * ticks, and it reshuffles after each poll because last_polled_at changes.
 */
export function pollJitterMs(
  id: number,
  lastPolledAt: number | null,
  maxJitterMs: number,
): number {
  if (maxJitterMs <= 0 || lastPolledAt === null) return 0;
  let seed = Math.imul(id ^ 0x9e3779b9, 2654435761) ^ Math.imul(lastPolledAt | 0, 40503);
  seed = (seed >>> 0) % 1_000_000;
  return Math.floor((seed / 1_000_000) * maxJitterMs);
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
   * Accounts due for polling: paused=0 AND (never polled OR enough time has
   * elapsed accounting for exponential backoff on consecutive_failures).
   * Ordered oldest-first so naturally-staggered polls don't burst.
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
         ORDER BY COALESCE(last_polled_at, 0) ASC`,
      )
      .all() as MonitoredAccount[];
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
           SET last_polled_at = ?, consecutive_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, id);
    } else {
      this.db
        .prepare(
          `UPDATE instagram_monitor_accounts
           SET last_polled_at = ?, last_post_id = ?, last_post_at = ?, consecutive_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, newLastPostId, newLastPostAt, id);
    }
  }

  markPollFailure(id: number, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE instagram_monitor_accounts
         SET last_polled_at = ?, consecutive_failures = consecutive_failures + 1
         WHERE id = ?`,
      )
      .run(nowMs, id);
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
}
