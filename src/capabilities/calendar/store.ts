import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';
import type { BroadcastChannel } from './broadcast.js';
import {
  expandOccurrences,
  type ExpandedOccurrence,
  type OccurrenceOverride,
  type RecurrenceFreq,
} from './recurrence.js';

/**
 * The calendar is **global** (like instagram_monitor): one shared set of events
 * for the whole server, managed by moderators from the bound input channel and
 * published as rendered month PDFs + an ICS file to the output channel. Any mod
 * can create / edit / delete any event; `created_by` records who added it for
 * attribution only — it is never used to scope reads or writes.
 */
export interface CalendarEvent {
  id: number;
  /** Discord snowflake of the mod who created the event (attribution only). */
  created_by: string;
  title: string;
  description: string | null;
  start_at: number;                       // master/anchor start, unix ms UTC
  end_at: number | null;
  location: string | null;
  recurrence_freq: RecurrenceFreq | null; // null = one-off event
  recurrence_until: number | null;        // unix ms UTC, inclusive cap on expansions
  /**
   * The Discord **Scheduled Event** this row corresponds to, if any — the thing
   * members click to RSVP and what the daily announcement links to. Written by
   * the bot when it creates one, or learned once by the announcer's matcher
   * (admins usually create these by hand, with a differently-worded title).
   */
  discord_event_id: string | null;
  /** Discord channel where the event flyer image message lives (durable pointer). */
  flyer_channel_id: string | null;
  /** Discord message id of the flyer image (CDN URLs expire; re-fetch at sync time). */
  flyer_image_message_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * An event as the model/renderer sees it: a one-off event or a single
 * occurrence of a recurring series. `id` is always the master row's id;
 * `start_at` is the occurrence that's actually displayed.
 */
export interface CalendarOccurrence extends Omit<CalendarEvent, 'start_at' | 'end_at'> {
  start_at: number;
  end_at: number | null;
  occurrence_index: number;          // 0 for one-offs and master, 1+ for instances
  is_recurring_instance: boolean;    // true iff this is a generated occurrence (i > 0)
  is_overridden: boolean;            // true iff a per-occurrence override applied
  master_start_at: number;
}

export interface CreateEventInput {
  created_by: string;
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

/** A published Discord message tracked so we can edit it in place. */
export interface PublishedMessage {
  pub_key: string;
  channel_id: string;
  message_id: string;
  updated_at: number;
}

/** How far ahead to expand recurring events for listing/snapshots. */
const DEFAULT_LIST_HORIZON_MS = 120 * 86_400_000; // 120 days
/** Hard cap on instances produced per master, regardless of horizon. */
const DEFAULT_MAX_INSTANCES_PER_MASTER = 60;

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
    version: 3,
    up: `
      DELETE FROM calendar_events;
      ALTER TABLE calendar_events ADD COLUMN discord_user_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS calendar_events_channel_user_start
        ON calendar_events (channel_id, discord_user_id, start_at);
    `,
  },
  {
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
  {
    // v5 — go GLOBAL. Drop per-user scoping entirely: events belong to the
    // whole server, not a Discord user. Existing rows are preserved (their
    // `created_by` becomes pure attribution). Adds the publish-tracking and
    // settings tables that back the output-channel month PDFs + ICS.
    version: 5,
    up: `
      CREATE TABLE calendar_events_global (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
      INSERT INTO calendar_events_global
        (id, created_by, title, description, start_at, end_at, location,
         recurrence_freq, recurrence_until, created_at, updated_at)
      SELECT id, created_by, title, description, start_at, end_at, location,
             recurrence_freq, recurrence_until, created_at, updated_at
      FROM calendar_events;
      DROP TABLE calendar_events;
      ALTER TABLE calendar_events_global RENAME TO calendar_events;
      CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events (start_at);

      CREATE TABLE IF NOT EXISTS calendar_published (
        pub_key     TEXT    PRIMARY KEY,
        channel_id  TEXT    NOT NULL,
        message_id  TEXT    NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_settings (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        output_channel_id TEXT,
        updated_at        INTEGER NOT NULL
      );
    `,
  },
  {
    // v6 — per-occurrence exceptions for recurring series. A row overrides (or
    // cancels) the single occurrence whose ORIGINAL anchor time is
    // `occurrence_start_at`. NULL field = inherit from the master. This backs
    // "edit/cancel only this occurrence"; "this and following" is a series split
    // and needs no rows here.
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS calendar_event_overrides (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        master_id           INTEGER NOT NULL,
        occurrence_start_at INTEGER NOT NULL,
        cancelled           INTEGER NOT NULL DEFAULT 0,
        start_at            INTEGER,
        end_at              INTEGER,
        title               TEXT,
        description         TEXT,
        location            TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE(master_id, occurrence_start_at)
      );
      CREATE INDEX IF NOT EXISTS calendar_event_overrides_master
        ON calendar_event_overrides (master_id);
    `,
  },
  {
    // v7 — the "same-day announcement" loop. Three additions:
    //
    //  1. `discord_event_id` links a calendar row to the Discord **Scheduled
    //     Event** members click to RSVP. It is either written by the bot (it
    //     created the event) or LEARNED once, by matching an admin-made Discord
    //     event to this row — so the match costs a model call at most once per
    //     event, never once per day.
    //  2. `calendar_announcements` is the idempotency ledger for the daily job:
    //     one row per thing already said. Presence of the row IS the "already
    //     announced" fact, so it survives restarts and a 10-min tick can't
    //     double-post (same trick `calendar_published` plays for month cards).
    //  3. the announcement channel + who to mention there, as settings — env
    //     seeds them on first boot, then the DB wins (like the output channel).
    version: 7,
    up: `
      ALTER TABLE calendar_events ADD COLUMN discord_event_id TEXT;

      CREATE TABLE IF NOT EXISTS calendar_announcements (
        announce_key        TEXT    PRIMARY KEY,
        event_id            INTEGER,
        occurrence_start_at INTEGER,
        channel_id          TEXT,
        message_id          TEXT,
        discord_event_id    TEXT,
        announced_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calendar_announcements_at
        ON calendar_announcements (announced_at DESC);

      ALTER TABLE calendar_settings ADD COLUMN announce_channel_id TEXT;
      ALTER TABLE calendar_settings ADD COLUMN announce_mentions_json TEXT;
    `,
  },
  {
    // v8 — durable flyer pointer on calendar events (Discord message ids, not CDN URLs).
    version: 8,
    up: `
      ALTER TABLE calendar_events ADD COLUMN flyer_channel_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN flyer_image_message_id TEXT;
    `,
  },
  {
    // v9 — on-demand announcements (a mod asking the bot to announce an event
    // now, in channels they name). The row IS the confirmation contract: the
    // draft stores the FINAL text, the resolved target channels and the mention
    // policy, so what a mod approved in the calendar channel is byte-identical
    // to what lands in the community's channels a turn later — and so a token
    // can only ever be spent once (`posted_at`).
    version: 9,
    up: `
      CREATE TABLE IF NOT EXISTS calendar_announcement_drafts (
        token                   TEXT    PRIMARY KEY,
        event_id                INTEGER NOT NULL,
        occurrence_start_at     INTEGER NOT NULL,
        channel_ids_json        TEXT    NOT NULL,
        content                 TEXT    NOT NULL,
        role_ids_json           TEXT    NOT NULL,
        everyone                INTEGER NOT NULL DEFAULT 0,
        image_url               TEXT,
        discord_event_id        TEXT,
        requested_by            TEXT    NOT NULL,
        source_channel_id       TEXT    NOT NULL,
        created_at              INTEGER NOT NULL,
        posted_at               INTEGER,
        posted_message_ids_json TEXT
      );
      CREATE INDEX IF NOT EXISTS calendar_announcement_drafts_created
        ON calendar_announcement_drafts (created_at DESC);
    `,
  },
  {
    // v10 — targets became objects, not bare channel ids.
    //
    // A forum channel is posted to differently (a new post, which needs a
    // title), and re-deriving that at confirmation time could disagree with the
    // preview the mod approved — so the resolved shape is stored with the draft.
    //
    // Replaces the table rather than migrating it: a draft is 30-minute
    // confirmation state (`DRAFT_TTL_MS`), so nothing here outlives the request
    // that made it, and an unconfirmed draft is meant to be re-drafted anyway.
    version: 10,
    up: `
      DROP TABLE IF EXISTS calendar_announcement_drafts;
      CREATE TABLE calendar_announcement_drafts (
        token                   TEXT    PRIMARY KEY,
        event_id                INTEGER NOT NULL,
        occurrence_start_at     INTEGER NOT NULL,
        targets_json            TEXT    NOT NULL,
        content                 TEXT    NOT NULL,
        thread_title            TEXT,
        role_ids_json           TEXT    NOT NULL,
        everyone                INTEGER NOT NULL DEFAULT 0,
        image_url               TEXT,
        discord_event_id        TEXT,
        requested_by            TEXT    NOT NULL,
        source_channel_id       TEXT    NOT NULL,
        created_at              INTEGER NOT NULL,
        posted_at               INTEGER,
        posted_message_ids_json TEXT
      );
      CREATE INDEX IF NOT EXISTS calendar_announcement_drafts_created
        ON calendar_announcement_drafts (created_at DESC);
    `,
  },
];

interface OverrideRow {
  id: number;
  master_id: number;
  occurrence_start_at: number;
  cancelled: number;
  start_at: number | null;
  end_at: number | null;
  title: string | null;
  description: string | null;
  location: string | null;
  created_at: number;
  updated_at: number;
}

function toOverride(r: OverrideRow): OccurrenceOverride {
  return {
    occurrence_start_at: r.occurrence_start_at,
    cancelled: r.cancelled !== 0,
    start_at: r.start_at,
    end_at: r.end_at,
    title: r.title,
    description: r.description,
    location: r.location,
  };
}

/** Fields an occurrence override can set (undefined = leave unchanged). */
export interface OverridePatch {
  start_at?: number;
  end_at?: number | null;
  title?: string;
  description?: string | null;
  location?: string | null;
}

/**
 * Type-safe access to the global calendar tables. No read/write is scoped by
 * user — every method operates on the one shared calendar.
 */
export class CalendarStore {
  constructor(private readonly db: Database.Database) {}

  /** Masters whose recurrence window could overlap [fromMs, toMs]. */
  private candidateMasters(fromMs: number, toMs: number): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE start_at <= ?
           AND (
             recurrence_freq IS NULL AND start_at >= ?
             OR recurrence_freq IS NOT NULL
                AND (recurrence_until IS NULL OR recurrence_until >= ?)
           )`,
      )
      .all(toMs, fromMs, fromMs) as CalendarEvent[];
  }

  listUpcoming(fromMs: number, limit: number): CalendarOccurrence[] {
    const toMs = fromMs + DEFAULT_LIST_HORIZON_MS;
    return this.expand(this.candidateMasters(fromMs, toMs), fromMs, toMs).slice(0, limit);
  }

  /** Expanded occurrences within an explicit window — used by the renderer. */
  listOccurrences(fromMs: number, toMs: number): CalendarOccurrence[] {
    return this.expand(this.candidateMasters(fromMs, toMs), fromMs, toMs);
  }

  /**
   * Fuzzy title/description search over the shared calendar.
   *
   * The old implementation was a raw `LIKE '%q%'`: a contiguous, accent- and
   * punctuation-sensitive substring match. But the model routinely echoes a
   * title with different punctuation/casing/accents than what's stored — e.g. it
   * searches `"club de poesia rosario castellanos"` for the stored
   * `"Club de poesía: Rosario Castellanos"` — and it may reorder words. The colon
   * and the dropped accent both broke the substring match, so real events came
   * back as zero rows and the bot wrongly told mods the event didn't exist.
   *
   * We now pull the candidate masters in the date window and rank them in JS
   * after Unicode-normalizing BOTH sides (lowercase, strip diacritics, fold
   * punctuation to spaces): a full-phrase hit wins, otherwise we score by the
   * fraction of *distinctive* query words present (stopwords like "de"/"la"
   * ignored). An empty / "*" query returns everything in the window (so a
   * broad `query:"*"` call behaves like a scoped list instead of matching zero).
   *
   * Returns at most ONE representative occurrence per matching master (the next
   * upcoming one, else the earliest), most-relevant first — so a weekly series
   * surfaces once, not ~17 times.
   */
  search(q: string, fromMs: number | null, toMs: number | null, limit: number): CalendarOccurrence[] {
    const lo = fromMs ?? 0;
    const hi = toMs ?? Date.now() + DEFAULT_LIST_HORIZON_MS;
    const normQuery = normalizeForSearch(q);

    const scored = this.candidateMasters(lo, hi)
      .map((master) => ({ master, score: searchScore(normQuery, master) }))
      .filter((x) => x.score >= SEARCH_MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.master.start_at - b.master.start_at);
    if (scored.length === 0) return [];

    // Expand only the matched masters, then collapse to one representative
    // occurrence per master (prefer the next upcoming one) so a recurring series
    // isn't returned dozens of times.
    const expanded = this.expand(scored.map((s) => s.master), lo, hi); // ascending by start_at
    const now = Date.now();
    const repByMaster = new Map<number, CalendarOccurrence>();
    for (const occ of expanded) {
      const cur = repByMaster.get(occ.id);
      if (!cur) { repByMaster.set(occ.id, occ); continue; }
      if (cur.start_at < now && occ.start_at >= now) repByMaster.set(occ.id, occ);
    }

    // Emit in relevance order (`scored` is already ranked).
    const out: CalendarOccurrence[] = [];
    for (const { master } of scored) {
      const rep = repByMaster.get(master.id);
      if (rep) out.push(rep);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Expand masters into occurrences, applying per-occurrence overrides. */
  private expand(masters: CalendarEvent[], windowStartMs: number, windowEndMs: number): CalendarOccurrence[] {
    const byMaster = this.overridesByMaster();
    const out: CalendarOccurrence[] = [];
    for (const m of masters) {
      const ovs = m.recurrence_freq !== null ? byMaster.get(m.id) : undefined;
      for (const o of expandOccurrences(m, windowStartMs, windowEndMs, DEFAULT_MAX_INSTANCES_PER_MASTER, ovs)) {
        out.push(toOccurrence(m, o));
      }
    }
    out.sort((a, b) => a.start_at - b.start_at);
    return out;
  }

  /** Every master, ordered by start — used to (re)build the ICS + render months. */
  listAll(): CalendarEvent[] {
    return this.db
      .prepare(`SELECT * FROM calendar_events ORDER BY start_at ASC`)
      .all() as CalendarEvent[];
  }

  get(id: number): CalendarEvent | null {
    const row = this.db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id);
    return (row as CalendarEvent | undefined) ?? null;
  }

  create(input: CreateEventInput): CalendarEvent {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO calendar_events
           (created_by, title, description, start_at, end_at, location,
            recurrence_freq, recurrence_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.created_by,
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
    const row = this.get(id);
    if (!row) throw new Error('Failed to read back inserted event');
    return row;
  }

  update(id: number, patch: UpdateEventInput): CalendarEvent | null {
    const existing = this.get(id);
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
    params.push(id);
    this.db
      .prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.get(id);
  }

  delete(id: number): CalendarEvent | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.prepare(`DELETE FROM calendar_event_overrides WHERE master_id = ?`).run(id);
    this.db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(id);
    return existing;
  }

  // ── Per-occurrence overrides (recurring-series exceptions) ──────────────────

  /** All overrides grouped master_id → (occurrence_start_at → override). */
  overridesByMaster(): Map<number, Map<number, OccurrenceOverride>> {
    const rows = this.db.prepare(`SELECT * FROM calendar_event_overrides`).all() as OverrideRow[];
    const out = new Map<number, Map<number, OccurrenceOverride>>();
    for (const r of rows) {
      let m = out.get(r.master_id);
      if (!m) { m = new Map(); out.set(r.master_id, m); }
      m.set(r.occurrence_start_at, toOverride(r));
    }
    return out;
  }

  /** Overrides for one master (for ICS). */
  listOverridesForMaster(masterId: number): OccurrenceOverride[] {
    return (this.db
      .prepare(`SELECT * FROM calendar_event_overrides WHERE master_id = ? ORDER BY occurrence_start_at`)
      .all(masterId) as OverrideRow[]).map(toOverride);
  }

  /** Edit a single occurrence (merges with any existing override; un-cancels it). */
  upsertOverride(masterId: number, occurrenceStartAt: number, patch: OverridePatch): void {
    const existing = this.db
      .prepare(`SELECT * FROM calendar_event_overrides WHERE master_id = ? AND occurrence_start_at = ?`)
      .get(masterId, occurrenceStartAt) as OverrideRow | undefined;
    const now = Date.now();
    const merged = {
      start_at: patch.start_at !== undefined ? patch.start_at : existing?.start_at ?? null,
      end_at: patch.end_at !== undefined ? patch.end_at : existing?.end_at ?? null,
      title: patch.title !== undefined ? patch.title : existing?.title ?? null,
      description: patch.description !== undefined ? patch.description : existing?.description ?? null,
      location: patch.location !== undefined ? patch.location : existing?.location ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO calendar_event_overrides
           (master_id, occurrence_start_at, cancelled, start_at, end_at, title, description, location, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(master_id, occurrence_start_at) DO UPDATE SET
           cancelled = 0,
           start_at = excluded.start_at, end_at = excluded.end_at,
           title = excluded.title, description = excluded.description, location = excluded.location,
           updated_at = excluded.updated_at`,
      )
      .run(masterId, occurrenceStartAt, merged.start_at, merged.end_at, merged.title, merged.description, merged.location, now, now);
  }

  /** Cancel (skip) a single occurrence. */
  cancelOccurrence(masterId: number, occurrenceStartAt: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO calendar_event_overrides
           (master_id, occurrence_start_at, cancelled, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(master_id, occurrence_start_at) DO UPDATE SET cancelled = 1, updated_at = excluded.updated_at`,
      )
      .run(masterId, occurrenceStartAt, now, now);
  }

  /** Drop overrides at/after a cutoff (used when splitting a series). */
  clearOverridesFrom(masterId: number, fromMs: number): void {
    this.db
      .prepare(`DELETE FROM calendar_event_overrides WHERE master_id = ? AND occurrence_start_at >= ?`)
      .run(masterId, fromMs);
  }

  /** Drop all overrides for a master (used when its rhythm changes). */
  deleteOverridesForMaster(masterId: number): void {
    this.db.prepare(`DELETE FROM calendar_event_overrides WHERE master_id = ?`).run(masterId);
  }

  // ── Published-message tracking (edit-in-place in the output channel) ────────

  getPublished(pubKey: string): PublishedMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_published WHERE pub_key = ?`)
      .get(pubKey);
    return (row as PublishedMessage | undefined) ?? null;
  }

  setPublished(pubKey: string, channelId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT INTO calendar_published (pub_key, channel_id, message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pub_key) DO UPDATE SET
           channel_id = excluded.channel_id,
           message_id = excluded.message_id,
           updated_at = excluded.updated_at`,
      )
      .run(pubKey, channelId, messageId, Date.now());
  }

  clearPublished(pubKey: string): void {
    this.db.prepare(`DELETE FROM calendar_published WHERE pub_key = ?`).run(pubKey);
  }

  /** All tracked published messages (used by the publisher to reconcile/clean up). */
  listPublished(): PublishedMessage[] {
    return this.db
      .prepare(`SELECT * FROM calendar_published ORDER BY pub_key`)
      .all() as PublishedMessage[];
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getOutputChannelId(): string | null {
    const row = this.db
      .prepare(`SELECT output_channel_id FROM calendar_settings WHERE id = 1`)
      .get() as { output_channel_id: string | null } | undefined;
    return row?.output_channel_id ?? null;
  }

  setOutputChannelId(channelId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO calendar_settings (id, output_channel_id, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           output_channel_id = excluded.output_channel_id,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, Date.now());
  }

  /** Community channel the daily "hoy hay evento" announcement is posted to. */
  getAnnounceChannelId(): string | null {
    const row = this.db
      .prepare(`SELECT announce_channel_id FROM calendar_settings WHERE id = 1`)
      .get() as { announce_channel_id: string | null } | undefined;
    return row?.announce_channel_id ?? null;
  }

  setAnnounceChannelId(channelId: string | null): void {
    this.upsertSetting('announce_channel_id', channelId);
  }

  /**
   * The mention setting exactly as stored, so callers can tell "never
   * configured" (null → the env seed still applies) from "configured to ping
   * nobody" (`"[]"`). See {@link ./announce-settings.js}.
   */
  getAnnounceMentionsRaw(): string | null {
    const row = this.db
      .prepare(`SELECT announce_mentions_json FROM calendar_settings WHERE id = 1`)
      .get() as { announce_mentions_json: string | null } | undefined;
    return row?.announce_mentions_json ?? null;
  }

  /**
   * Who the announcement pings: role snowflakes, and/or the literal token
   * `everyone` (→ `@everyone`). Empty = announce without pinging anyone.
   */
  getAnnounceMentions(): string[] {
    const raw = this.getAnnounceMentionsRaw();
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  setAnnounceMentions(tokens: string[]): void {
    const clean = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
    this.upsertSetting('announce_mentions_json', JSON.stringify(clean));
  }

  private upsertSetting(column: 'announce_channel_id' | 'announce_mentions_json', value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO calendar_settings (id, ${column}, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ${column} = excluded.${column},
           updated_at = excluded.updated_at`,
      )
      .run(value, Date.now());
  }

  // ── Discord Scheduled Event link ───────────────────────────────────────────

  /** Link (or unlink, with null) a calendar row to a Discord scheduled event. */
  setDiscordEventId(id: number, discordEventId: string | null): void {
    this.db
      .prepare(`UPDATE calendar_events SET discord_event_id = ?, updated_at = ? WHERE id = ?`)
      .run(discordEventId, Date.now(), id);
  }

  /** Durable pointer to the flyer image message (CDN URLs expire). */
  setFlyerPointer(id: number, channelId: string | null, messageId: string | null): void {
    this.db
      .prepare(
        `UPDATE calendar_events SET flyer_channel_id = ?, flyer_image_message_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(channelId, messageId, Date.now(), id);
  }

  // ── Announcement ledger (idempotency for the daily job) ────────────────────

  /** Whether this exact thing was already announced (survives restarts). */
  isAnnounced(announceKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM calendar_announcements WHERE announce_key = ?`)
      .get(announceKey);
    return row !== undefined;
  }

  recordAnnouncement(input: {
    announceKey: string;
    eventId: number | null;
    occurrenceStartAt: number | null;
    channelId: string;
    messageId: string | null;
    discordEventId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO calendar_announcements
           (announce_key, event_id, occurrence_start_at, channel_id, message_id,
            discord_event_id, announced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(announce_key) DO UPDATE SET
           message_id       = excluded.message_id,
           discord_event_id = excluded.discord_event_id,
           announced_at     = excluded.announced_at`,
      )
      .run(
        input.announceKey,
        input.eventId,
        input.occurrenceStartAt,
        input.channelId,
        input.messageId,
        input.discordEventId,
        Date.now(),
      );
  }

  recentAnnouncements(limit: number): AnnouncementRow[] {
    return this.db
      .prepare(`SELECT * FROM calendar_announcements ORDER BY announced_at DESC LIMIT ?`)
      .all(limit) as AnnouncementRow[];
  }

  // ── On-demand announcement drafts (the confirm-then-post contract) ──────────

  /**
   * Park a drafted announcement under a one-shot token.
   *
   * The text, the target channels and the mention policy are ALL stored, not
   * re-derived at post time: a mod approves a concrete message in the calendar
   * channel, and the thing that lands in the community's channels has to be
   * that exact message. Re-generating it on confirmation would re-roll the
   * model and make the preview a lie.
   */
  saveAnnouncementDraft(input: {
    token: string;
    eventId: number;
    occurrenceStartAt: number;
    targets: readonly BroadcastChannel[];
    content: string;
    /** Title for a forum post; null when no target is a forum. */
    threadTitle: string | null;
    roleIds: readonly string[];
    everyone: boolean;
    imageUrl: string | null;
    discordEventId: string | null;
    requestedBy: string;
    sourceChannelId: string;
    /**
     * When the draft was made. Passed in rather than read from the clock here
     * because the TTL that decides whether it may still be confirmed is measured
     * against the *turn's* injected time — two clocks for one comparison is how
     * a freshly parked draft ends up looking expired.
     */
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO calendar_announcement_drafts
           (token, event_id, occurrence_start_at, targets_json, content, thread_title,
            role_ids_json, everyone, image_url, discord_event_id, requested_by,
            source_channel_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
           event_id            = excluded.event_id,
           occurrence_start_at = excluded.occurrence_start_at,
           targets_json        = excluded.targets_json,
           content             = excluded.content,
           thread_title        = excluded.thread_title,
           role_ids_json       = excluded.role_ids_json,
           everyone            = excluded.everyone,
           image_url           = excluded.image_url,
           discord_event_id    = excluded.discord_event_id,
           created_at          = excluded.created_at`,
      )
      .run(
        input.token,
        input.eventId,
        input.occurrenceStartAt,
        JSON.stringify([...input.targets]),
        input.content,
        input.threadTitle,
        JSON.stringify([...input.roleIds]),
        input.everyone ? 1 : 0,
        input.imageUrl,
        input.discordEventId,
        input.requestedBy,
        input.sourceChannelId,
        input.createdAt,
      );
  }

  getAnnouncementDraft(token: string): AnnouncementDraft | null {
    const row = this.db
      .prepare(`SELECT * FROM calendar_announcement_drafts WHERE token = ?`)
      .get(token) as AnnouncementDraftRow | undefined;
    return row ? toDraft(row) : null;
  }

  /** Newest unposted draft for this source channel — the "sí, publícalo" fallback. */
  latestPendingDraft(sourceChannelId: string): AnnouncementDraft | null {
    const row = this.db
      .prepare(
        `SELECT * FROM calendar_announcement_drafts
         WHERE source_channel_id = ? AND posted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceChannelId) as AnnouncementDraftRow | undefined;
    return row ? toDraft(row) : null;
  }

  /**
   * Burn the token. Returns false when it was already spent — that's the
   * single-use guarantee, enforced by SQLite rather than by the model
   * remembering it already posted (`UPDATE … WHERE posted_at IS NULL` is
   * atomic, so two racing confirmations can't both win).
   */
  markDraftPosted(token: string, messageIds: readonly string[]): boolean {
    const info = this.db
      .prepare(
        `UPDATE calendar_announcement_drafts
         SET posted_at = ?, posted_message_ids_json = ?
         WHERE token = ? AND posted_at IS NULL`,
      )
      .run(Date.now(), JSON.stringify([...messageIds]), token);
    return info.changes > 0;
  }
}

/** A drafted on-demand announcement, as stored. */
export interface AnnouncementDraft {
  token: string;
  eventId: number;
  occurrenceStartAt: number;
  targets: BroadcastChannel[];
  content: string;
  threadTitle: string | null;
  roleIds: string[];
  everyone: boolean;
  imageUrl: string | null;
  discordEventId: string | null;
  requestedBy: string;
  sourceChannelId: string;
  createdAt: number;
  postedAt: number | null;
  postedMessageIds: string[];
}

interface AnnouncementDraftRow {
  token: string;
  event_id: number;
  occurrence_start_at: number;
  targets_json: string;
  content: string;
  thread_title: string | null;
  role_ids_json: string;
  everyone: number;
  image_url: string | null;
  discord_event_id: string | null;
  requested_by: string;
  source_channel_id: string;
  created_at: number;
  posted_at: number | null;
  posted_message_ids_json: string | null;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Targets round-trip through JSON, so a row written by an older build (or a
 * hand-edited one) can't crash a confirmation: anything unrecognizable is
 * dropped, and a missing `kind` degrades to a plain text channel, which is how
 * every target behaved before forums were supported.
 */
function parseTargets(raw: string | null): BroadcastChannel[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((t): BroadcastChannel[] => {
      if (typeof t === 'string') return [{ id: t, name: t, kind: 'text' }];
      if (!t || typeof t !== 'object') return [];
      const { id, name, kind } = t as Record<string, unknown>;
      if (typeof id !== 'string' || id === '') return [];
      return [
        {
          id,
          name: typeof name === 'string' ? name : id,
          kind: kind === 'forum' ? 'forum' : 'text',
        },
      ];
    });
  } catch {
    return [];
  }
}

function toDraft(r: AnnouncementDraftRow): AnnouncementDraft {
  return {
    token: r.token,
    eventId: r.event_id,
    occurrenceStartAt: r.occurrence_start_at,
    targets: parseTargets(r.targets_json),
    content: r.content,
    threadTitle: r.thread_title,
    roleIds: parseStringArray(r.role_ids_json),
    everyone: r.everyone !== 0,
    imageUrl: r.image_url,
    discordEventId: r.discord_event_id,
    requestedBy: r.requested_by,
    sourceChannelId: r.source_channel_id,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    postedMessageIds: parseStringArray(r.posted_message_ids_json),
  };
}

/** A row of the announcement ledger. */
export interface AnnouncementRow {
  announce_key: string;
  event_id: number | null;
  occurrence_start_at: number | null;
  channel_id: string | null;
  message_id: string | null;
  discord_event_id: string | null;
  announced_at: number;
}

/** Minimum `searchScore` for a master to be considered a match. */
const SEARCH_MIN_SCORE = 0.6;

/**
 * Words too common to be distinctive in Spanish/English event titles. Dropped
 * from the token-fraction score so "club de cine" doesn't half-match every
 * "club de …" event on the shared "club"/"de" tokens alone.
 */
const SEARCH_STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'a', 'en',
  'del', 'con', 'para', 'por', 'the', 'of', 'and', 'to', 'in', 'on',
]);

/** Lowercase, strip diacritics, fold punctuation to spaces, collapse whitespace. */
function normalizeForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ') // punctuation (incl. the ":" that broke LIKE) → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How well a normalized query matches an event (0 = no match, higher = better):
 *  - empty query → 1 (match everything, so a "*"/list-style call returns all)
 *  - full normalized phrase is a substring of title+description → 2 (best)
 *  - otherwise the fraction of distinctive query words present (0..1)
 */
function searchScore(normQuery: string, event: CalendarEvent): number {
  if (normQuery === '') return 1;
  const hay = normalizeForSearch(`${event.title} ${event.description ?? ''}`);
  if (hay.includes(normQuery)) return 2;
  const all = normQuery.split(' ').filter(Boolean);
  const distinctive = all.filter((t) => t.length > 1 && !SEARCH_STOPWORDS.has(t));
  const tokens = distinctive.length > 0 ? distinctive : all;
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const t of tokens) if (hay.includes(t)) matched++;
  return matched / tokens.length;
}

function toOccurrence(master: CalendarEvent, occ: ExpandedOccurrence): CalendarOccurrence {
  const ov = occ.override;
  return {
    id: master.id,
    created_by: master.created_by,
    title: ov?.title ?? master.title,
    description: ov?.description ?? master.description,
    location: ov?.location ?? master.location,
    recurrence_freq: master.recurrence_freq,
    recurrence_until: master.recurrence_until,
    discord_event_id: master.discord_event_id,
    flyer_channel_id: master.flyer_channel_id,
    flyer_image_message_id: master.flyer_image_message_id,
    created_at: master.created_at,
    updated_at: master.updated_at,
    start_at: occ.start_at,
    end_at: occ.end_at,
    occurrence_index: occ.occurrence_index,
    is_recurring_instance: master.recurrence_freq !== null && occ.occurrence_index > 0,
    is_overridden: ov !== null && !ov.cancelled,
    master_start_at: master.start_at,
  };
}
