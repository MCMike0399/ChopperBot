import type Database from 'better-sqlite3';
import type { Migration } from '../../memory/store.js';
import type { ParsedForm } from './parse.js';

/**
 * Lifecycle of a ticket the intake has seen. `cancelled` = the event this ticket
 * approved was later deleted from the calendar (a mod can now cancel from the
 * ticket itself), so the row no longer points at a live calendar id.
 */
export type TicketStatus = 'proposed' | 'created' | 'dismissed' | 'cancelled';

/** Flyer job lifecycle for tickets where Agitprop makes the design. */
export type FlyerStatus = 'none' | 'requested' | 'delivered' | 'cancelled';

/** One row per ticket channel — dedup anchor + approval-flow state. */
export interface TicketRow {
  channel_id: string;
  guild_id: string | null;
  requester_id: string | null;
  parsed_form_json: string | null;
  resolved_start_at: number | null;
  status: TicketStatus;
  proposal_message_id: string | null;
  created_event_id: number | null;
  flyer_status: FlyerStatus;
  flyer_request_message_id: string | null;
  flyer_image_channel_id: string | null;
  flyer_image_message_id: string | null;
  flyer_notes: string | null;
  created_at: number;
  updated_at: number;
}

export const EVENT_INTAKE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      -- Single-row settings (id=1): which ticket CATEGORIES the passive watcher
      -- reads forms in, and which role ids may APPROVE (→ create the event).
      CREATE TABLE IF NOT EXISTS event_intake_settings (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        watched_categories_json TEXT  NOT NULL DEFAULT '[]',
        mod_roles_json          TEXT  NOT NULL DEFAULT '[]',
        updated_at             INTEGER
      );
      INSERT OR IGNORE INTO event_intake_settings (id) VALUES (1);

      -- One row per ticket channel: dedup (post only ONE auto-proposal, survives
      -- restart) + the parsed form (injected into the prompt every turn, since
      -- buildHistory can't reach the foreign-bot form message) + approval state.
      CREATE TABLE IF NOT EXISTS event_intake_tickets (
        channel_id          TEXT    PRIMARY KEY,
        guild_id            TEXT,
        requester_id        TEXT,
        parsed_form_json    TEXT,
        resolved_start_at   INTEGER,
        status              TEXT    NOT NULL DEFAULT 'proposed',
        proposal_message_id TEXT,
        created_event_id    INTEGER,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_intake_tickets_updated
        ON event_intake_tickets (updated_at DESC);
    `,
  },
  {
    // v2 — Agitprop flyer inbox: channel + roles in settings; per-ticket flyer job
    // state and durable Discord message pointers (CDN URLs expire).
    version: 2,
    up: `
      ALTER TABLE event_intake_settings ADD COLUMN agitprop_channel_id TEXT;
      ALTER TABLE event_intake_settings ADD COLUMN agitprop_roles_json TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE event_intake_tickets ADD COLUMN flyer_status TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE event_intake_tickets ADD COLUMN flyer_request_message_id TEXT;
      ALTER TABLE event_intake_tickets ADD COLUMN flyer_image_channel_id TEXT;
      ALTER TABLE event_intake_tickets ADD COLUMN flyer_image_message_id TEXT;
      ALTER TABLE event_intake_tickets ADD COLUMN flyer_notes TEXT;
    `,
  },
];

/**
 * SQLite-backed state for event_intake: the watched ticket-category set + the
 * approving-role set (both single-row, seed-from-env-then-DB-wins like
 * FileScannerStore), and the per-ticket dedup/approval rows. All methods are
 * synchronous (better-sqlite3) and safe from both the listener and the admin
 * tools on the shared db handle.
 */
export class EventIntakeStore {
  constructor(private readonly db: Database.Database) {}

  // ── Watched categories ──────────────────────────────────────────────────

  getWatchedCategories(): string[] {
    const row = this.db
      .prepare('SELECT watched_categories_json FROM event_intake_settings WHERE id = 1')
      .get() as { watched_categories_json: string } | undefined;
    return parseIdArray(row?.watched_categories_json);
  }

  setWatchedCategories(ids: string[]): void {
    this.db
      .prepare('UPDATE event_intake_settings SET watched_categories_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(dedupeIds(ids)), Date.now());
  }

  /** One-time seed from env: only writes if nothing configured yet (edits survive restart). */
  seedWatchedCategories(ids: string[]): void {
    if (ids.length === 0) return;
    if (this.getWatchedCategories().length > 0) return;
    this.setWatchedCategories(ids);
  }

  // ── Approving roles (names or ids) ─────────────────────────────────────────

  getModRoles(): string[] {
    const row = this.db
      .prepare('SELECT mod_roles_json FROM event_intake_settings WHERE id = 1')
      .get() as { mod_roles_json: string } | undefined;
    return parseIdArray(row?.mod_roles_json);
  }

  setModRoles(roles: string[]): void {
    this.db
      .prepare('UPDATE event_intake_settings SET mod_roles_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(dedupeIds(roles)), Date.now());
  }

  seedModRoles(roles: string[]): void {
    if (roles.length === 0) return;
    if (this.getModRoles().length > 0) return;
    this.setModRoles(roles);
  }

  // ── Agitprop inbox (channel + roles) ─────────────────────────────────────

  getAgitpropChannelId(): string | null {
    const row = this.db
      .prepare('SELECT agitprop_channel_id FROM event_intake_settings WHERE id = 1')
      .get() as { agitprop_channel_id: string | null } | undefined;
    return row?.agitprop_channel_id ?? null;
  }

  setAgitpropChannelId(channelId: string | null): void {
    this.db
      .prepare('UPDATE event_intake_settings SET agitprop_channel_id = ?, updated_at = ? WHERE id = 1')
      .run(channelId, Date.now());
  }

  /** One-time seed from env: only writes if nothing configured yet. */
  seedAgitpropChannelId(channelId: string): void {
    if (!channelId) return;
    if (this.getAgitpropChannelId()) return;
    this.setAgitpropChannelId(channelId);
  }

  getAgitpropRoles(): string[] {
    const row = this.db
      .prepare('SELECT agitprop_roles_json FROM event_intake_settings WHERE id = 1')
      .get() as { agitprop_roles_json: string } | undefined;
    return parseIdArray(row?.agitprop_roles_json);
  }

  setAgitpropRoles(roles: string[]): void {
    this.db
      .prepare('UPDATE event_intake_settings SET agitprop_roles_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(dedupeIds(roles)), Date.now());
  }

  seedAgitpropRoles(roles: string[]): void {
    if (roles.length === 0) return;
    if (this.getAgitpropRoles().length > 0) return;
    this.setAgitpropRoles(roles);
  }

  // ── Ticket rows ─────────────────────────────────────────────────────────

  getTicket(channelId: string): TicketRow | undefined {
    return this.db
      .prepare('SELECT * FROM event_intake_tickets WHERE channel_id = ?')
      .get(channelId) as TicketRow | undefined;
  }

  /**
   * Record (or refresh) a ticket's proposal. Idempotent on channel_id — the
   * caller checks `getTicket` first so a second form event never re-proposes.
   */
  recordProposal(input: {
    channelId: string;
    guildId: string | null;
    requesterId: string | null;
    parsedForm: ParsedForm;
    resolvedStartAt: number | null;
    proposalMessageId: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO event_intake_tickets
           (channel_id, guild_id, requester_id, parsed_form_json, resolved_start_at,
            status, proposal_message_id, created_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, NULL, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           guild_id            = excluded.guild_id,
           requester_id        = excluded.requester_id,
           parsed_form_json    = excluded.parsed_form_json,
           resolved_start_at   = excluded.resolved_start_at,
           proposal_message_id = excluded.proposal_message_id,
           updated_at          = excluded.updated_at`,
      )
      .run(
        input.channelId,
        input.guildId,
        input.requesterId,
        JSON.stringify(input.parsedForm),
        input.resolvedStartAt,
        input.proposalMessageId,
        now,
        now,
      );
  }

  /** Mark a ticket's event as created (approval done). */
  markCreated(channelId: string, eventId: number): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets
           SET status = 'created', created_event_id = ?, updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(eventId, Date.now(), channelId);
  }

  /**
   * The event this ticket approved was deleted from the calendar (whole series).
   * Clears the id as well as the status: everything that reads `created_event_id`
   * — the missing-Discord-card repair, `recent_tickets` — must not chase a row
   * that no longer exists. No migration: `status` is a plain TEXT column.
   */
  markEventDeleted(channelId: string): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets
           SET status = 'cancelled', created_event_id = NULL, updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(Date.now(), channelId);
  }

  /** Open or refresh a flyer job on a ticket (Agitprop request card posted). */
  markFlyerRequested(channelId: string, requestMessageId: string, notes?: string | null): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets
           SET flyer_status = 'requested',
               flyer_request_message_id = ?,
               flyer_notes = COALESCE(?, flyer_notes),
               updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(requestMessageId, notes ?? null, Date.now(), channelId);
  }

  /** The delivered flyer lives at this Discord message (durable pointer). */
  markFlyerDelivered(
    channelId: string,
    imageChannelId: string,
    imageMessageId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets
           SET flyer_status = 'delivered',
               flyer_image_channel_id = ?,
               flyer_image_message_id = ?,
               updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(imageChannelId, imageMessageId, Date.now(), channelId);
  }

  markFlyerCancelled(channelId: string): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets
           SET flyer_status = 'cancelled', updated_at = ?
         WHERE channel_id = ?`,
      )
      .run(Date.now(), channelId);
  }

  /** Update flyer brief notes (does not change status). */
  setFlyerNotes(channelId: string, notes: string | null): void {
    this.db
      .prepare(
        `UPDATE event_intake_tickets SET flyer_notes = ?, updated_at = ? WHERE channel_id = ?`,
      )
      .run(notes, Date.now(), channelId);
  }

  /** Tickets with an open flyer job (requested, not yet delivered/cancelled). */
  openFlyerJobs(limit = 20): TicketRow[] {
    return this.db
      .prepare(
        `SELECT * FROM event_intake_tickets
         WHERE flyer_status = 'requested'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as TicketRow[];
  }

  /** Find a ticket by its Agitprop request-card message id. */
  getTicketByFlyerRequestMessage(messageId: string): TicketRow | undefined {
    return this.db
      .prepare('SELECT * FROM event_intake_tickets WHERE flyer_request_message_id = ?')
      .get(messageId) as TicketRow | undefined;
  }

  recentTickets(limit: number): TicketRow[] {
    return this.db
      .prepare('SELECT * FROM event_intake_tickets ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as TicketRow[];
  }

  /** Parse a ticket row's stored form back into a ParsedForm (null on garbage). */
  static parseForm(row: TicketRow | undefined): ParsedForm | null {
    if (!row?.parsed_form_json) return null;
    try {
      return JSON.parse(row.parsed_form_json) as ParsedForm;
    } catch {
      return null;
    }
  }
}

function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}
