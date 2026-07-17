import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';

/**
 * An operator note / finding the model saved via `remember`, scoped per
 * Discord channel. Recalled with `recall` to give the ops copilot durable
 * memory across turns and restarts (e.g. "el pico de 500s del martes fue Dock
 * sin bootstrap en qa").
 */
export interface SancusOpsNote {
  id: number;
  channel_id: string;
  note: string;
  /** Optional space/comma-separated tags, lowercased. NULL when none given. */
  tags: string | null;
  created_by: string;
  created_at: number;
}

export const SANCUS_OPS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS sancus_ops_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT    NOT NULL,
        note        TEXT    NOT NULL,
        tags        TEXT,
        created_by  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sancus_ops_notes_channel_time
        ON sancus_ops_notes (channel_id, created_at DESC);
    `,
  },
];

export interface AddNoteInput {
  channel_id: string;
  note: string;
  tags?: string | null;
  created_by: string;
  now_ms: number;
}

/** Per-channel operator-notes recall store for the sancus_ops capability. */
export class SancusOpsStore {
  constructor(private readonly db: Database.Database) {}

  addNote(input: AddNoteInput): SancusOpsNote {
    const info = this.db
      .prepare(
        `INSERT INTO sancus_ops_notes (channel_id, note, tags, created_by, created_at)
              VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.channel_id, input.note, input.tags ?? null, input.created_by, input.now_ms);
    return this.getById(Number(info.lastInsertRowid))!;
  }

  getById(id: number): SancusOpsNote | null {
    const row = this.db
      .prepare(`SELECT * FROM sancus_ops_notes WHERE id = ?`)
      .get(id);
    return (row as SancusOpsNote | undefined) ?? null;
  }

  /** Most-recent notes for a channel, newest first. */
  recentNotes(channelId: string, limit: number): SancusOpsNote[] {
    return this.db
      .prepare(
        `SELECT * FROM sancus_ops_notes
          WHERE channel_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(channelId, limit) as SancusOpsNote[];
  }

  /**
   * Case-insensitive substring search over note text + tags for a channel,
   * newest first. Empty/whitespace query falls back to {@link recentNotes}.
   */
  searchNotes(channelId: string, query: string, limit: number): SancusOpsNote[] {
    const q = query.trim();
    if (!q) return this.recentNotes(channelId, limit);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    return this.db
      .prepare(
        `SELECT * FROM sancus_ops_notes
          WHERE channel_id = ?
            AND (note LIKE ? ESCAPE '\\' OR IFNULL(tags, '') LIKE ? ESCAPE '\\')
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(channelId, like, like, limit) as SancusOpsNote[];
  }

  deleteNote(channelId: string, id: number): boolean {
    const info = this.db
      .prepare(`DELETE FROM sancus_ops_notes WHERE channel_id = ? AND id = ?`)
      .run(channelId, id);
    return info.changes > 0;
  }
}
