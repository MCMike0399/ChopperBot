import type Database from "better-sqlite3";
import type { Migration } from "../memory/migrations.js";

export const MODERATION_GUILD_ID = "1435843683541979248";
export const DEFAULT_MODERATION_CHANNEL_ID = "1436206995140247652";
export const LOG_CHANNEL_IDS = new Set([
   "1436112159829397564",
   "1436110972602417253",
]);

/**
 * Framework namespace v2: shared workspace/settings, not event-intake state.
 * Shares the `__framework__` version sequence with USERS_MIGRATIONS (v1);
 * the next framework migration must be v3+.
 */
export const MODERATION_MIGRATIONS: Migration[] = [
   {
      version: 2,
      up: `
   CREATE TABLE framework_moderation_settings (
      guild_id TEXT PRIMARY KEY,
      moderation_channel_id TEXT NOT NULL,
      escalation_ping_roles_json TEXT NOT NULL DEFAULT '[]'
   );
   CREATE TABLE framework_moderation_trail (
      id INTEGER PRIMARY KEY,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE(guild_id, trigger_message_id, action, target_id)
   );
   CREATE INDEX framework_moderation_recent ON framework_moderation_trail(guild_id, timestamp);
   `,
   },
];

export interface ModerationSettings {
   moderation_channel_id: string | null;
   escalation_ping_role_ids: string[];
}

export interface TrailEntry {
   guildId: string;
   actorId: string;
   targetId: string;
   action: "ban" | "escalation";
   reason: string;
   triggerMessageId: string;
   channelId: string;
   outcome: string;
   timestamp: number;
}

/** All reservations are synchronous transactions: concurrent turns cannot race. */
export class ModerationStore {
   constructor(private readonly db: Database.Database) {}

   settings(guildId: string): ModerationSettings {
      const row = this.db
         .prepare(
            "SELECT * FROM framework_moderation_settings WHERE guild_id = ?",
         )
         .get(guildId) as
         | { moderation_channel_id: string; escalation_ping_roles_json: string }
         | undefined;
      return {
         moderation_channel_id:
            row?.moderation_channel_id ??
            (guildId === MODERATION_GUILD_ID
               ? DEFAULT_MODERATION_CHANNEL_ID
               : null),
         escalation_ping_role_ids: row
            ? (JSON.parse(row.escalation_ping_roles_json) as string[])
            : [],
      };
   }

   setSettings(guildId: string, channelId: string, roleIds: string[]): void {
      this.db
         .prepare(
            `INSERT INTO framework_moderation_settings VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET moderation_channel_id = excluded.moderation_channel_id,
         escalation_ping_roles_json = excluded.escalation_ping_roles_json`,
         )
         .run(guildId, channelId, JSON.stringify([...new Set(roleIds)].sort()));
   }

   record(entry: TrailEntry): number | null {
      const result = this.db
         .prepare(
            `INSERT OR IGNORE INTO framework_moderation_trail
         (guild_id, actor_id, target_id, action, reason, trigger_message_id, channel_id, outcome, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
         )
         .run(
            entry.guildId,
            entry.actorId,
            entry.targetId,
            entry.action,
            entry.reason.slice(0, 500),
            entry.triggerMessageId,
            entry.channelId,
            entry.outcome,
            entry.timestamp,
         );
      return result.changes ? Number(result.lastInsertRowid) : null;
   }

   finish(id: number, outcome: string): void {
      this.db
         .prepare(
            "UPDATE framework_moderation_trail SET outcome = ? WHERE id = ?",
         )
         .run(outcome, id);
   }

   /**
    * One reporter/30min, one source channel/5min, one note per cited target/
    * 30min, and 20 DELIVERED notes per guild/UTC day — refused/failed deliveries
    * don't burn the daily cap, so a burst of failures can't silence real reports.
    */
   reserveEscalation(entry: TrailEntry): number | null {
      return this.db.transaction(() => {
         const count = (where: string, ...args: (string | number)[]) =>
            (
               this.db
                  .prepare(
                     `SELECT count(*) AS n FROM framework_moderation_trail WHERE guild_id = ? AND action = 'escalation' AND ${where}`,
                  )
                  .get(entry.guildId, ...args) as { n: number }
            ).n;
         const dayStart = Math.floor(entry.timestamp / 86_400_000) * 86_400_000;
         if (
            count(
               "actor_id = ? AND timestamp > ?",
               entry.actorId,
               entry.timestamp - 30 * 60_000,
            ) ||
            count(
               "channel_id = ? AND timestamp > ?",
               entry.channelId,
               entry.timestamp - 5 * 60_000,
            ) ||
            (!!entry.targetId &&
               count(
                  "target_id = ? AND timestamp > ?",
                  entry.targetId,
                  entry.timestamp - 30 * 60_000,
               )) ||
            count(
               "outcome NOT LIKE 'refused:%' AND timestamp >= ?",
               dayStart,
            ) >= 20
         )
            return null;
         return this.record(entry);
      })();
   }

   summary(guildId: string, now = Date.now()) {
      const rows = this.db
         .prepare(
            `SELECT outcome, count(*) AS count FROM framework_moderation_trail
         WHERE guild_id = ? AND timestamp >= ? GROUP BY outcome`,
         )
         .all(guildId, now - 30 * 86_400_000) as {
         outcome: string;
         count: number;
      }[];
      return {
         period_days: 30,
         total: rows.reduce((n, r) => n + r.count, 0),
         by_outcome: Object.fromEntries(rows.map((r) => [r.outcome, r.count])),
      };
   }
}
