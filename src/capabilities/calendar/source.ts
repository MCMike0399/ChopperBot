import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import {
  CalendarStore,
  type CalendarEvent,
  type CalendarOccurrence,
} from './store.js';
import {
  countOccurrencesUntil,
  isRecurrenceFreq,
  MAX_RECURRENCE_COUNT,
  RECURRENCE_FREQUENCIES,
  step,
  untilFromCount,
  type RecurrenceFreq,
} from './recurrence.js';
import { localParts } from './grid.js';
import { formatInTimezone } from './time.js';
import type { CalendarPublisher, PublishSummary } from './publisher.js';
import type { DiscordEventSyncer } from './discord-events.js';

/**
 * Tools for the **global** server calendar. Every moderator in the bound input
 * channel works on the same shared set of events — there is no per-user
 * scoping. After any create/update/delete, the affected month PDF(s) and the
 * ICS are re-rendered and pushed to the output channel (best-effort).
 */
/** Names of the tools that MUTATE the calendar (gated by `allowWrite`). */
const WRITE_TOOL_NAMES = new Set([
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_publish',
  'calendar_sync_discord_event',
]);

/**
 * Options to expose a RESTRICTED slice of the calendar tools — used by the
 * event_intake capability so a ticket conversation only ever sees read tools
 * (+ `calendar_create_event` for mods), never update/delete.
 */
export interface CalendarToolSourceOptions {
  /** If set, `tools()` is filtered to exactly these tool names (allowlist). */
  include?: readonly string[];
  /**
   * When `false`, any WRITE tool is hard-refused in `handle()` even if it was
   * somehow advertised — defense-in-depth behind the `include` allowlist.
   * Defaults to `true` (the calendar capability's full read+write behavior).
   */
  allowWrite?: boolean;
  /**
   * Lets `calendar_sync_discord_event` reach Discord. Absent in tests and in any
   * context without a guild (the tool then reports it can't, instead of failing
   * mid-call) — see {@link ./discord-events.js createEventSyncer}.
   */
  syncer?: DiscordEventSyncer;
  /**
   * Image attachment URLs the model may pass as `image_url` to
   * `calendar_sync_discord_event` — exactly the set advertised in this turn's
   * system prompt (an attachment in the channel, or the latest flyer in a
   * ticket). Anything outside the list is refused, so a hallucinated or
   * injected URL can never reach the fetcher.
   */
  allowedImageUrls?: readonly string[];
}

export class CalendarToolSource implements ToolSource {
  readonly name = 'calendar';
  private readonly options: CalendarToolSourceOptions;

  constructor(
    private readonly store: CalendarStore,
    private readonly callerUserId: string,
    private readonly nowMs: number,
    /** Optional — absent in tests; present at runtime to push to the output channel. */
    private readonly publisher?: CalendarPublisher,
    options?: CalendarToolSourceOptions,
  ) {
    this.options = options ?? {};
  }

  /** Discord-scheduled-event access, when the caller wired it up. */
  private get syncer(): DiscordEventSyncer | undefined {
    return this.options.syncer;
  }

  async systemPromptSection(): Promise<string> {
    return '';
  }

  tools(): ToolSpec[] {
    const specs = this.allTools();
    const include = this.options.include;
    return include ? specs.filter((t) => include.includes(t.name)) : specs;
  }

