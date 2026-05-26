import type Database from 'better-sqlite3';
import type { Migration } from '../memory/migrations.js';

/**
 * Framework-level user directory. Lives outside any capability's namespace
 * because every capability that wants per-user scoping needs to look up the
 * same Discord user. Migrations are run under the reserved capability id
 * `__framework__` — no real capability can collide because capability ids
 * are kebab-case slugs that never start with an underscore.
 */
export const FRAMEWORK_CAPABILITY_ID = '__framework__';

export interface UserRecord {
  discord_user_id: string;
  discord_tag: string;
  first_seen_at: number;
  last_seen_at: number;
}

export const USERS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS users (
        discord_user_id TEXT PRIMARY KEY,
        discord_tag     TEXT NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_last_seen ON users (last_seen_at DESC);
    `,
  },
];

export class UserDirectory {
  constructor(private readonly db: Database.Database) {}

  /**
   * Lazily register a Discord user. On first call inserts a new row; on
   * subsequent calls updates `discord_tag` (in case the user changed it) and
   * advances `last_seen_at`. `first_seen_at` is set once and preserved.
   */
  upsert(discordUserId: string, discordTag: string, nowMs: number): UserRecord {
    const existing = this.db
      .prepare(
        'SELECT discord_user_id, discord_tag, first_seen_at, last_seen_at FROM users WHERE discord_user_id = ?',
      )
      .get(discordUserId) as UserRecord | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE users SET discord_tag = ?, last_seen_at = ? WHERE discord_user_id = ?',
        )
        .run(discordTag, nowMs, discordUserId);
      return {
        discord_user_id: discordUserId,
        discord_tag: discordTag,
        first_seen_at: existing.first_seen_at,
        last_seen_at: nowMs,
      };
    }

    this.db
      .prepare(
        'INSERT INTO users (discord_user_id, discord_tag, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(discordUserId, discordTag, nowMs, nowMs);
    return {
      discord_user_id: discordUserId,
      discord_tag: discordTag,
      first_seen_at: nowMs,
      last_seen_at: nowMs,
    };
  }

  get(discordUserId: string): UserRecord | null {
    const row = this.db
      .prepare(
        'SELECT discord_user_id, discord_tag, first_seen_at, last_seen_at FROM users WHERE discord_user_id = ?',
      )
      .get(discordUserId) as UserRecord | undefined;
    return row ?? null;
  }

  /** Most-recently-seen first. */
  list(limit: number): UserRecord[] {
    return this.db
      .prepare(
        'SELECT discord_user_id, discord_tag, first_seen_at, last_seen_at FROM users ORDER BY last_seen_at DESC LIMIT ?',
      )
      .all(limit) as UserRecord[];
  }
}
