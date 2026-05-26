import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import {
  CalendarStore,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarScope,
} from './store.js';
import { isRecurrenceFreq, RECURRENCE_FREQUENCIES, type RecurrenceFreq } from './recurrence.js';
import { formatInTimezone } from './time.js';

/**
 * Calendar tools, scoped to a single Discord channel **and** a single
 * Discord user. Every SQL read is hard-scoped: the user can choose to opt
 * into channel-wide visibility for queries via `scope: 'all'`, but mutations
 * are always scoped to themselves — the model cannot edit or delete another
 * user's events through these tools.
 */
export class CalendarToolSource implements ToolSource {
  readonly name = 'calendar';

  constructor(
    private readonly store: CalendarStore,
    private readonly channelId: string,
    private readonly userId: string,
    private readonly nowMs: number,
  ) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'calendar_list_upcoming',
        description:
          'List the next N events on this channel\'s calendar, ordered by start time. Default scope is the CURRENT user\'s events only — use this for "what\'s on my calendar", "what\'s coming up for me", "next events". Pass `scope: "all"` only when the user explicitly asks about the team/channel/shared calendar.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              description: 'Max events to return (default 10, max 25).',
              minimum: 1,
              maximum: 25,
            },
            scope: {
              type: 'string',
              enum: ['mine', 'all'],
              description:
                'Default "mine" (only the calling user\'s events). Use "all" when the user asks about channel-wide / team / shared events.',
            },
          },
        },
      },
      {
        name: 'calendar_search_events',
        description:
          'Search events by title or description (LIKE match), optionally filtered to a date range. Default scope is the CURRENT user\'s events. Use to check whether the user already has a similar event before creating one. Pass `scope: "all"` when the user explicitly asks about channel-wide events.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text to match against title or description.' },
            from_iso: {
              type: 'string',
              description:
                'Optional. ISO 8601 UTC lower bound on start_at. Example: "2026-05-23T00:00:00Z".',
            },
            to_iso: {
              type: 'string',
              description: 'Optional. ISO 8601 UTC upper bound on start_at.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
            scope: {
              type: 'string',
              enum: ['mine', 'all'],
              description:
                'Default "mine" (only the calling user\'s events). Use "all" for channel-wide search.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'calendar_get_event',
        description:
          'Fetch one event by its numeric id. Default scope is "mine" — looking up another user\'s event by id returns not-found unless you pass `scope: "all"`.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1 },
            scope: {
              type: 'string',
              enum: ['mine', 'all'],
              description: 'Default "mine". Use "all" to fetch any event in the channel by id.',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'calendar_create_event',
        description:
          'Create a new event on this channel\'s calendar. The event is OWNED by the calling user (visible to them by default; visible to others only via `scope: "all"`). Resolve relative times ("tomorrow at 3pm") against the current time supplied in the system prompt; pass start_at as ISO 8601 UTC. For recurring events ("every Wednesday at 8pm"), set `recurrence_freq` — DO NOT create separate events for each occurrence.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            start_at_iso: {
              type: 'string',
              description:
                'ISO 8601 UTC of the FIRST occurrence. Example: "2026-05-27T02:00:00Z" (8pm CDMX on Wed May 26 = 2am UTC Thu).',
            },
            end_at_iso: {
              type: 'string',
              description:
                'Optional ISO 8601 UTC. Omit for point-in-time events; only set when the user gives an end or implies a range.',
            },
            description: { type: 'string' },
            location: { type: 'string' },
            recurrence_freq: {
              type: 'string',
              enum: [...RECURRENCE_FREQUENCIES],
              description:
                'Set when the user describes a recurring series ("every day", "cada miércoles", "monthly", "weekly"). Omit for one-off events.',
            },
            recurrence_until_iso: {
              type: 'string',
              description:
                'Optional ISO 8601 UTC. Last day on which an occurrence is allowed. Omit for open-ended series ("forever") — the calendar still caps listing windows internally.',
            },
          },
          required: ['title', 'start_at_iso'],
        },
      },
      {
        name: 'calendar_update_event',
        description:
          'Update fields on an existing event owned by the calling user. Pass only the fields to change. NOTE: updates affect the WHOLE recurring series, not a single occurrence. Cannot update another user\'s event — returns not-found if you try. Warn the user before changing time/recurrence on a recurring event.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            start_at_iso: { type: 'string' },
            end_at_iso: { type: 'string' },
            description: { type: 'string' },
            location: { type: 'string' },
            recurrence_freq: {
              description:
                'Pass a frequency to add/change recurrence, or null to convert the series back into a one-off event.',
              oneOf: [
                { type: 'string', enum: [...RECURRENCE_FREQUENCIES] },
                { type: 'null' },
              ],
            },
            recurrence_until_iso: {
              description: 'ISO 8601 UTC end date, or null to clear (open-ended).',
              oneOf: [{ type: 'string' }, { type: 'null' }],
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'calendar_delete_event',
        description:
          'Delete an event by id, owned by the calling user. Cannot delete another user\'s event (returns not-found). NOTE: for recurring events this deletes the ENTIRE series (no per-occurrence delete in v1). Echo the title and, if recurring, the freq when confirming.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'integer', minimum: 1 } },
          required: ['id'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const t0 = Date.now();
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (toolName) {
        case 'calendar_list_upcoming': {
          const limit = clampInt(obj.limit, 1, 25, 10);
          const scope = parseScope(obj.scope);
          const rows = this.store.listUpcoming(
            this.channelId,
            this.userId,
            scope,
            this.nowMs,
            limit,
          );
          log.info(
            { tool: toolName, scope, count: rows.length, ms: Date.now() - t0 },
            'tool_call',
          );
          return { status: 'success', payload: { scope, events: rows.map(serialize) } };
        }
        case 'calendar_search_events': {
          const query = asNonEmptyString(obj.query, 'query');
          const fromMs = parseOptionalIso(obj.from_iso, 'from_iso');
          const toMs = parseOptionalIso(obj.to_iso, 'to_iso');
          const limit = clampInt(obj.limit, 1, 25, 10);
          const scope = parseScope(obj.scope);
          const rows = this.store.search(
            this.channelId,
            this.userId,
            scope,
            query,
            fromMs,
            toMs,
            limit,
          );
          log.info(
            { tool: toolName, scope, query, count: rows.length, ms: Date.now() - t0 },
            'tool_call',
          );
          return { status: 'success', payload: { scope, events: rows.map(serialize) } };
        }
        case 'calendar_get_event': {
          const id = asPositiveInt(obj.id, 'id');
          const scope = parseScope(obj.scope);
          const row = this.store.get(this.channelId, this.userId, scope, id);
          if (!row) {
            return {
              status: 'error',
              payload: {
                error:
                  scope === 'mine'
                    ? `Event #${id} not found among your events in this channel.`
                    : `Event #${id} not found in this channel.`,
              },
            };
          }
          return { status: 'success', payload: { event: serializeMaster(row) } };
        }
        case 'calendar_create_event': {
          const title = asNonEmptyString(obj.title, 'title');
          const startMs = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
          const endMs = parseOptionalIso(obj.end_at_iso, 'end_at_iso');
          if (endMs !== null && endMs < startMs) {
            return {
              status: 'error',
              payload: { error: 'end_at_iso must be after start_at_iso.' },
            };
          }
          const recurrenceFreq = parseRecurrenceFreq(obj.recurrence_freq, 'recurrence_freq');
          const recurrenceUntil = parseOptionalIso(obj.recurrence_until_iso, 'recurrence_until_iso');
          if (recurrenceUntil !== null && recurrenceFreq === null) {
            return {
              status: 'error',
              payload: {
                error: 'recurrence_until_iso requires recurrence_freq to also be set.',
              },
            };
          }
          if (recurrenceUntil !== null && recurrenceUntil < startMs) {
            return {
              status: 'error',
              payload: { error: 'recurrence_until_iso must be on or after start_at_iso.' },
            };
          }
          const description = asOptionalString(obj.description);
          const location = asOptionalString(obj.location);
          const created = this.store.create({
            channel_id: this.channelId,
            discord_user_id: this.userId,
            title,
            start_at: startMs,
            end_at: endMs,
            description,
            location,
            recurrence_freq: recurrenceFreq,
            recurrence_until: recurrenceUntil,
          });
          log.info(
            {
              tool: toolName,
              id: created.id,
              owner: this.userId,
              title,
              start_at: startMs,
              recurrence_freq: recurrenceFreq,
              ms: Date.now() - t0,
            },
            'tool_call',
          );
          return { status: 'success', payload: { event: serializeMaster(created) } };
        }
        case 'calendar_update_event': {
          const id = asPositiveInt(obj.id, 'id');
          const patch: Parameters<CalendarStore['update']>[3] = {};
          if (obj.title !== undefined) patch.title = asNonEmptyString(obj.title, 'title');
          if (obj.start_at_iso !== undefined) patch.start_at = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
          if (obj.end_at_iso !== undefined) {
            patch.end_at = obj.end_at_iso === null ? null : parseRequiredIso(obj.end_at_iso, 'end_at_iso');
          }
          if (obj.description !== undefined) patch.description = asOptionalString(obj.description);
          if (obj.location !== undefined) patch.location = asOptionalString(obj.location);
          if (obj.recurrence_freq !== undefined) {
            patch.recurrence_freq = parseRecurrenceFreq(obj.recurrence_freq, 'recurrence_freq');
          }
          if (obj.recurrence_until_iso !== undefined) {
            patch.recurrence_until =
              obj.recurrence_until_iso === null
                ? null
                : parseRequiredIso(obj.recurrence_until_iso, 'recurrence_until_iso');
          }
          if (Object.keys(patch).length === 0) {
            return { status: 'error', payload: { error: 'No fields to update.' } };
          }
          const updated = this.store.update(this.channelId, this.userId, id, patch);
          if (!updated) {
            return {
              status: 'error',
              payload: { error: `Event #${id} not found among your events.` },
            };
          }
          log.info({ tool: toolName, id, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { event: serializeMaster(updated) } };
        }
        case 'calendar_delete_event': {
          const id = asPositiveInt(obj.id, 'id');
          const deleted = this.store.delete(this.channelId, this.userId, id);
          if (!deleted) {
            return {
              status: 'error',
              payload: { error: `Event #${id} not found among your events.` },
            };
          }
          log.info(
            {
              tool: toolName,
              id,
              title: deleted.title,
              recurrence_freq: deleted.recurrence_freq,
              ms: Date.now() - t0,
            },
            'tool_call',
          );
          return { status: 'success', payload: { deleted: serializeMaster(deleted) } };
        }
        default:
          return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return {
        status: 'error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

function serialize(e: CalendarOccurrence) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    start_at_iso: new Date(e.start_at).toISOString(),
    start_at_local: formatInTimezone(e.start_at),
    end_at_iso: e.end_at !== null ? new Date(e.end_at).toISOString() : null,
    end_at_local: e.end_at !== null ? formatInTimezone(e.end_at) : null,
    location: e.location,
    recurrence_freq: e.recurrence_freq,
    recurrence_until_iso:
      e.recurrence_until !== null ? new Date(e.recurrence_until).toISOString() : null,
    is_recurring_instance: e.is_recurring_instance,
    occurrence_index: e.occurrence_index,
    discord_user_id: e.discord_user_id,
    created_by: e.created_by,
    created_at_iso: new Date(e.created_at).toISOString(),
  };
}

function serializeMaster(e: CalendarEvent) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    start_at_iso: new Date(e.start_at).toISOString(),
    start_at_local: formatInTimezone(e.start_at),
    end_at_iso: e.end_at !== null ? new Date(e.end_at).toISOString() : null,
    end_at_local: e.end_at !== null ? formatInTimezone(e.end_at) : null,
    location: e.location,
    recurrence_freq: e.recurrence_freq,
    recurrence_until_iso:
      e.recurrence_until !== null ? new Date(e.recurrence_until).toISOString() : null,
    discord_user_id: e.discord_user_id,
    created_by: e.created_by,
    created_at_iso: new Date(e.created_at).toISOString(),
  };
}

function parseScope(v: unknown): CalendarScope {
  if (v === undefined || v === null || v === '') return 'mine';
  if (v === 'mine' || v === 'all') return v;
  throw new Error(`scope: must be "mine" or "all" (got ${JSON.stringify(v)})`);
}

function parseRecurrenceFreq(v: unknown, field: string): RecurrenceFreq | null {
  if (v === undefined || v === null || v === '') return null;
  if (isRecurrenceFreq(v)) return v;
  throw new Error(
    `${field}: must be one of ${RECURRENCE_FREQUENCIES.join(', ')} (got ${JSON.stringify(v)})`,
  );
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`${field}: must be a non-empty string`);
  }
  return v.trim();
}

function asOptionalString(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error('expected a string');
  return v.trim();
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
    throw new Error(`${field}: required ISO 8601 string (e.g. "2026-05-24T21:00:00Z")`);
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field}: "${v}" is not a valid ISO 8601 timestamp`);
  }
  return ms;
}

function parseOptionalIso(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  return parseRequiredIso(v, field);
}
