import type Database from "better-sqlite3";
import type { Migration } from "../../memory/store.js";

/**
 * One voice-recording session: the bot joined a voice/stage channel, captured
 * per-speaker audio bursts + the channel chat, and (on end) produced a minuta.
 * Rows are the recovery source of truth: a process that dies mid-session leaves
 * an `active`/`processing` row the next boot sweeps into finalization.
 */
export interface MinutasSessionRow {
   id: string;
   guild_id: string;
   channel_id: string;
   channel_name: string | null;
   title: string | null;
   started_by: string;
   started_by_tag: string | null;
   started_at: number;
   ended_at: number | null;
   /** active → processing → done | failed. */
   status: "active" | "processing" | "done" | "failed";
   /**
    * Unused since 2026-08-19 (`/chopperbot-leave` always finalizes immediately).
    * Kept so existing databases don't need a drop-column migration.
    */
   transcribe_after: number | null;
   end_reason: string | null;
   minio_prefix: string | null;
   summary_message_id: string | null;
   participants_json: string;
   stats_json: string | null;
   error: string | null;
}

export const MINUTAS_MIGRATIONS: Migration[] = [
   {
      version: 1,
      up: `
      -- Single-row settings (id=1): where minutes are published. Env seeds on
      -- first boot; the DB wins after (config_minutas set_output_channel).
      CREATE TABLE IF NOT EXISTS minutas_settings (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        output_channel_id  TEXT,
        updated_at         INTEGER
      );
      INSERT OR IGNORE INTO minutas_settings (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS minutas_sessions (
        id                 TEXT PRIMARY KEY,
        guild_id           TEXT NOT NULL,
        channel_id         TEXT NOT NULL,
        channel_name       TEXT,
        title              TEXT,
        started_by         TEXT NOT NULL,
        started_by_tag     TEXT,
        started_at         INTEGER NOT NULL,
        ended_at           INTEGER,
        status             TEXT NOT NULL DEFAULT 'active',
        end_reason         TEXT,
        minio_prefix       TEXT,
        summary_message_id TEXT,
        participants_json  TEXT NOT NULL DEFAULT '[]',
        stats_json         TEXT,
        error              TEXT
      );
      CREATE INDEX IF NOT EXISTS minutas_sessions_guild_status
        ON minutas_sessions (guild_id, status);
      CREATE INDEX IF NOT EXISTS minutas_sessions_started
        ON minutas_sessions (started_at DESC);
    `,
   },
   {
      version: 2,
      // Nightly deferral used this column; leave always finalizes now (2026-08-19).
      // The column stays so existing databases don't need a drop.
      up: `ALTER TABLE minutas_sessions ADD COLUMN transcribe_after INTEGER;`,
   },
];

export class MinutasStore {
   constructor(private readonly db: Database.Database) {}

   // ── Settings ────────────────────────────────────────────────────────────────

   getOutputChannelId(): string | null {
      const row = this.db
         .prepare("SELECT output_channel_id FROM minutas_settings WHERE id = 1")
         .get() as { output_channel_id: string | null } | undefined;
      return row?.output_channel_id ?? null;
   }

   setOutputChannelId(id: string): void {
      this.db
         .prepare(
            "UPDATE minutas_settings SET output_channel_id = ?, updated_at = ? WHERE id = 1",
         )
         .run(id, Date.now());
   }

   /**
    * One-time env seed: only writes when nothing is configured yet, so a
    * channel set from the config console is never clobbered by a restart.
    */
   seedOutputChannelId(id: string | undefined): void {
      if (!id) return;
      if (this.getOutputChannelId()) return;
      this.setOutputChannelId(id);
   }

   // ── Sessions ────────────────────────────────────────────────────────────────

   createSession(row: MinutasSessionRow): void {
      this.db
         .prepare(
            `INSERT INTO minutas_sessions
           (id, guild_id, channel_id, channel_name, title, started_by, started_by_tag,
            started_at, ended_at, status, transcribe_after, end_reason, minio_prefix,
            summary_message_id, participants_json, stats_json, error)
         VALUES
           (@id, @guild_id, @channel_id, @channel_name, @title, @started_by, @started_by_tag,
            @started_at, @ended_at, @status, @transcribe_after, @end_reason, @minio_prefix,
            @summary_message_id, @participants_json, @stats_json, @error)`,
         )
         .run(row);
   }

   getSession(id: string): MinutasSessionRow | null {
      const row = this.db
         .prepare("SELECT * FROM minutas_sessions WHERE id = ?")
         .get(id);
      return (row as MinutasSessionRow) ?? null;
   }

   getActiveSessionForGuild(guildId: string): MinutasSessionRow | null {
      const row = this.db
         .prepare(
            "SELECT * FROM minutas_sessions WHERE guild_id = ? AND status = 'active'",
         )
         .get(guildId);
      return (row as MinutasSessionRow) ?? null;
   }

   /**
    * Sessions the previous process left unfinished (still 'active' or mid-
    * 'processing' when it died). Read at boot by the sweep that finalizes them.
    */
   listUnfinishedSessions(): MinutasSessionRow[] {
      return this.db
         .prepare(
            "SELECT * FROM minutas_sessions WHERE status IN ('active', 'processing')",
         )
         .all() as MinutasSessionRow[];
   }

   listRecentSessions(limit = 10): MinutasSessionRow[] {
      return this.db
         .prepare(
            "SELECT * FROM minutas_sessions ORDER BY started_at DESC LIMIT ?",
         )
         .all(limit) as MinutasSessionRow[];
   }

   updateSession(
      id: string,
      fields: Partial<
         Pick<
            MinutasSessionRow,
            | "ended_at"
            | "status"
            | "transcribe_after"
            | "end_reason"
            | "minio_prefix"
            | "summary_message_id"
            | "participants_json"
            | "stats_json"
            | "error"
         >
      >,
   ): void {
      const keys = Object.keys(fields) as Array<keyof typeof fields>;
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = @${k}`).join(", ");
      this.db
         .prepare(`UPDATE minutas_sessions SET ${sets} WHERE id = @id`)
         .run({ id, ...fields });
   }
}