  private allTools(): ToolSpec[] {
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
          'Fuzzy-search the shared calendar by title/description, optionally within a date range. Matching ignores accents, case, punctuation and word order (so "club de poesia rosario castellanos" finds "Club de poesía: Rosario Castellanos") — pass the words the mod used, no need to guess exact punctuation. Returns one row per matching event (with its numeric id), most-relevant first. Pass "*" or an empty query to list everything in range. ALWAYS call this before creating an event to check for a duplicate.',
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
          'Create an event on the shared server calendar. Only call this once you have a clear TITLE and a START date+time. Resolve relative times against the current local time in the system prompt and pass start_at as ISO 8601 UTC. For a repeating series ("cada miércoles", "every Sunday"), set `recurrence_freq` and create ONE row — never one event per occurrence.\n' +
          'BOUND THE SERIES when the mod gave any hint of how long it runs — pass EITHER `recurrence_count` (how many times: "4 sesiones", "los 3 jueves") OR `recurrence_until_iso` (a last date: "hasta fin de agosto"). "todo julio" / "durante el mes" IS a range — resolve it to a count or an end date instead of creating an open-ended series. Leave both out only for something genuinely indefinite (una asamblea permanente).\n' +
          'After creating, the affected month PDF(s) + ICS are auto-posted to the output channel.',
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
            recurrence_count: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_RECURRENCE_COUNT,
              description:
                'How MANY occurrences the series has, counting the first ("cada martes 4 veces" → 4). Requires recurrence_freq. Mutually exclusive with recurrence_until_iso — use whichever the mod expressed. 1 collapses to a one-off.',
            },
            recurrence_until_iso: {
              type: 'string',
              description:
                'ISO 8601 UTC of the LAST allowed occurrence ("hasta el 31 de agosto"). Requires recurrence_freq. Mutually exclusive with recurrence_count. Omit both only for a genuinely open-ended series.',
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
          'If the mod says "el del 21" / "solo ese día" / "este y los siguientes" pick the matching scope; if it\'s ambiguous whether they mean one day or the whole series, ASK before calling. `recurrence_freq`/`recurrence_count`/`recurrence_until_iso` only apply to scope "series".\n' +
          'To RE-BOUND an existing series ("que solo dure hasta septiembre", "déjalo en 6 sesiones") use scope "series" with `recurrence_count` or `recurrence_until_iso`; pass `recurrence_until_iso: null` to make it open-ended again.',
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
            recurrence_count: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_RECURRENCE_COUNT,
              description:
                'Re-bound the series to exactly N occurrences from its first one. Counted from the series START (its existing one unless you also change start_at_iso). Mutually exclusive with recurrence_until_iso. Only with scope "series".',
            },
            recurrence_until_iso: {
              description: 'ISO 8601 UTC last occurrence, or null to clear the bound (open-ended). Only with scope "series".',
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
      {
        name: 'calendar_sync_discord_event',
        description:
          "Create the Discord **Scheduled Event** (the native \"Evento\" members RSVP to, under the server's Eventos tab) for a calendar event that doesn't have one yet, and link the two. Use it when a mod says \"crea el evento de Discord\", \"súbelo a eventos\", \"haz el evento para que se apunten\", or right after creating an event that the community should be able to RSVP to.\n" +
          'Idempotent: if the event is already linked to a live Discord event it returns that one instead of duplicating it. For a recurring series it schedules the NEXT occurrence. The link is what the daily "hoy hay evento" announcement uses, so this is how you make the announcement carry a clickable event.\n' +
          'Pass `image_url` (one of the image URLs advertised in the system prompt) to set the event\'s cover image/banner — also works on an event that already exists, so "ponle esta portada" is just this call with the image.\n' +
          'The result reports where it landed: `venue_kind` voice/stage (members get a join button) or `external` with `needs_room: true`, which means NO room was resolvable — say so and ask which sala it is; storing that as the calendar `location` moves the Discord event into it.\n' +
          'Once linked, later calendar edits and deletes propagate to the Discord event automatically — no need to call this again for that.\n' +
          'If the bot lacks the "Gestionar eventos" server permission this returns `missing_permission` — relay that so an admin can grant it, and ask the mods to create the event by hand meanwhile.',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'integer', minimum: 1, description: 'The calendar event id.' },
            image_url: {
              type: 'string',
              description:
                'Optional. URL of an image offered in this conversation (listed in the system prompt) to use as the event cover/banner. Only advertised URLs are accepted.',
            },
          },
          required: ['event_id'],
        },
      },
    ];
  }

  async handle(toolName: string, input: unknown): Promise<ToolHandlerResult> {
    const t0 = Date.now();
    // Server-side authority re-check: even if a write tool were advertised by
    // mistake, a read-only bundle refuses it (belt-and-suspenders behind the
    // per-author tool allowlist that event_intake builds).
    if (this.options.allowWrite === false && WRITE_TOOL_NAMES.has(toolName)) {
      return {
        status: 'error',
        payload: { error: 'Solo un moderador puede aprobar o crear un evento en el calendario.' },
      };
    }
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
          // Tolerant: "*" or empty means "list everything in range" (the store
          // normalizes both to a match-all). Don't error on a broad query.
          const query = asOptionalString(obj.query) ?? '';
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
        case 'calendar_sync_discord_event':
          return await this.handleSyncDiscordEvent(obj, t0);
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
    let recurrenceFreq = parseRecurrenceFreq(obj.recurrence_freq, 'recurrence_freq');
    let range: ResolvedRange;
    try {
      range = resolveRecurrenceRange(obj, startMs, recurrenceFreq);
    } catch (err) {
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
    // "repite 1 vez" is a one-off, not a degenerate one-occurrence series.
    if (range.collapsedToOneOff) recurrenceFreq = null;

    const created = this.store.create({
      created_by: this.callerUserId,
      title,
      start_at: startMs,
      end_at: endMs,
      description: asOptionalString(obj.description),
      location: asOptionalString(obj.location),
      recurrence_freq: recurrenceFreq,
      recurrence_until: recurrenceFreq === null ? null : range.until,
    });
    log.info(
      {
        tool: 'calendar_create_event', id: created.id, title,
        recurrence_freq: recurrenceFreq, recurrence_count: range.requestedCount,
        recurrence_until: created.recurrence_until, ms: Date.now() - t0,
      },
      'tool_call',
    );
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
      const discordEvent = await this.propagateToDiscordEvent('update', id);
      return { status: 'success', payload: { updated_scope: 'occurrence', occurrence_local: formatInTimezone(patch.start_at ?? anchor), event: serializeMaster(master), published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
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
        const discordEvent = await this.propagateToDiscordEvent('update', id);
        return { status: 'success', payload: { updated_scope: 'following', new_series: serializeMaster(created), published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
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

    // Re-bounding the range: `recurrence_count` counts from the series' start
    // (the new one if this same call moves it) under the effective frequency
    // (the new one if this same call changes it), so "déjalo en 6 sesiones"
    // resolves against what the series will BE, not what it was.
    const effectiveStart = patch.start_at ?? master.start_at;
    const effectiveFreq = patch.recurrence_freq !== undefined ? patch.recurrence_freq : master.recurrence_freq;
    if (obj.recurrence_count !== undefined || obj.recurrence_until_iso !== undefined) {
      let range: ResolvedRange;
      try {
        range = resolveRecurrenceRange(obj, effectiveStart, effectiveFreq);
      } catch (err) {
        return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
      }
      if (range.collapsedToOneOff) {
        patch.recurrence_freq = null;
        patch.recurrence_until = null;
      } else {
        patch.recurrence_until = range.until;
      }
    } else if (patch.recurrence_freq === null) {
      // Dropping recurrence leaves no series for a cutoff to bound.
      patch.recurrence_until = null;
    }
    if (Object.keys(patch).length === 0) return { status: 'error', payload: { error: 'No fields to update.' } };
    // Changing the rhythm invalidates occurrence-keyed overrides.
    if (patch.start_at !== undefined || patch.recurrence_freq !== undefined) {
      this.store.deleteOverridesForMaster(id);
    }
    const updated = this.store.update(id, patch);
    if (!updated) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    log.info(
      {
        tool: 'calendar_update_event', id, scope: 'series',
        recurrence_freq: updated.recurrence_freq, recurrence_until: updated.recurrence_until,
        ms: Date.now() - t0,
      },
      'tool_call',
    );
    const published = await this.publishNow();
    const discordEvent = await this.propagateToDiscordEvent('update', id);
    return { status: 'success', payload: { updated_scope: 'series', event: serializeMaster(updated), published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
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
      const discordEvent = await this.propagateToDiscordEvent('update', id);
      return { status: 'success', payload: { deleted_scope: 'occurrence', occurrence_local: formatInTimezone(anchor), title: master.title, published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
    }

    if (scope === 'following') {
      const anchor = resolveOccurrence(master, obj.occurrence_date_iso);
      if (anchor === null) return { status: 'error', payload: { error: 'No encontré una ocurrencia de esa serie en esa fecha.' } };
      if (anchor > master.start_at) {
        this.store.update(id, { recurrence_until: anchor - 1 });
        this.store.clearOverridesFrom(id, anchor);
        log.info({ tool: 'calendar_delete_event', id, scope, truncated_at: anchor, ms: Date.now() - t0 }, 'tool_call');
        const published = await this.publishNow();
        const discordEvent = await this.propagateToDiscordEvent('update', id);
        return { status: 'success', payload: { deleted_scope: 'following', from_local: formatInTimezone(anchor), title: master.title, published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
      }
      // splitting at the first occurrence → delete the whole series (fall through).
    }

    // The Discord event goes FIRST: `remove` reads the link off the row, and
    // once the row is gone there's nothing to read. A failure there is
    // reported but never blocks the calendar delete.
    const discordEvent = await this.propagateToDiscordEvent('delete', id);
    const deleted = this.store.delete(id);
    if (!deleted) return { status: 'error', payload: { error: `Event #${id} not found.` } };
    log.info({ tool: 'calendar_delete_event', id, scope: 'series', title: deleted.title, recurrence_freq: deleted.recurrence_freq, ms: Date.now() - t0 }, 'tool_call');
    const published = await this.publishNow();
    return { status: 'success', payload: { deleted_scope: 'series', deleted: serializeMaster(deleted), published, ...(discordEvent ? { discord_event: discordEvent } : {}) } };
  }

  private async handlePublishAll(): Promise<ToolHandlerResult> {
    const result = await this.publishNow();
    return { status: result.ok ? 'success' : 'error', payload: { published: result } };
  }

  /**
   * Push a calendar mutation through to the linked Discord scheduled event, so
   * the thing members RSVP to never drifts from the calendar: edits refresh it
   * (title/time/sala), a whole-series delete cancels it. Quiet by design — only
   * outcomes the model should mention in its confirmation are returned
   * (`updated` / `deleted` / `error`); unlinked rows and no-op refreshes come
   * back `undefined`. Never fails the calendar op over the Discord side.
   */
  private async propagateToDiscordEvent(
    kind: 'update' | 'delete',
    id: number,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.syncer) return undefined;
    try {
      if (kind === 'delete') {
        const res = await this.syncer.remove(id);
        if (!res.ok) return { action: 'error', message: res.message };
        return res.action === 'deleted' ? { action: 'deleted' } : undefined;
      }
      const res = await this.syncer.refresh(id);
      if (!res.ok) return { action: 'error', message: res.message };
      return res.action === 'updated'
        ? { action: 'updated', url: res.url, changed: res.changed, ...(res.venue ? { venue: res.venue } : {}) }
        : undefined;
    } catch (err) {
      log.warn({ err, id, kind }, 'calendar.discord_event_propagation_failed');
      return undefined;
    }
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

  /**
   * Create + link the Discord scheduled event for a calendar row. The failure
   * modes are returned as data (not thrown) with Spanish text the model can
   * relay verbatim, because the most likely one — a missing "Gestionar eventos"
   * permission — is fixed by a human in the Discord UI, not by retrying.
   */
  private async handleSyncDiscordEvent(
    obj: Record<string, unknown>,
    t0: number,
  ): Promise<ToolHandlerResult> {
    const eventId = asPositiveInt(obj.event_id, 'event_id');
    const imageUrl = asOptionalString(obj.image_url);
    if (imageUrl !== null && !(this.options.allowedImageUrls ?? []).includes(imageUrl)) {
      // The model may only use an image the conversation actually offered —
      // anything else is a hallucination (or an injection) and must not be
      // fetched on its say-so.
      return {
        status: 'error',
        payload: {
          error:
            'Esa URL de imagen no corresponde a ninguna imagen ofrecida en esta conversación. ' +
            'Pídele a la persona que adjunte la imagen aquí y vuelve a intentarlo con la URL ofrecida.',
        },
      };
    }
    if (!this.syncer) {
      return {
        status: 'error',
        payload: {
          error:
            'No puedo crear eventos de Discord desde aquí (no tengo el contexto del servidor). ' +
            'Pídele a un mod que lo cree en Eventos → Crear evento.',
        },
      };
    }
    const result = await this.syncer.sync(eventId, { imageUrl });
    log.info(
      { tool: 'calendar_sync_discord_event', eventId, ok: result.ok, ms: Date.now() - t0 },
      'tool_call',
    );
    if (!result.ok) {
      return { status: 'error', payload: { error: result.message, reason: result.reason } };
    }
    return {
      status: 'success',
      payload: {
        discord_event: {
          id: result.discordEventId,
          url: result.url,
          created: result.created,
          start_at_local: result.startAtLocal,
          image_set: result.imageSet === true,
          /** Room it landed in — `external` means nobody gets a join button. */
          venue_kind: result.venue.kind,
          venue_name: result.venue.name,
          /** True when the event has NO voice/stage room; ask the mod for one. */
          needs_room: result.venue.kind === 'external',
        },
      },
    };
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
    recurrence_until_local: e.recurrence_until !== null ? formatInTimezone(e.recurrence_until) : null,
    /** True when the series has no end date — worth flagging to mods on a read. */
    recurrence_open_ended: e.recurrence_freq !== null && e.recurrence_until === null,
    is_recurring_instance: e.is_recurring_instance,
    occurrence_index: e.occurrence_index,
    created_by: e.created_by,
    /** Set when this event already has a Discord scheduled event to RSVP to. */
    discord_event_id: e.discord_event_id,
  };
}

function serializeMaster(e: CalendarEvent) {
  const occurrenceCount = e.recurrence_freq !== null
    ? countOccurrencesUntil(e.start_at, e.recurrence_freq, e.recurrence_until)
    : 1;
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
    /** Last occurrence in local time — echo this when confirming a bounded series. */
    recurrence_until_local: e.recurrence_until !== null ? formatInTimezone(e.recurrence_until) : null,
    /** Total occurrences, or null when the series is open-ended ("indefinida"). */
    occurrence_count: occurrenceCount,
    /** True when the series has no end date. */
    recurrence_open_ended: e.recurrence_freq !== null && e.recurrence_until === null,
    /** Set when this event already has a Discord scheduled event to RSVP to. */
    discord_event_id: e.discord_event_id,
    created_by: e.created_by,
    created_at_iso: new Date(e.created_at).toISOString(),
  };
}

/** Outcome of reading the optional range params off a tool call. */
interface ResolvedRange {
  /** Concrete cutoff to store in `recurrence_until` (null = open-ended). */
  until: number | null;
  /** The `recurrence_count` the caller asked for, if any (for logging). */
  requestedCount: number | null;
  /** `recurrence_count: 1` — the caller described a single date, not a series. */
  collapsedToOneOff: boolean;
}

/**
 * Resolve `recurrence_count` / `recurrence_until_iso` into the single
 * `recurrence_until` cutoff the store holds. The two are alternate spellings of
 * the same bound ("4 martes" vs "hasta el 28 de julio"), so passing both is a
 * contradiction we reject rather than silently pick a winner. Throws with a
 * model-readable message; callers turn that into a tool error.
 */
function resolveRecurrenceRange(
  obj: Record<string, unknown>,
  startMs: number,
  freq: RecurrenceFreq | null,
): ResolvedRange {
  const hasCount = obj.recurrence_count !== undefined && obj.recurrence_count !== null;
  const hasUntil = obj.recurrence_until_iso !== undefined && obj.recurrence_until_iso !== null;
  if (hasCount && hasUntil) {
    throw new Error(
      'Pass either recurrence_count OR recurrence_until_iso, not both — they are two ways to bound the same series.',
    );
  }
  if ((hasCount || hasUntil) && freq === null) {
    throw new Error(
      `${hasCount ? 'recurrence_count' : 'recurrence_until_iso'} requires recurrence_freq to also be set (a range only means something for a repeating series).`,
    );
  }
  if (hasCount) {
    const count = asRecurrenceCount(obj.recurrence_count);
    if (count === 1) return { until: null, requestedCount: 1, collapsedToOneOff: true };
    return { until: untilFromCount(startMs, freq!, count), requestedCount: count, collapsedToOneOff: false };
  }
  if (hasUntil) {
    const until = parseRequiredIso(obj.recurrence_until_iso, 'recurrence_until_iso');
    if (until < startMs) {
      throw new Error('recurrence_until_iso must be on or after the first occurrence.');
    }
    return { until, requestedCount: null, collapsedToOneOff: false };
  }
  // Explicit null on recurrence_until_iso means "clear the bound"; absent means
  // "no bound given" — both leave the series open-ended.
  return { until: null, requestedCount: null, collapsedToOneOff: false };
}

function asRecurrenceCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_RECURRENCE_COUNT) {
    throw new Error(`recurrence_count: must be an integer between 1 and ${MAX_RECURRENCE_COUNT} (got ${JSON.stringify(v)})`);
  }
  return v;
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
