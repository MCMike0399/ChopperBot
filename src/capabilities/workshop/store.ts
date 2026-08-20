import type Database from "better-sqlite3";
import type { Migration } from "../../memory/store.js";

/** Single-row settings (id=1). Seeded from env on first boot; DB wins after. */
export interface WorkshopSettings {
   welcome_channel_id: string | null;
   /** The bot message members react to. Ensured/reposted by the watcher. */
   welcome_message_id: string | null;
   category_id: string | null;
   reaction_emoji: string;
   updated_at: number | null;
}

export type SessionStatus = "active" | "closed";

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
   /** Running compaction summary of conversation older than the live window. */
   summary: string | null;
   /** Messages created at/before this timestamp are covered by `summary`. */
   summary_covers_until: number | null;
}

/**
 * Manifest of a session's workspace files whose DURABLE copy lives on Discord
 * (an attachment on a channel message): deliverables the bot sent and files
 * the member uploaded. The Pi workspace is just a cache — a GC'd file is
 * re-downloaded from its message on demand.
 */
export interface WorkshopFileRecord {
   channel_id: string;
   rel_path: string;
   message_id: string;
   bytes: number;
   updated_at: number;
   /**
    * Key of this file's copy in object storage (MinIO on the HDD), or NULL when
    * storage is disabled / the upload hasn't happened yet. The Discord carrier
    * message stays the fallback either way.
    */
   storage_key: string | null;
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
   {
      version: 2,
      up: `
      -- Context compaction: a running summary of conversation older than the
      -- live history window, injected into the system prompt.
      ALTER TABLE workshop_sessions ADD COLUMN summary TEXT;
      ALTER TABLE workshop_sessions ADD COLUMN summary_covers_until INTEGER;

      -- Discord-as-storage manifest: workspace files whose durable copy is an
      -- attachment on a channel message (message_id). Local files are a cache.
      CREATE TABLE IF NOT EXISTS workshop_files (
        channel_id TEXT    NOT NULL,
        rel_path   TEXT    NOT NULL,
        message_id TEXT    NOT NULL,
        bytes      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, rel_path)
      );
    `,
   },
   {
      version: 3,
      up: `
      -- Object-storage (MinIO on the HDD) copy of each manifest file. NULL =
      -- Discord-carrier only (pre-MinIO rows, storage disabled, or a failed
      -- upload that a later turn will retry). recordFile's upsert deliberately
      -- never touches this column: an archive re-point changes the Discord
      -- carrier, not the stored object.
      ALTER TABLE workshop_files ADD COLUMN storage_key TEXT;
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
   seedSettings(seed: {
      welcomeChannelId?: string;
      categoryId?: string;
      reactionEmoji?: string;
   }): void {
      const cur = this.getSettings();
      const welcome = cur.welcome_channel_id ?? seed.welcomeChannelId ?? null;
      const category = cur.category_id ?? seed.categoryId ?? null;
      if (welcome === cur.welcome_channel_id && category === cur.category_id)
         return;
      this.db
         .prepare(
            `UPDATE workshop_settings
         SET welcome_channel_id = ?, category_id = ?, updated_at = ? WHERE id = 1`,
         )
         .run(welcome, category, Date.now());
   }

   setChannels(
      welcomeChannelId: string | null,
      categoryId: string | null,
   ): void {
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
         .prepare(
            "UPDATE workshop_settings SET welcome_message_id = ?, updated_at = ? WHERE id = 1",
         )
         .run(messageId, Date.now());
   }

   setReactionEmoji(emoji: string): void {
      this.db
         .prepare(
            "UPDATE workshop_settings SET reaction_emoji = ?, updated_at = ? WHERE id = 1",
         )
         .run(emoji, Date.now());
   }

   // ── Sessions ──────────────────────────────────────────────────────────────

   getSession(channelId: string): WorkshopSession | undefined {
      return this.db
         .prepare("SELECT * FROM workshop_sessions WHERE channel_id = ?")
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
            .prepare(
               `SELECT channel_id FROM workshop_sessions WHERE status = 'active'`,
            )
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
         .run(
            input.channelId,
            input.guildId,
            input.userId,
            input.userTag,
            input.nowMs,
            input.nowMs,
         );
   }

   setPanelMessageId(channelId: string, messageId: string | null): void {
      this.db
         .prepare(
            "UPDATE workshop_sessions SET panel_message_id = ? WHERE channel_id = ?",
         )
         .run(messageId, channelId);
   }

   touchActivity(channelId: string, nowMs: number): void {
      this.db
         .prepare(
            "UPDATE workshop_sessions SET last_activity_at = ? WHERE channel_id = ?",
         )
         .run(nowMs, channelId);
   }

   /** Full context reset: also drops the compaction summary (borrón total).
    * The file manifest is deliberately untouched — "limpiar" keeps files. */
   clearContext(channelId: string, nowMs: number): void {
      this.db
         .prepare(
            `UPDATE workshop_sessions
         SET context_cleared_at = ?, summary = NULL, summary_covers_until = NULL
         WHERE channel_id = ?`,
         )
         .run(nowMs, channelId);
   }

   setSummary(channelId: string, summary: string, coversUntil: number): void {
      this.db
         .prepare(
            "UPDATE workshop_sessions SET summary = ?, summary_covers_until = ? WHERE channel_id = ?",
         )
         .run(summary, coversUntil, channelId);
   }

   // ── File manifest (Discord as the durable store) ──────────────────────────

   recordFile(input: {
      channelId: string;
      relPath: string;
      messageId: string;
      bytes: number;
      nowMs: number;
   }): void {
      this.db
         .prepare(
            `INSERT INTO workshop_files (channel_id, rel_path, message_id, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, rel_path) DO UPDATE SET
           message_id = excluded.message_id,
           bytes      = excluded.bytes,
           updated_at = excluded.updated_at`,
         )
         .run(
            input.channelId,
            input.relPath,
            input.messageId,
            input.bytes,
            input.nowMs,
         );
   }

   fileManifest(channelId: string): WorkshopFileRecord[] {
      return this.db
         .prepare(
            "SELECT * FROM workshop_files WHERE channel_id = ? ORDER BY rel_path",
         )
         .all(channelId) as WorkshopFileRecord[];
   }

   /** Record (or clear) the object-storage key of a manifest file's copy. */
   setStorageKey(
      channelId: string,
      relPath: string,
      storageKey: string | null,
   ): void {
      this.db
         .prepare(
            "UPDATE workshop_files SET storage_key = ? WHERE channel_id = ? AND rel_path = ?",
         )
         .run(storageKey, channelId, relPath);
   }

   removeFileRecord(channelId: string, relPath: string): void {
      this.db
         .prepare(
            "DELETE FROM workshop_files WHERE channel_id = ? AND rel_path = ?",
         )
         .run(channelId, relPath);
   }

   deleteFileRecords(channelId: string): void {
      this.db
         .prepare("DELETE FROM workshop_files WHERE channel_id = ?")
         .run(channelId);
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
