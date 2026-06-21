import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { CalendarStore, type CalendarEvent, type UpdateEventInput } from '../calendar/store.js';
import { isRecurrenceFreq, RECURRENCE_FREQUENCIES, type RecurrenceFreq } from '../calendar/recurrence.js';
import { formatInTimezone } from '../calendar/time.js';
import type { UserDirectory } from '../../users/store.js';

export interface ConfigCalendarAdminDeps {
  db: Database.Database;
  userDirectory: UserDirectory;
  callerUserId: string;
}

/**
 * Calendar admin from the config channel. The calendar is GLOBAL, so this is
 * just the same shared store reached from the admin console — handy for
 * inspecting/repairing events without going to the input channel, and for
 * pointing the calendar at a different output channel.
 */
export class ConfigCalendarAdminSource implements ToolSource {
  readonly name = 'config_calendar';
  private readonly store: CalendarStore;

  constructor(private readonly deps: ConfigCalendarAdminDeps) {
    this.store = new CalendarStore(deps.db);
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'config_calendar',
        description:
          'Admin of the GLOBAL server calendar from the config channel. `action`:\n' +
          '• "peek" {limit?} — list events (each row shows the creator id + tag).\n' +
          '• "create" {title, start_at_iso, end_at_iso?, description?, location?, recurrence_freq?, recurrence_until_iso?} — create an event.\n' +
          '• "update" {event_id, confirm, ...same fields} — edit any event (whole series for recurring). Requires confirm:true.\n' +
          '• "delete" {event_id, confirm} — delete any event (whole series for recurring). Requires confirm:true.\n' +
          '• "get_output_channel" — show the channel where month PDFs + ICS are published.\n' +
          '• "set_output_channel" {channel_id} — change that output channel.\n' +
          'NOTE: this does NOT auto-publish; mutations from the config channel only change the DB. Use the input channel (or ask a mod to run `calendar_publish` there) to re-post the rendered PDFs. Pass times as ISO 8601 UTC.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['peek', 'create', 'update', 'delete', 'get_output_channel', 'set_output_channel'],
            },
            event_id: { type: 'integer', minimum: 1, description: 'Required for "update"/"delete".' },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            start_at_iso: { type: 'string', description: 'ISO 8601 UTC.' },
            end_at_iso: { type: 'string', description: 'ISO 8601 UTC, or null to clear (update only).' },
            description: { type: 'string' },
            location: { type: 'string' },
            recurrence_freq: {
              description: 'daily/weekly/monthly, or null to clear recurrence (update).',
              oneOf: [{ type: 'string', enum: [...RECURRENCE_FREQUENCIES] }, { type: 'null' }],
            },
            recurrence_until_iso: {
              description: 'ISO 8601 UTC last occurrence, or null to clear.',
              oneOf: [{ type: 'string' }, { type: 'null' }],
            },
            channel_id: { type: 'string', description: 'Discord snowflake for "set_output_channel".' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'For "peek".' },
            confirm: { type: 'boolean', description: 'Must be true for "update"/"delete".' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    if (toolName !== 'config_calendar') {
      return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
    }
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      const action = asAction(obj.action, [
        'peek', 'create', 'update', 'delete', 'get_output_channel', 'set_output_channel',
      ]);
      switch (action) {
        case 'peek':
          return this.handlePeek(obj);
        case 'create':
          return this.handleCreate(obj, t0);
        case 'update':
          return this.handleUpdate(obj, t0);
        case 'delete':
          return this.handleDelete(obj, t0);
        case 'get_output_channel':
          return { status: 'success', payload: { output_channel_id: this.store.getOutputChannelId() } };
        case 'set_output_channel':
          return this.handleSetOutputChannel(obj);
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private handlePeek(obj: Record<string, unknown>): ToolHandlerResult {
    const limit = clampInt(obj.limit, 1, 50, 20);
    const rows = this.store.listAll().slice(0, limit);
    return { status: 'success', payload: { events: rows.map((e) => this.serialize(e)) } };
  }

  private handleCreate(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const title = asNonEmptyString(obj.title, 'title');
    const startMs = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
    const endMs = parseOptionalIso(obj.end_at_iso, 'end_at_iso');
    if (endMs !== null && endMs < startMs) {
      return { status: 'error', payload: { error: 'end_at_iso must be after start_at_iso.' } };
    }
    const recurrenceFreq = parseRecurrenceFreq(obj.recurrence_freq);
    const recurrenceUntil = parseOptionalIso(obj.recurrence_until_iso, 'recurrence_until_iso');
    if (recurrenceUntil !== null && recurrenceFreq === null) {
      return { status: 'error', payload: { error: 'recurrence_until_iso requires recurrence_freq to also be set.' } };
    }
    if (recurrenceUntil !== null && recurrenceUntil < startMs) {
      return { status: 'error', payload: { error: 'recurrence_until_iso must be on or after start_at_iso.' } };
    }
    const created = this.store.create({
      created_by: this.deps.callerUserId,
      title,
      start_at: startMs,
      end_at: endMs,
      description: asOptionalString(obj.description),
      location: asOptionalString(obj.location),
      recurrence_freq: recurrenceFreq,
      recurrence_until: recurrenceUntil,
    });
    log.info({ tool: 'config_calendar.create', id: created.id, ms: Date.now() - t0 }, 'tool_call');
    return { status: 'success', payload: { event: this.serialize(created) } };
  }

  private handleUpdate(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const eventId = asPositiveInt(obj.event_id, 'event_id');
    if (obj.confirm !== true) {
      return { status: 'error', payload: { error: 'Refusing to edit without `confirm: true`.' } };
    }
    const patch: UpdateEventInput = {};
    if (obj.title !== undefined) patch.title = asNonEmptyString(obj.title, 'title');
    if (obj.start_at_iso !== undefined) patch.start_at = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
    if (obj.end_at_iso !== undefined) {
      patch.end_at = obj.end_at_iso === null ? null : parseRequiredIso(obj.end_at_iso, 'end_at_iso');
    }
    if (obj.description !== undefined) patch.description = asOptionalString(obj.description);
    if (obj.location !== undefined) patch.location = asOptionalString(obj.location);
    if (obj.recurrence_freq !== undefined) patch.recurrence_freq = parseRecurrenceFreq(obj.recurrence_freq);
    if (obj.recurrence_until_iso !== undefined) {
      patch.recurrence_until =
        obj.recurrence_until_iso === null ? null : parseRequiredIso(obj.recurrence_until_iso, 'recurrence_until_iso');
    }
    if (Object.keys(patch).length === 0) {
      return { status: 'error', payload: { error: 'No fields to update.' } };
    }
    const updated = this.store.update(eventId, patch);
    if (!updated) return { status: 'error', payload: { error: `Event #${eventId} not found.` } };
    log.info({ tool: 'config_calendar.update', id: eventId, ms: Date.now() - t0 }, 'tool_call');
    return { status: 'success', payload: { event: this.serialize(updated) } };
  }

  private handleDelete(obj: Record<string, unknown>, t0: number): ToolHandlerResult {
    const eventId = asPositiveInt(obj.event_id, 'event_id');
    if (obj.confirm !== true) {
      return { status: 'error', payload: { error: 'Refusing destructive delete without `confirm: true`.' } };
    }
    const deleted = this.store.delete(eventId);
    if (!deleted) return { status: 'error', payload: { error: `Event #${eventId} not found.` } };
    log.info({ tool: 'config_calendar.delete', id: eventId, ms: Date.now() - t0 }, 'tool_call');
    return {
      status: 'success',
      payload: {
        deleted: { id: deleted.id, title: deleted.title, recurrence_freq: deleted.recurrence_freq },
      },
    };
  }

  private handleSetOutputChannel(obj: Record<string, unknown>): ToolHandlerResult {
    const channelId = asSnowflake(obj.channel_id, 'channel_id');
    this.store.setOutputChannelId(channelId);
    log.info({ tool: 'config_calendar.set_output_channel', channel_id: channelId }, 'tool_call');
    return { status: 'success', payload: { output_channel_id: channelId } };
  }

  private serialize(e: CalendarEvent) {
    const owner = this.deps.userDirectory.get(e.created_by);
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      start_at_iso: new Date(e.start_at).toISOString(),
      start_at_local: formatInTimezone(e.start_at),
      end_at_iso: e.end_at !== null ? new Date(e.end_at).toISOString() : null,
      location: e.location,
      recurrence_freq: e.recurrence_freq,
      recurrence_until_iso: e.recurrence_until !== null ? new Date(e.recurrence_until).toISOString() : null,
      created_by: e.created_by,
      created_by_tag: owner?.discord_tag ?? null,
    };
  }
}

function parseRecurrenceFreq(v: unknown): RecurrenceFreq | null {
  if (v === undefined || v === null || v === '') return null;
  if (isRecurrenceFreq(v)) return v;
  throw new Error(`recurrence_freq: must be one of ${RECURRENCE_FREQUENCIES.join(', ')}`);
}

function asAction<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`action: must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field}: must be a non-empty string`);
  return v.trim();
}

function asOptionalString(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error('expected a string');
  return v.trim();
}

function asSnowflake(v: unknown, field: string): string {
  const s = asNonEmptyString(v, field);
  if (!/^\d{17,20}$/.test(s)) throw new Error(`${field}: must be a Discord snowflake (17–20 digits)`);
  return s;
}

function asPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${field}: must be a positive integer`);
  }
  return v;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseRequiredIso(v: unknown, field: string): number {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${field}: required ISO 8601 string (e.g. "2026-06-21T02:00:00Z")`);
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${field}: "${v}" is not a valid ISO 8601 timestamp`);
  return ms;
}

function parseOptionalIso(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return parseRequiredIso(v, field);
}
