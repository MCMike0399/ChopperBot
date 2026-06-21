import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import {
  CalendarStore,
  type CalendarEvent,
  type CalendarOccurrence,
} from './store.js';
import { isRecurrenceFreq, RECURRENCE_FREQUENCIES, step, type RecurrenceFreq } from './recurrence.js';
import { localParts } from './grid.js';
import { formatInTimezone } from './time.js';
import type { CalendarPublisher, PublishSummary } from './publisher.js';

/**
 * Tools for the **global** server calendar. Every moderator in the bound input
 * channel works on the same shared set of events — there is no per-user
 * scoping. After any create/update/delete, the affected month PDF(s) and the
 * ICS are re-rendered and pushed to the output channel (best-effort).
 */
export class CalendarToolSource implements ToolSource {
  readonly name = 'calendar';

  constructor(
    private readonly store: CalendarStore,
    private readonly callerUserId: string,
    private readonly nowMs: number,
    /** Optional — absent in tests; present at runtime to push to the output channel. */
    private readonly publisher?: CalendarPublisher,
  ) {}

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'calendar_list_upcoming',
        description:
          'List the next N events on the shared server calendar, ordered by start time. Use for "qué eventos vienen", "what\'s coming up".',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Max events (default 10, max 25).', minimum: 1, maximum: 25 },
          },
        },
      },
      {
        name: 'calendar_search_events',
        description:
          'Search the shared calendar by title/description (LIKE), optionally within a date range. ALWAYS call this before creating an event to check for a duplicate.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free text matched against title or description.' },
            from_iso: { type: 'string', description: 'Optional ISO 8601 UTC lower bound on start_at.' },
            to_iso: { type: 'string', description: 'Optional ISO 8601 UTC upper bound on start_at.' },
            limit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: ['query'],
        },
      },
      {
        name: 'calendar_get_event',
        description: 'Fetch one event on the shared calendar by its numeric id.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'integer', minimum: 1 } },
          required: ['id'],
        },
      },
      {
        name: 'calendar_create_event',
        description:
          'Create an event on the shared server calendar. Only call this once you have a clear TITLE and a START date+time. Resolve relative times against the current local time in the system prompt and pass start_at as ISO 8601 UTC. For a repeating series ("cada miércoles", "every Sunday"), set `recurrence_freq` — never create one event per occurrence. After creating, the affected month PDF(s) + ICS are auto-posted to the output channel.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            start_at_iso: {
              type: 'string',
              description: 'ISO 8601 UTC of the FIRST occurrence. e.g. 8pm CDMX Sat Jun 20 = "2026-06-21T02:00:00Z".',
            },
            end_at_iso: { type: 'string', description: 'Optional ISO 8601 UTC end. Omit for point-in-time.' },
            description: { type: 'string', description: 'Optional longer details / convocatoria text.' },
            location: { type: 'string', description: 'Optional place, e.g. "Sala de eventos", "Asamblea-Z".' },
            recurrence_freq: {
              type: 'string',
              enum: [...RECURRENCE_FREQUENCIES],
              description: 'Set for repeating series ("daily", "weekly", "monthly"). Omit for one-off.',
            },
            recurrence_until_iso: {
              type: 'string',
              description: 'Optional ISO 8601 UTC last allowed occurrence. Omit for open-ended.',
            },
          },
          required: ['title', 'start_at_iso'],
        },
      },
      {
        name: 'calendar_update_event',
        description:
          'Update fields on an existing event (pass only what changes). For a RECURRING series, `scope` decides how much it affects:\n' +
          '• "series" (default) — every occurrence (also use this for one-off events).\n' +
          '• "occurrence" — ONLY the one occurrence named by `occurrence_date_iso` (e.g. move just June 21 to 8:30). A retime must stay on the SAME day; to move it to another day, cancel that occurrence and create a separate event.\n' +
          '• "following" — that occurrence and ALL after it (splits the series; earlier occurrences keep the old values).\n' +
          'If the mod says "el del 21" / "solo ese día" / "este y los siguientes" pick the matching scope; if it\'s ambiguous whether they mean one day or the whole series, ASK before calling. `recurrence_freq`/`recurrence_until_iso` only apply to scope "series".',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1 },
            scope: { type: 'string', enum: ['series', 'occurrence', 'following'], description: 'Default "series".' },
            occurrence_date_iso: {
              type: 'string',
              description: 'Required for "occurrence"/"following": which occurrence, as its local date (e.g. "2026-06-21") or ISO datetime.',
            },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            start_at_iso: { type: 'string' },
            end_at_iso: { type: 'string' },
            description: { type: 'string' },
            location: { type: 'string' },
            recurrence_freq: {
              description: 'Frequency to add/change recurrence, or null to make it one-off again. Only with scope "series".',
              oneOf: [{ type: 'string', enum: [...RECURRENCE_FREQUENCIES] }, { type: 'null' }],
            },
            recurrence_until_iso: {
              description: 'ISO 8601 UTC end date, or null to clear (open-ended). Only with scope "series".',
              oneOf: [{ type: 'string' }, { type: 'null' }],
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'calendar_delete_event',
        description:
          'Delete an event by id. For a RECURRING series, `scope`:\n' +
          '• "series" (default) — delete the whole series (also for one-off events). Confirm + echo the title first.\n' +
          '• "occurrence" — cancel ONLY the occurrence at `occurrence_date_iso` (e.g. skip just June 21); the rest stay.\n' +
          '• "following" — remove that occurrence and ALL after it (earlier ones stay).\n' +
          'Pick the scope from the mod\'s words ("solo el del 21" → occurrence); ASK if ambiguous.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1 },
            scope: { type: 'string', enum: ['series', 'occurrence', 'following'], description: 'Default "series".' },
            occurrence_date_iso: {
              type: 'string',
              description: 'Required for "occurrence"/"following": local date ("2026-06-21") or ISO datetime of the occurrence.',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'calendar_publish',
        description:
          'Force a full re-render: re-post every month PDF that has events plus the ICS to the output channel. Use when a mod asks to "republica el calendario" or to seed the channel for the first time. Not needed after a normal create/update/delete (those auto-publish).',
        inputSchema: { type: 'object', properties: {} },
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
          const rows = this.store.listUpcoming(this.nowMs, limit);
          log.info({ tool: toolName, count: rows.length, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { events: rows.map(serialize) } };
        }
        case 'calendar_search_events': {
          const query = asNonEmptyString(obj.query, 'query');
          const fromMs = parseOptionalIso(obj.from_iso, 'from_iso');
          const toMs = parseOptionalIso(obj.to_iso, 'to_iso');
          const limit = clampInt(obj.limit, 1, 25, 10);
          const rows = this.store.search(query, fromMs, toMs, limit);
          log.info({ tool: toolName, query, count: rows.length, ms: Date.now() - t0 }, 'tool_call');
          return { status: 'success', payload: { events: rows.map(serialize) } };
        }
        case 'calendar_get_event': {
          const id = asPositiveInt(obj.id, 'id');
          const row = this.store.get(id);
          if (!row) return { status: 'error', payload: { error: `Event #${id} not found.` } };
          return { status: 'success', payload: { event: serializeMaster(row) } };
        }
        case 'calendar_create_event':
          return await this.handleCreate(obj, t0);
        case 'calendar_update_event':
          return await this.handleUpdate(obj, t0);
        case 'calendar_delete_event':
          return await this.handleDelete(obj, t0);
        case 'calendar_publish':
          return await this.handlePublishAll();
        default:
          return { status: 'error', payload: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (err) {
      log.warn({ tool: toolName, err }, 'tool_call_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async handleCreate(obj: Record<string, unknown>, t0: number): Promise<ToolHandlerResult> {
    const title = asNonEmptyString(obj.title, 'title');
    const startMs = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
    const endMs = parseOptionalIso(obj.end_at_iso, 'end_at_iso');
    if (endMs !== null && endMs < startMs) {
      return { status: 'error', payload: { error: 'end_at_iso must be after start_at_iso.' } };
    }
    const recurrenceFreq = parseRecurrenceFreq(obj.recurrence_freq, 'recurrence_freq');
    const recurrenceUntil = parseOptionalIso(obj.recurrence_until_iso, 'recurrence_until_iso');
    if (recurrenceUntil !== null && recurrenceFreq === null) {
      return { status: 'error', payload: { error: 'recurrence_until_iso requires recurrence_freq to also be set.' } };
    }
    if (recurrenceUntil !== null && recurrenceUntil < startMs) {
      return { status: 'error', payload: { error: 'recurrence_until_iso must be on or after start_at_iso.' } };
    }
    const created = this.store.create({
      created_by: this.callerUserId,
      title,
      start_at: startMs,
      end_at: endMs,
      description: asOptionalString(obj.description),
      location: asOptionalString(obj.location),
      recurrence_freq: recurrenceFreq,
      recurrence_until: recurrenceUntil,
    });
    log.info({ tool: 'calendar_create_event', id: created.id, title, recurrence_freq: recurrenceFreq, ms: Date.now() - t0 }, 'tool_call');
    const published = await this.publishNow();
    return { status: 'success', payload: { event: serializeMaster(created), published } };
  }

  private async handleUpdate(obj: Record<string, unknown>, t0: number): Promise<ToolHandlerResult> {
    const id = asPositiveInt(obj.id, 'id');
    const master = this.store.get(id);
    if (!master) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    // Scope only applies to recurring series; a one-off is always "series".
    const scope = master.recurrence_freq === null ? 'series' : parseScope(obj.scope);

    if (scope === 'occurrence') {
      const anchor = resolveOccurrence(master, obj.occurrence_date_iso);
      if (anchor === null) {
        return { status: 'error', payload: { error: 'No encontré una ocurrencia de esa serie en esa fecha.' } };
      }
      const patch: import('./store.js').OverridePatch = {};
      if (obj.start_at_iso !== undefined) {
        const newStart = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
        if (localDateKey(newStart) !== localDateKey(anchor)) {
          return { status: 'error', payload: { error: 'Una edición de una sola ocurrencia debe quedar el MISMO día. Para moverla a otro día, cancela esa ocurrencia y crea un evento aparte.' } };
        }
        patch.start_at = newStart;
      }
      if (obj.end_at_iso !== undefined) patch.end_at = obj.end_at_iso === null ? null : parseRequiredIso(obj.end_at_iso, 'end_at_iso');
      if (obj.title !== undefined) patch.title = asNonEmptyString(obj.title, 'title');
      if (obj.description !== undefined) patch.description = asOptionalString(obj.description);
      if (obj.location !== undefined) patch.location = asOptionalString(obj.location);
      if (Object.keys(patch).length === 0) return { status: 'error', payload: { error: 'No fields to update.' } };
      this.store.upsertOverride(id, anchor, patch);
      log.info({ tool: 'calendar_update_event', id, scope, occurrence: anchor, ms: Date.now() - t0 }, 'tool_call');
      const published = await this.publishNow();
      return { status: 'success', payload: { updated_scope: 'occurrence', occurrence_local: formatInTimezone(patch.start_at ?? anchor), event: serializeMaster(master), published } };
    }

    if (scope === 'following') {
      const anchor = resolveOccurrence(master, obj.occurrence_date_iso);
      if (anchor === null) {
        return { status: 'error', payload: { error: 'No encontré una ocurrencia de esa serie en esa fecha.' } };
      }
      // Splitting at the very first occurrence == editing the whole series.
      if (anchor > master.start_at) {
        const newStart = obj.start_at_iso !== undefined ? parseRequiredIso(obj.start_at_iso, 'start_at_iso') : anchor;
        const duration = master.end_at !== null ? master.end_at - master.start_at : null;
        const newEnd = obj.end_at_iso !== undefined
          ? (obj.end_at_iso === null ? null : parseRequiredIso(obj.end_at_iso, 'end_at_iso'))
          : (obj.start_at_iso !== undefined && duration !== null ? newStart + duration : master.end_at);
        // End the original series just before the split, then start a new one.
        this.store.update(id, { recurrence_until: anchor - 1 });
        this.store.clearOverridesFrom(id, anchor);
        const created = this.store.create({
          created_by: this.callerUserId,
          title: obj.title !== undefined ? asNonEmptyString(obj.title, 'title') : master.title,
          start_at: newStart,
          end_at: newEnd,
          description: obj.description !== undefined ? asOptionalString(obj.description) : master.description,
          location: obj.location !== undefined ? asOptionalString(obj.location) : master.location,
          recurrence_freq: master.recurrence_freq,
          recurrence_until: master.recurrence_until,
        });
        log.info({ tool: 'calendar_update_event', id, scope, split_at: anchor, new_id: created.id, ms: Date.now() - t0 }, 'tool_call');
        const published = await this.publishNow();
        return { status: 'success', payload: { updated_scope: 'following', new_series: serializeMaster(created), published } };
      }
      // else fall through to a whole-series update below.
    }

    // scope === 'series' (or "following" at the first occurrence).
    const patch: Parameters<CalendarStore['update']>[1] = {};
    if (obj.title !== undefined) patch.title = asNonEmptyString(obj.title, 'title');
    if (obj.start_at_iso !== undefined) patch.start_at = parseRequiredIso(obj.start_at_iso, 'start_at_iso');
    if (obj.end_at_iso !== undefined) patch.end_at = obj.end_at_iso === null ? null : parseRequiredIso(obj.end_at_iso, 'end_at_iso');
    if (obj.description !== undefined) patch.description = asOptionalString(obj.description);
    if (obj.location !== undefined) patch.location = asOptionalString(obj.location);
    if (obj.recurrence_freq !== undefined) patch.recurrence_freq = parseRecurrenceFreq(obj.recurrence_freq, 'recurrence_freq');
    if (obj.recurrence_until_iso !== undefined) {
      patch.recurrence_until = obj.recurrence_until_iso === null ? null : parseRequiredIso(obj.recurrence_until_iso, 'recurrence_until_iso');
    }
    if (Object.keys(patch).length === 0) return { status: 'error', payload: { error: 'No fields to update.' } };
    // Changing the rhythm invalidates occurrence-keyed overrides.
    if (patch.start_at !== undefined || patch.recurrence_freq !== undefined) {
      this.store.deleteOverridesForMaster(id);
    }
    const updated = this.store.update(id, patch);
    if (!updated) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    log.info({ tool: 'calendar_update_event', id, scope: 'series', ms: Date.now() - t0 }, 'tool_call');
    const published = await this.publishNow();
    return { status: 'success', payload: { updated_scope: 'series', event: serializeMaster(updated), published } };
  }

  private async handleDelete(obj: Record<string, unknown>, t0: number): Promise<ToolHandlerResult> {
    const id = asPositiveInt(obj.id, 'id');
    const master = this.store.get(id);
    if (!master) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    const scope = master.recurrence_freq === null ? 'series' : parseScope(obj.scope);

    if (scope === 'occurrence') {
      const anchor = resolveOccurrence(master, obj.occurrence_date_iso);
      if (anchor === null) return { status: 'error', payload: { error: 'No encontré una ocurrencia de esa serie en esa fecha.' } };
      this.store.cancelOccurrence(id, anchor);
      log.info({ tool: 'calendar_delete_event', id, scope, occurrence: anchor, ms: Date.now() - t0 }, 'tool_call');
      const published = await this.publishNow();
      return { status: 'success', payload: { deleted_scope: 'occurrence', occurrence_local: formatInTimezone(anchor), title: master.title, published } };
    }

    if (scope === 'following') {
      const anchor = resolveOccurrence(master, obj.occurrence_date_iso);
      if (anchor === null) return { status: 'error', payload: { error: 'No encontré una ocurrencia de esa serie en esa fecha.' } };
      if (anchor > master.start_at) {
        this.store.update(id, { recurrence_until: anchor - 1 });
        this.store.clearOverridesFrom(id, anchor);
        log.info({ tool: 'calendar_delete_event', id, scope, truncated_at: anchor, ms: Date.now() - t0 }, 'tool_call');
        const published = await this.publishNow();
        return { status: 'success', payload: { deleted_scope: 'following', from_local: formatInTimezone(anchor), title: master.title, published } };
      }
      // splitting at the first occurrence → delete the whole series (fall through).
    }

    const deleted = this.store.delete(id);
    if (!deleted) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    log.info({ tool: 'calendar_delete_event', id, scope: 'series', title: deleted.title, recurrence_freq: deleted.recurrence_freq, ms: Date.now() - t0 }, 'tool_call');
    const published = await this.publishNow();
    return { status: 'success', payload: { deleted_scope: 'series', deleted: serializeMaster(deleted), published } };
  }

  private async handlePublishAll(): Promise<ToolHandlerResult> {
    const result = await this.publishNow();
    return { status: result.ok ? 'success' : 'error', payload: { published: result } };
  }

  /**
   * Reconcile the output channel with the current DB state (post/update the
   * desired month cards + ICS, delete the rest). Recurring events show only on
   * the current month's card; one-off events get their own month's card.
   */
  private async publishNow(): Promise<PublishSummary | { ok: false; error: string }> {
    if (!this.publisher) return { ok: false, error: 'publishing_disabled' };
    return this.publisher.reconcile();
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
    recurrence_until_iso: e.recurrence_until !== null ? new Date(e.recurrence_until).toISOString() : null,
    is_recurring_instance: e.is_recurring_instance,
    occurrence_index: e.occurrence_index,
    created_by: e.created_by,
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
    recurrence_until_iso: e.recurrence_until !== null ? new Date(e.recurrence_until).toISOString() : null,
    created_by: e.created_by,
    created_at_iso: new Date(e.created_at).toISOString(),
  };
}

function parseRecurrenceFreq(v: unknown, field: string): RecurrenceFreq | null {
  if (v === undefined || v === null || v === '') return null;
  if (isRecurrenceFreq(v)) return v;
  throw new Error(`${field}: must be one of ${RECURRENCE_FREQUENCIES.join(', ')} (got ${JSON.stringify(v)})`);
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

function asPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${field}: must be a positive integer`);
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

type Scope = 'series' | 'occurrence' | 'following';
function parseScope(v: unknown): Scope {
  return v === 'occurrence' || v === 'following' ? v : 'series';
}

/** Local YYYY-MM-DD for a UTC ms (CDMX wall clock). */
function localDateKey(utcMs: number): string {
  const p = localParts(utcMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The local date the user means: a bare "YYYY-MM-DD" is taken as that LOCAL
 * date (not UTC midnight); a full ISO instant is converted to its local date.
 */
function occurrenceDateKey(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? localDateKey(ms) : null;
}

/**
 * Find the ORIGINAL anchor time (the key overrides are stored under) of the
 * master's occurrence falling on the given date. Returns null if the series has
 * no occurrence that day. Occurrences are monotonic, so we stop once we pass it.
 */
function resolveOccurrence(master: CalendarEvent, dateInput: unknown): number | null {
  const key = occurrenceDateKey(dateInput);
  if (!key) return null;
  if (master.recurrence_freq === null) {
    return localDateKey(master.start_at) === key ? master.start_at : null;
  }
  for (let i = 0; i < 1500; i++) {
    const occ = step(master.start_at, master.recurrence_freq, i);
    if (master.recurrence_until !== null && occ > master.recurrence_until) break;
    const k = localDateKey(occ);
    if (k === key) return occ;
    if (k > key) break; // YYYY-MM-DD compares chronologically
  }
  return null;
}
