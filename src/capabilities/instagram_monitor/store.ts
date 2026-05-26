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
];

/** Backoff: next allowed poll is min(POLL_INTERVAL * 2^failures, MAX_BACKOFF). */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

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
  dueAccounts(nowMs: number, pollIntervalMs: number, limit: number): MonitoredAccount[] {
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
        Math.min(pollIntervalMs * 2 ** Math.min(r.consecutive_failures, 10), MAX_BACKOFF_MS);
      if (r.last_polled_at === null || nowMs >= dueAt) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  markPollSuccess(id: number, nowMs: number, newLastPostId: string | null): void {
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
           SET last_polled_at = ?, last_post_id = ?, consecutive_failures = 0
           WHERE id = ?`,
        )
        .run(nowMs, newLastPostId, id);
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
         SET last_post_id = NULL, last_polled_at = NULL
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
