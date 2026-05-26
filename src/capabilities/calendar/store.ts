import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';
import {
  expandOccurrences,
  type ExpandedOccurrence,
  type RecurrenceFreq,
} from './recurrence.js';

/**
 * Calendar is **per-user, globally** — events belong to a Discord user, not
 * to a channel. The user can talk to the calendar capability from any
 * channel bound to it and see the same events.
 *
 * Mutations are always scoped to the calling user — a user cannot update or
 * delete another user's event through the regular tools. The configuration
 * capability has admin counterparts ({@link CalendarStore.adminListAll} /
 * {@link CalendarStore.adminDelete}) for cross-user inspection and recovery.
 */
export interface CalendarEvent {
  id: number;
  /** Discord snowflake of the owner. Same value as created_by. */
  discord_user_id: string;
  created_by: string;
  title: string;
  description: string | null;
  start_at: number;                       // master/anchor start, unix ms UTC
  end_at: number | null;
  location: string | null;
  recurrence_freq: RecurrenceFreq | null; // null = one-off event
  recurrence_until: number | null;        // unix ms UTC, exclusive cap on expansions
  created_at: number;
  updated_at: number;
}

/**
 * A calendar event as the model sees it: either a one-off event or a
 * single occurrence of a recurring series. `id` is always the master row's
 * id; `occurrence_start_at` is what's actually displayed/queried.
 *
 * v1 has no per-instance overrides, so update/delete by id affects the
 * whole series.
 */
export interface CalendarOccurrence
  extends Omit<CalendarEvent, 'start_at' | 'end_at'> {
  start_at: number;                  // this occurrence's start
  end_at: number | null;             // this occurrence's end
  occurrence_index: number;          // 0 for one-offs and master, 1+ for instances
  is_recurring_instance: boolean;    // true iff this is a generated occurrence (i > 0)
  master_start_at: number;           // the master row's start_at, for reference
}

export interface CreateEventInput {
  discord_user_id: string;
  title: string;
  start_at: number;
  end_at?: number | null;
  description?: string | null;
  location?: string | null;
  recurrence_freq?: RecurrenceFreq | null;
  recurrence_until?: number | null;
}

export interface UpdateEventInput {
  title?: string;
  description?: string | null;
  start_at?: number;
  end_at?: number | null;
  location?: string | null;
  recurrence_freq?: RecurrenceFreq | null;
  recurrence_until?: number | null;
}

/** How far ahead to expand recurring events for listing/snapshots. */
const DEFAULT_LIST_HORIZON_MS = 90 * 86_400_000; // 90 days
/** Hard cap on instances produced per master, regardless of horizon. */
const DEFAULT_MAX_INSTANCES_PER_MASTER = 50;

