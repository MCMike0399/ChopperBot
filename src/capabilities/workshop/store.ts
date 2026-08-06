import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';

/** Single-row settings (id=1). Seeded from env on first boot; DB wins after. */
export interface WorkshopSettings {
  welcome_channel_id: string | null;
  /** The bot message members react to. Ensured/reposted by the watcher. */
  welcome_message_id: string | null;
  category_id: string | null;
  reaction_emoji: string;
  updated_at: number | null;
}

export type SessionStatus = 'active' | 'closed';

export interface WorkshopSession {
  channel_id: string;
  guild_id: string;
  user_id: string;
  user_tag: string;
  status: SessionStatus;
  created_at: number;
  last_activity_at: number;
  /** History before this timestamp is ignored ("limpiar contexto"). */
  context_cleared_at: number | null;
  /** The pinned control-panel message (skipped from history, kept on purge). */
  panel_message_id: string | null;
  closed_at: number | null;
}

export const WORKSHOP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS workshop_settings (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        welcome_channel_id TEXT,
        welcome_message_id TEXT,
        category_id        TEXT,
        reaction_emoji     TEXT NOT NULL DEFAULT '🎓',
        updated_at         INTEGER
      );
      INSERT OR IGNORE INTO workshop_settings (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS workshop_sessions (
        channel_id         TEXT    PRIMARY KEY,
        guild_id           TEXT    NOT NULL,
        user_id            TEXT    NOT NULL,
        user_tag           TEXT    NOT NULL,
        status             TEXT    NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','closed')),
        created_at         INTEGER NOT NULL,
        last_activity_at   INTEGER NOT NULL,
        context_cleared_at INTEGER,
        panel_message_id   TEXT,
        closed_at          INTEGER
      );
      CREATE INDEX IF NOT EXISTS workshop_sessions_user
        ON workshop_sessions (user_id, status);
      CREATE INDEX IF NOT EXISTS workshop_sessions_status
        ON workshop_sessions (status, last_activity_at DESC);
    `,
  },
];

export class WorkshopStore {
  constructor(private readonly db: Database.Database) {}

  // ── Settings ──────────────────────────────────────────────────────────────

  getSettings(): WorkshopSettings {
    return this.db
      .prepare(
        `SELECT welcome_channel_id, welcome_message_id, category_id, reaction_emoji, updated_at
         FROM workshop_settings WHERE id = 1`,
      )
      .get() as WorkshopSettings;
  }

  /** One-time env seed: only fills fields not yet configured (DB wins after). */
  seedSettings(seed: { welcomeChannelId?: string; categoryId?: string; reactionEmoji?: string }): void {
    const cur = this.getSettings();
    const welcome = cur.welcome_channel_id ?? seed.welcomeChannelId ?? null;
    const category = cur.category_id ?? seed.categoryId ?? null;
    if (welcome === cur.welcome_channel_id && category === cur.category_id) return;
    this.db
      .prepare(
        `UPDATE workshop_settings
         SET welcome_channel_id = ?, category_id = ?, updated_at = ? WHERE id = 1`,
      )
      .run(welcome, category, Date.now());
  }

  setChannels(welcomeChannelId: string | null, categoryId: string | null): void {
    this.db
      .prepare(
        `UPDATE workshop_settings
         SET welcome_channel_id = ?, category_id = ?, welcome_message_id = NULL, updated_at = ?
         WHERE id = 1`,
      )
      .run(welcomeChannelId, categoryId, Date.now());
  }

  setWelcomeMessageId(messageId: string | null): void {
    this.db
      .prepare('UPDATE workshop_settings SET welcome_message_id = ?, updated_at = ? WHERE id = 1')
      .run(messageId, Date.now());
  }

  setReactionEmoji(emoji: string): void {
    this.db
      .prepare('UPDATE workshop_settings SET reaction_emoji = ?, updated_at = ? WHERE id = 1')
      .run(emoji, Date.now());
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  getSession(channelId: string): WorkshopSession | undefined {
    return this.db
      .prepare('SELECT * FROM workshop_sessions WHERE channel_id = ?')
      .get(channelId) as WorkshopSession | undefined;
  }

  activeSessionsFor(userId: string): WorkshopSession[] {
    return this.db
      .prepare(
        `SELECT * FROM workshop_sessions
         WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC`,
      )
      .all(userId) as WorkshopSession[];
  }

  activeSessions(): WorkshopSession[] {
    return this.db
      .prepare(
        `SELECT * FROM workshop_sessions WHERE status = 'active' ORDER BY last_activity_at DESC`,
      )
      .all() as WorkshopSession[];
  }

  /** All active channel ids — the watcher's hot-path membership check. */
  activeChannelIds(): string[] {
    return (
      this.db
        .prepare(`SELECT channel_id FROM workshop_sessions WHERE status = 'active'`)
        .all() as Array<{ channel_id: string }>
    ).map((r) => r.channel_id);
  }

  createSession(input: {
    channelId: string;
    guildId: string;
    userId: string;
    userTag: string;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workshop_sessions
           (channel_id, guild_id, user_id, user_tag, status, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(input.channelId, input.guildId, input.userId, input.userTag, input.nowMs, input.nowMs);
  }

  setPanelMessageId(channelId: string, messageId: string | null): void {
    this.db
      .prepare('UPDATE workshop_sessions SET panel_message_id = ? WHERE channel_id = ?')
      .run(messageId, channelId);
  }

  touchActivity(channelId: string, nowMs: number): void {
    this.db
      .prepare('UPDATE workshop_sessions SET last_activity_at = ? WHERE channel_id = ?')
      .run(nowMs, channelId);
  }

  clearContext(channelId: string, nowMs: number): void {
    this.db
      .prepare('UPDATE workshop_sessions SET context_cleared_at = ? WHERE channel_id = ?')
      .run(nowMs, channelId);
  }

  closeSession(channelId: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE workshop_sessions SET status = 'closed', closed_at = ? WHERE channel_id = ?`,
      )
      .run(nowMs, channelId);
  }

  countSessions(): { active: number; closed: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(status = 'active') AS active, SUM(status = 'closed') AS closed
         FROM workshop_sessions`,
      )
      .get() as { active: number | null; closed: number | null };
    return { active: row.active ?? 0, closed: row.closed ?? 0 };
  }
}
