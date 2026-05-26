import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';
import {
  expandOccurrences,
  type ExpandedOccurrence,
  type RecurrenceFreq,
} from './recurrence.js';

/**
 * 'mine' = only events whose discord_user_id matches the caller.
 * 'all'  = every event in the channel, regardless of owner.
 *
 * Read-side knob only. Mutations are always 'mine' — a user can never
 * update or delete another user's event through this store (admin tools
 * in the configuration capability bypass this for cross-user admin ops).
 */
export type CalendarScope = 'mine' | 'all';

export interface CalendarEvent {
  id: number;
  channel_id: string;
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
 * whole series. Callers that surface this to the user should warn about
 * series-wide effects.
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
  channel_id: string;
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
    // Per-user scoping. Existing rows in prod are test data → wipe before
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
];

/**
 * Type-safe access to the calendar_events table.
 *
 * Every query is hard-scoped by `channel_id`. Read queries additionally
 * accept a `discord_user_id` + `scope`:
 *  - scope='mine' filters to that user's events (default for tools).
 *  - scope='all'  ignores the user filter so a member can see channel-wide
 *    events when they ask explicitly ("what's on the team calendar?").
 *
 * Mutations (`update`, `delete`) are always scoped to the calling user —
 * there is no `scope` knob, by design. Cross-user admin operations live in
 * the configuration capability.
 */
export class CalendarStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Master rows in this channel whose start_at <= toMs and whose recurrence
   * window (if any) hasn't fully elapsed before fromMs. Used as the input
   * to occurrence expansion. Non-recurring events past fromMs are included
   * here too; the expansion step filters them.
   */
  private candidateMasters(
    channelId: string,
    discordUserId: string,
    scope: CalendarScope,
    fromMs: number,
    toMs: number,
  ): CalendarEvent[] {
    const userClause = scope === 'mine' ? 'AND discord_user_id = ?' : '';
    const params: (string | number)[] = [channelId];
    if (scope === 'mine') params.push(discordUserId);
    params.push(toMs, fromMs, fromMs);
    return this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE channel_id = ?
           ${userClause}
           AND start_at <= ?
           AND (
             recurrence_freq IS NULL AND start_at >= ?
             OR recurrence_freq IS NOT NULL
                AND (recurrence_until IS NULL OR recurrence_until >= ?)
           )`,
      )
      .all(...params) as CalendarEvent[];
  }

  listUpcoming(
    channelId: string,
    discordUserId: string,
    scope: CalendarScope,
    fromMs: number,
    limit: number,
  ): CalendarOccurrence[] {
    const toMs = fromMs + DEFAULT_LIST_HORIZON_MS;
    const masters = this.candidateMasters(channelId, discordUserId, scope, fromMs, toMs);
    const merged = expandAndMerge(masters, fromMs, toMs);
    return merged.slice(0, limit);
  }

  search(
    channelId: string,
    discordUserId: string,
    scope: CalendarScope,
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
    const userClause = scope === 'mine' ? 'AND discord_user_id = ?' : '';
    const params: (string | number)[] = [channelId];
    if (scope === 'mine') params.push(discordUserId);
    params.push(like, like, hi, lo, lo);
    // Master-level text filter first (cheap), then expand into the window.
    const masters = this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE channel_id = ?
           ${userClause}
           AND (title LIKE ? OR IFNULL(description, '') LIKE ?)
           AND start_at <= ?
           AND (
             recurrence_freq IS NULL AND start_at >= ?
             OR recurrence_freq IS NOT NULL
                AND (recurrence_until IS NULL OR recurrence_until >= ?)
           )`,
      )
      .all(...params) as CalendarEvent[];
    return expandAndMerge(masters, lo, hi).slice(0, limit);
  }

  get(
    channelId: string,
    discordUserId: string,
    scope: CalendarScope,
    id: number,
  ): CalendarEvent | null {
    if (scope === 'all') {
      const row = this.db
        .prepare(`SELECT * FROM calendar_events WHERE channel_id = ? AND id = ?`)
        .get(channelId, id);
      return (row as CalendarEvent | undefined) ?? null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM calendar_events WHERE channel_id = ? AND discord_user_id = ? AND id = ?`,
      )
      .get(channelId, discordUserId, id);
    return (row as CalendarEvent | undefined) ?? null;
  }

  create(input: CreateEventInput): CalendarEvent {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO calendar_events
           (channel_id, discord_user_id, created_by, title, description, start_at, end_at, location,
            recurrence_freq, recurrence_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel_id,
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
    const row = this.get(input.channel_id, input.discord_user_id, 'mine', id);
    if (!row) throw new Error('Failed to read back inserted event');
    return row;
  }

  /** Always scoped to the calling user — cannot mutate another user's event. */
  update(
    channelId: string,
    discordUserId: string,
    id: number,
    patch: UpdateEventInput,
  ): CalendarEvent | null {
    const existing = this.get(channelId, discordUserId, 'mine', id);
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
    params.push(channelId, discordUserId, id);
    this.db
      .prepare(
        `UPDATE calendar_events SET ${fields.join(', ')} WHERE channel_id = ? AND discord_user_id = ? AND id = ?`,
      )
      .run(...params);
    return this.get(channelId, discordUserId, 'mine', id);
  }

  /** Always scoped to the calling user — cannot delete another user's event. */
  delete(channelId: string, discordUserId: string, id: number): CalendarEvent | null {
    const existing = this.get(channelId, discordUserId, 'mine', id);
    if (!existing) return null;
    this.db
      .prepare(
        `DELETE FROM calendar_events WHERE channel_id = ? AND discord_user_id = ? AND id = ?`,
      )
      .run(channelId, discordUserId, id);
    return existing;
  }

  /**
   * Admin-only: delete by id without the user filter. Used by the
   * configuration capability's `config_calendar_delete` tool for cross-user
   * recovery. Never call from a user-facing capability.
   */
  adminDelete(channelId: string, id: number): CalendarEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_events WHERE channel_id = ? AND id = ?`)
      .get(channelId, id) as CalendarEvent | undefined;
    if (!row) return null;
    this.db
      .prepare(`DELETE FROM calendar_events WHERE channel_id = ? AND id = ?`)
      .run(channelId, id);
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
    channel_id: master.channel_id,
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