export const CALENDAR_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS calendar_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT    NOT NULL,
        created_by  TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        description TEXT,
        start_at    INTEGER NOT NULL,
        end_at      INTEGER,
        location    TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calendar_events_channel_start
        ON calendar_events (channel_id, start_at);
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE calendar_events ADD COLUMN recurrence_freq TEXT;
      ALTER TABLE calendar_events ADD COLUMN recurrence_until INTEGER;
    `,
  },
  {
    // Per-user scoping. Existing rows in prod were test data → wipe before
    // adding the NOT NULL column so we don't carry forward orphaned events
    // with a placeholder owner.
    version: 3,
    up: `
      DELETE FROM calendar_events;
      ALTER TABLE calendar_events ADD COLUMN discord_user_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS calendar_events_channel_user_start
        ON calendar_events (channel_id, discord_user_id, start_at);
    `,
  },
  {
    // v4 — go fully per-user. Drop channel_id from the events table entirely;
    // a user sees the same calendar from any channel bound to this capability.
    // Existing rows are preserved (we only drop the column).
    version: 4,
    up: `
      CREATE TABLE calendar_events_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id   TEXT    NOT NULL,
        created_by        TEXT    NOT NULL,
        title             TEXT    NOT NULL,
        description       TEXT,
        start_at          INTEGER NOT NULL,
        end_at            INTEGER,
        location          TEXT,
        recurrence_freq   TEXT,
        recurrence_until  INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      INSERT INTO calendar_events_new
        (id, discord_user_id, created_by, title, description, start_at, end_at,
         location, recurrence_freq, recurrence_until, created_at, updated_at)
      SELECT id, discord_user_id, created_by, title, description, start_at, end_at,
             location, recurrence_freq, recurrence_until, created_at, updated_at
      FROM calendar_events;

      DROP TABLE calendar_events;
      ALTER TABLE calendar_events_new RENAME TO calendar_events;

      CREATE INDEX IF NOT EXISTS calendar_events_user_start
        ON calendar_events (discord_user_id, start_at);
    `,
  },
];

/**
 * Type-safe access to the calendar_events table.
 *
 * Read and write methods are hard-scoped by `discord_user_id` — the caller
 * never sees another user's events through these. Cross-user admin
 * operations live in the configuration capability via `adminListAll` /
 * `adminDelete`.
 */
export class CalendarStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Master rows for this user whose start_at <= toMs and whose recurrence
   * window (if any) hasn't fully elapsed before fromMs. Used as the input
   * to occurrence expansion.
   */
  private candidateMasters(
    discordUserId: string,
    fromMs: number,
    toMs: number,
  ): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE discord_user_id = ?
           AND start_at <= ?
           AND (
             recurrence_freq IS NULL AND start_at >= ?
             OR recurrence_freq IS NOT NULL
                AND (recurrence_until IS NULL OR recurrence_until >= ?)
           )`,
      )
      .all(discordUserId, toMs, fromMs, fromMs) as CalendarEvent[];
  }

  listUpcoming(
    discordUserId: string,
    fromMs: number,
    limit: number,
  ): CalendarOccurrence[] {
    const toMs = fromMs + DEFAULT_LIST_HORIZON_MS;
    const masters = this.candidateMasters(discordUserId, fromMs, toMs);
    return expandAndMerge(masters, fromMs, toMs).slice(0, limit);
  }

  search(
    discordUserId: string,
    q: string,
    fromMs: number | null,
    toMs: number | null,
    limit: number,
  ): CalendarOccurrence[] {
    const like = `%${q}%`;
    const lo = fromMs ?? 0;
    // When the caller doesn't bound the upper end, anchor it to wall-clock
    // "now + horizon" rather than `lo + horizon` — otherwise a search with
    // no bounds on a clock whose `lo` defaults to epoch would yield a
    // hi-bound of 1970-04-01 and exclude every event.
    const hi = toMs ?? Date.now() + DEFAULT_LIST_HORIZON_MS;
    const masters = this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE discord_user_id = ?
           AND (title LIKE ? OR IFNULL(description, '') LIKE ?)
           AND start_at <= ?
           AND (
             recurrence_freq IS NULL AND start_at >= ?
             OR recurrence_freq IS NOT NULL
                AND (recurrence_until IS NULL OR recurrence_until >= ?)
           )`,
      )
      .all(discordUserId, like, like, hi, lo, lo) as CalendarEvent[];
    return expandAndMerge(masters, lo, hi).slice(0, limit);
  }

  get(discordUserId: string, id: number): CalendarEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_events WHERE discord_user_id = ? AND id = ?`)
      .get(discordUserId, id);
    return (row as CalendarEvent | undefined) ?? null;
  }

  create(input: CreateEventInput): CalendarEvent {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO calendar_events
           (discord_user_id, created_by, title, description, start_at, end_at, location,
            recurrence_freq, recurrence_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.discord_user_id,
        input.discord_user_id, // created_by mirrors owner; preserved for downstream attribution
        input.title,
        input.description ?? null,
        input.start_at,
        input.end_at ?? null,
        input.location ?? null,
        input.recurrence_freq ?? null,
        input.recurrence_until ?? null,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const row = this.get(input.discord_user_id, id);
    if (!row) throw new Error('Failed to read back inserted event');
    return row;
  }

  /** Always scoped to the calling user — cannot mutate another user's event. */
  update(
    discordUserId: string,
    id: number,
    patch: UpdateEventInput,
  ): CalendarEvent | null {
    const existing = this.get(discordUserId, id);
    if (!existing) return null;
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    const setIf = <K extends keyof UpdateEventInput>(key: K, column: string) => {
      if (patch[key] !== undefined) {
        fields.push(`${column} = ?`);
        params.push(patch[key] as string | number | null);
      }
    };
    setIf('title', 'title');
    setIf('description', 'description');
    setIf('start_at', 'start_at');
    setIf('end_at', 'end_at');
    setIf('location', 'location');
    setIf('recurrence_freq', 'recurrence_freq');
    setIf('recurrence_until', 'recurrence_until');
    if (fields.length === 0) return existing;
    fields.push('updated_at = ?');
    params.push(Date.now());
    params.push(discordUserId, id);
    this.db
      .prepare(
        `UPDATE calendar_events SET ${fields.join(', ')} WHERE discord_user_id = ? AND id = ?`,
      )
      .run(...params);
    return this.get(discordUserId, id);
  }

  /** Always scoped to the calling user — cannot delete another user's event. */
  delete(discordUserId: string, id: number): CalendarEvent | null {
    const existing = this.get(discordUserId, id);
    if (!existing) return null;
    this.db
      .prepare(`DELETE FROM calendar_events WHERE discord_user_id = ? AND id = ?`)
      .run(discordUserId, id);
    return existing;
  }

  /**
   * Admin-only: list every event in the table, optionally filtered by owner.
   * Used by the configuration capability's `config_calendar_peek` tool.
   * Never call from a user-facing capability.
   */
  adminListAll(filterDiscordUserId: string | null): CalendarEvent[] {
    if (filterDiscordUserId === null) {
      return this.db
        .prepare(`SELECT * FROM calendar_events ORDER BY start_at ASC`)
        .all() as CalendarEvent[];
    }
    return this.db
      .prepare(
        `SELECT * FROM calendar_events WHERE discord_user_id = ? ORDER BY start_at ASC`,
      )
      .all(filterDiscordUserId) as CalendarEvent[];
  }

  /**
   * Admin-only: delete by id without the user filter. Used by the
   * configuration capability's `config_calendar_delete` tool for cross-user
   * recovery. Never call from a user-facing capability.
   */
  adminDelete(id: number): CalendarEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get(id) as CalendarEvent | undefined;
    if (!row) return null;
    this.db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
    return row;
  }
}

function expandAndMerge(
  masters: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number,
): CalendarOccurrence[] {
  const out: CalendarOccurrence[] = [];
  for (const m of masters) {
    const occs = expandOccurrences(m, windowStartMs, windowEndMs, DEFAULT_MAX_INSTANCES_PER_MASTER);
    for (const o of occs) {
      out.push(toOccurrence(m, o));
    }
  }
  out.sort((a, b) => a.start_at - b.start_at);
  return out;
}

function toOccurrence(master: CalendarEvent, occ: ExpandedOccurrence): CalendarOccurrence {
  return {
    id: master.id,
    discord_user_id: master.discord_user_id,
    created_by: master.created_by,
    title: master.title,
    description: master.description,
    location: master.location,
    recurrence_freq: master.recurrence_freq,
    recurrence_until: master.recurrence_until,
    created_at: master.created_at,
    updated_at: master.updated_at,
    start_at: occ.start_at,
    end_at: occ.end_at,
    occurrence_index: occ.occurrence_index,
    is_recurring_instance: master.recurrence_freq !== null && occ.occurrence_index > 0,
    master_start_at: master.start_at,
  };
}
