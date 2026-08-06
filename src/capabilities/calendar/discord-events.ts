/**
 * The bot's view of Discord's own **Scheduled Events** — the native "Eventos"
 * entries members click to RSVP, and whose `discord.com/events/<guild>/<id>`
 * link renders as a rich card in a message. That link is exactly what the
 * community's admins paste when they announce something, so the daily announcer
 * needs to read (and ideally create) these.
 *
 * Two things about the Discord API drive this module's shape:
 *
 *  - **Reading is filtered by channel visibility.** `GET /guilds/{id}/
 *    scheduled-events` only returns events the bot can see, and an event tied to
 *    a voice/stage channel it can't `ViewChannel` is silently omitted — not
 *    errored. In this guild most event rooms are role-gated (Asamblea-Z, Sala de
 *    Club de Poesía, Sala de Cineclub…), so a bot without `ManageEvents` sees a
 *    fraction of the calendar and can't tell the difference between "no event
 *    exists" and "I'm not allowed to see it". {@link diagnoseEventAccess} makes
 *    that difference visible instead of guessing.
 *  - **Creating needs `ManageEvents`**, which is a guild-level permission. When
 *    it's missing we return a typed failure carrying the exact fix in Spanish,
 *    so the caller can nudge the mods instead of failing silently.
 *
 * Since 2026-08-06 the syncer is a **lifecycle**, not a one-shot create: a
 * calendar row linked to a Discord event should track it — edits propagate
 * ({@link DiscordEventSyncer.refresh}) and deletion cancels the Discord side
 * ({@link DiscordEventSyncer.remove}). This came out of a real dead end: a mod
 * moved an event and the bot could only say "edit the Discord one by hand",
 * which is exactly the chore the link exists to eliminate.
 *
 * Everything here is best-effort and never throws into a caller's loop.
 */
import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildScheduledEvent,
} from 'discord.js';
import { log } from '../../log.js';

/** A Discord scheduled event, flattened to what matching + announcing need. */
export interface DiscordScheduledEvent {
  id: string;
  name: string;
  description: string | null;
  /** Start of the NEXT occurrence for a recurring event (Discord's own semantics). */
  startAtMs: number;
  endAtMs: number | null;
  /** Voice/stage channel it happens in, if any. */
  channelId: string | null;
  /** Free-text place for an EXTERNAL event. */
  location: string | null;
  /** Whether Discord considers it repeating (has a recurrence rule). */
  recurring: boolean;
  /** `https://discord.com/events/<guildId>/<id>` — the link admins paste. */
  url: string;
  /** CDN URL of the cover image (the "banner"), when one is set. */
  imageUrl: string | null;
}

/** Why we might be unable to see (or make) events, and what fixes it. */
export interface EventAccessDiagnosis {
  /** Whether the bot holds guild-level ManageEvents (needed to CREATE). */
  canManageEvents: boolean;
  /** Voice/stage channels the bot cannot ViewChannel — events there are invisible. */
  hiddenEventChannels: Array<{ id: string; name: string }>;
  /** Human, Spanish, actionable. Empty when nothing is wrong. */
  problems: string[];
}

/** A create attempt: the new event, or a typed reason it couldn't happen. */
export type CreateEventOutcome =
  | { ok: true; event: DiscordScheduledEvent }
  | { ok: false; reason: 'missing_permission' | 'no_venue' | 'error'; message: string };

/** Guild-scheduled-event statuses that are still ahead of us. */
const LIVE_STATUSES = new Set<GuildScheduledEventStatus>([
  GuildScheduledEventStatus.Scheduled,
  GuildScheduledEventStatus.Active,
]);

/** Default length given to a created event when the calendar row has no end. */
const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60_000;

/** Flatten the discord.js event to our shape (one place — both fetchers use it). */
function flattenEvent(guildId: string, e: GuildScheduledEvent): DiscordScheduledEvent {
  return {
    id: e.id,
    name: e.name,
    description: e.description ?? null,
    startAtMs: e.scheduledStartTimestamp ?? 0,
    endAtMs: e.scheduledEndTimestamp ?? null,
    channelId: e.channelId ?? null,
    location: e.entityMetadata?.location ?? null,
    recurring: e.recurrenceRule != null,
    url: `https://discord.com/events/${guildId}/${e.id}`,
    imageUrl: e.coverImageURL({ size: 1024 }),
  };
}

/**
 * Every upcoming/active scheduled event of a guild, normalized. Returns `null`
 * (not `[]`) when the fetch itself failed, so a caller can tell "nothing
 * scheduled" from "I couldn't look".
 */
export async function fetchScheduledEvents(
  client: Client,
  guildId: string,
): Promise<DiscordScheduledEvent[] | null> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const events = await guild.scheduledEvents.fetch();
    return [...events.values()]
      .filter((e) => LIVE_STATUSES.has(e.status))
      .map((e) => flattenEvent(guildId, e))
      .filter((e) => e.startAtMs > 0);
  } catch (err) {
    log.warn({ err, guildId }, 'calendar.discord_events.fetch_failed');
    return null;
  }
}

/**
 * One scheduled event by id, or null if it's gone/invisible. Used to verify a
 * link we already stored still points at something real (an admin may have
 * deleted the event after we learned the match).
 */
export async function fetchScheduledEvent(
  client: Client,
  guildId: string,
  eventId: string,
): Promise<DiscordScheduledEvent | null> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const e = await guild.scheduledEvents.fetch(eventId);
    if (!LIVE_STATUSES.has(e.status)) return null;
    return flattenEvent(guildId, e);
  } catch {
    return null;
  }
}

/**
 * What's blocking event access in this guild. This exists because both failure
 * modes are *silent* by default: a missing `ManageEvents` just means creates
 * throw, and a hidden event channel just means events vanish from the list.
 */
export async function diagnoseEventAccess(
  client: Client,
  guildId: string,
): Promise<EventAccessDiagnosis> {
  const problems: string[] = [];
  try {
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetchMe();
    const canManageEvents = me.permissions.has(PermissionFlagsBits.ManageEvents);
    const hidden: Array<{ id: string; name: string }> = [];
    const channels = await guild.channels.fetch();
    for (const c of channels.values()) {
      if (!c) continue;
      if (c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice) continue;
      if (!c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) {
        hidden.push({ id: c.id, name: c.name });
      }
    }
    if (!canManageEvents) {
      problems.push(
        'Al bot le falta el permiso **Gestionar eventos** en el servidor: no puede crear eventos de Discord ' +
          'y no ve los eventos que viven en canales de voz/escenario a los que no tiene acceso.',
      );
    }
    if (hidden.length > 0 && !canManageEvents) {
      problems.push(
        `No puedo ver ${hidden.length} canal(es) de voz/escenario (${hidden
          .slice(0, 4)
          .map((c) => c.name)
          .join(', ')}${hidden.length > 4 ? '…' : ''}), así que los eventos ahí son invisibles para mí.`,
      );
    }
    return { canManageEvents, hiddenEventChannels: hidden, problems };
  } catch (err) {
    log.warn({ err, guildId }, 'calendar.discord_events.diagnose_failed');
    return {
      canManageEvents: false,
      hiddenEventChannels: [],
      problems: ['No pude revisar los permisos de eventos en el servidor.'],
    };
  }
}

// ── Cover images (the event "banner") ────────────────────────────────────────

/** A downloaded image, ready to hand to Discord as the event cover. */
export interface FetchedImage {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Hosts an event image may come from. The model is handed attachment URLs in
 * the prompt and can echo one back as a tool parameter — pinning the host set
 * means a prompt-injected URL can never turn into the bot fetching an
 * arbitrary address (SSRF guard).
 */
const EVENT_IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Cover images are flyers — same ballpark as the attachment caps elsewhere. */
const EVENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const EVENT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

/**
 * Download an image the conversation offered (a Discord attachment URL), with
 * the guards above. Returns null on ANY problem — a missing banner must never
 * block creating/updating the event itself.
 */
export async function fetchDiscordCdnImage(url: string): Promise<FetchedImage | null> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!EVENT_IMAGE_HOSTS.has(host)) {
    log.warn({ host }, 'calendar.discord_events.image_host_rejected');
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      log.warn({ status: response.status }, 'calendar.discord_events.image_fetch_failed');
      return null;
    }
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!EVENT_IMAGE_MIMES.has(mimeType)) {
      log.warn({ mimeType }, 'calendar.discord_events.image_bad_mime');
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > EVENT_IMAGE_MAX_BYTES) {
      log.warn({ bytes: bytes.byteLength }, 'calendar.discord_events.image_bad_size');
      return null;
    }
    return { bytes, mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType };
  } catch (err) {
    log.warn({ err }, 'calendar.discord_events.image_fetch_failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The calendar-side facts needed to mint a Discord scheduled event. */
export interface ScheduledEventDraft {
  title: string;
  description: string | null;
  startAtMs: number;
  endAtMs: number | null;
  /** Free-text location from the calendar row ("Sala de Eventos", "El Ángel"). */
  location: string | null;
  /** Cover image to set, already downloaded. Absent → no banner. */
  image?: FetchedImage | null;
}

/** discord.js accepts a `data:` URI verbatim — build it with the real mime. */
function toImageDataUri(image: FetchedImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

/**
 * Create the Discord scheduled event for a calendar row.
 *
 * Venue resolution is deliberately forgiving, because the calendar's `location`
 * is free text a mod typed: if it fuzzily names a voice/stage channel the bot
 * can see, we tie the event to that channel (members get the join button);
 * when there's no location at all we try the event TITLE ("… | Club de poesía"
 * lands in the Sala de Club de Poesía); otherwise we fall back to an EXTERNAL
 * event with the text as its location — which Discord requires an end time
 * for, so one is synthesized when absent.
 */
export async function createScheduledEvent(
  client: Client,
  guildId: string,
  draft: ScheduledEventDraft,
): Promise<CreateEventOutcome> {
  let guild: Guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageEvents)) {
    return {
      ok: false,
      reason: 'missing_permission',
      message:
        'No tengo el permiso **Gestionar eventos** en este servidor, así que no puedo crear el evento de Discord. ' +
        'Un admin puede activarlo en Ajustes del servidor → Roles → ChopperBot → «Gestionar eventos».',
    };
  }

  const venueChannel = await resolveVenue(guild, draft.location, draft.title);
  try {
    const created = await guild.scheduledEvents.create({
      name: draft.title.slice(0, 100),
      description: draft.description?.slice(0, 1000) ?? undefined,
      scheduledStartTime: new Date(draft.startAtMs),
      scheduledEndTime: venueChannel
        ? draft.endAtMs !== null
          ? new Date(draft.endAtMs)
          : undefined
        : new Date(draft.endAtMs ?? draft.startAtMs + DEFAULT_EVENT_DURATION_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: venueChannel
        ? venueChannel.type === ChannelType.GuildStageVoice
          ? GuildScheduledEventEntityType.StageInstance
          : GuildScheduledEventEntityType.Voice
        : GuildScheduledEventEntityType.External,
      channel: venueChannel ? venueChannel.id : undefined,
      entityMetadata: venueChannel
        ? undefined
        : { location: (draft.location?.trim() || 'Revolución Z').slice(0, 100) },
      image: draft.image ? toImageDataUri(draft.image) : undefined,
    });
    log.info(
      {
        guildId,
        discordEventId: created.id,
        title: draft.title,
        venue: venueChannel?.name ?? 'external',
        hasImage: draft.image != null,
      },
      'calendar.discord_events.created',
    );
    return { ok: true, event: flattenEvent(guildId, created) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, guildId, title: draft.title }, 'calendar.discord_events.create_failed');
    return { ok: false, reason: 'error', message };
  }
}

/**
 * Creating/updating/removing the Discord scheduled event for a calendar row,
 * as a tool-facing capability. Injected into {@link ../source.js
 * CalendarToolSource} so the tool layer stays free of discord.js and
 * unit-testable with a fake.
 */
export interface DiscordEventSyncer {
  sync(eventId: number, opts?: SyncOptions): Promise<SyncOutcome>;
  refresh(eventId: number, opts?: SyncOptions): Promise<RefreshOutcome>;
  remove(eventId: number): Promise<RemoveOutcome>;
}

/** Extra, optional inputs a sync/refresh can carry. */
export interface SyncOptions {
  /**
   * A Discord attachment URL to set as the event's cover image — one the
   * conversation actually offered (the tool layer validates that). On `sync`
   * it applies even when the event already exists (that's how a late flyer
   * becomes the banner); a failed download never fails the operation.
   */
  imageUrl?: string | null;
}

export type SyncOutcome =
  | {
      ok: true;
      discordEventId: string;
      url: string;
      /** False when the row was already linked to a live Discord event. */
      created: boolean;
      startAtLocal: string;
      /** True when this call set the cover image. */
      imageSet?: boolean;
    }
  | {
      ok: false;
      reason: 'not_found' | 'in_past' | 'missing_permission' | 'error';
      message: string;
    };

/**
 * The result of pushing a calendar EDIT through to its linked Discord event.
 * The `not_linked`/`unchanged` actions are quiet no-ops — most calendar edits
 * touch rows nobody ever made a Discord event for.
 */
export type RefreshOutcome =
  | { ok: true; action: 'updated'; url: string; changed: string[]; imageSet?: boolean }
  | { ok: true; action: 'unchanged' | 'not_linked' | 'no_future' | 'stale_cleared'; url?: string }
  | { ok: false; reason: 'not_found' | 'missing_permission' | 'error'; message: string };

export type RemoveOutcome =
  | { ok: true; action: 'deleted' | 'not_linked' }
  | { ok: false; reason: 'not_found' | 'missing_permission' | 'error'; message: string };

export interface EventSyncerDeps {
  client: Client;
  guildId: string;
  /** Read the row + persist the resulting link. */
  store: {
    get(id: number): CalendarEventLike | null;
    listUpcoming(fromMs: number, limit: number): Array<{ id: number; start_at: number; end_at: number | null }>;
    setDiscordEventId(id: number, discordEventId: string | null): void;
  };
  now?: () => number;
  formatLocal?: (ms: number) => string;
  /** Downloads a conversation-offered image; defaults to the CDN-guarded fetcher. */
  fetchImage?: (url: string) => Promise<FetchedImage | null>;
}

/** The calendar row fields the syncer needs. */
export interface CalendarEventLike {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  start_at: number;
  end_at: number | null;
  recurrence_freq: string | null;
  discord_event_id: string | null;
}

/**
 * The occurrence a linked Discord event should reflect: the row's own start
 * when it's ahead, else the next occurrence of a series. Null when the row has
 * nothing in the future (a past one-off, or an exhausted series).
 */
function nextOccurrenceOf(
  row: CalendarEventLike,
  nowMs: number,
  store: EventSyncerDeps['store'],
): { startAtMs: number; endAtMs: number | null } | null {
  if (row.start_at > nowMs) return { startAtMs: row.start_at, endAtMs: row.end_at };
  if (row.recurrence_freq === null) return null;
  const next = store.listUpcoming(nowMs, 60).find((o) => o.id === row.id);
  return next ? { startAtMs: next.start_at, endAtMs: next.end_at } : null;
}

/**
 * Create the Discord scheduled event for calendar row `eventId`, and remember
 * the link. Idempotent: a row already pointing at a live Discord event returns
 * that one instead of minting a duplicate (the community would otherwise end up
 * with two RSVP lists for one evening).
 *
 * For a recurring series this schedules the **next occurrence** rather than
 * translating our recurrence into Discord's own recurrence rules — one obvious
 * event beats a half-faithful repeating one, and the next occurrence is what a
 * member wants to click today.
 */
export function createEventSyncer(deps: EventSyncerDeps): DiscordEventSyncer {
  const now = deps.now ?? (() => Date.now());
  const fmt = deps.formatLocal ?? ((ms: number) => new Date(ms).toISOString());
  const fetchImage = deps.fetchImage ?? fetchDiscordCdnImage;

  const missingPermission = {
    ok: false as const,
    reason: 'missing_permission' as const,
    message:
      'No tengo el permiso **Gestionar eventos** en este servidor. ' +
      'Un admin puede activarlo en Ajustes del servidor → Roles → ChopperBot → «Gestionar eventos».',
  };

  async function canManage(guild: Guild): Promise<boolean> {
    const me = await guild.members.fetchMe().catch(() => null);
    return me?.permissions.has(PermissionFlagsBits.ManageEvents) ?? false;
  }

  return {
    async sync(eventId, opts = {}): Promise<SyncOutcome> {
      const row = deps.store.get(eventId);
      if (!row) return { ok: false, reason: 'not_found', message: `No existe el evento #${eventId}.` };

      const image = opts.imageUrl ? await fetchImage(opts.imageUrl) : null;

      if (row.discord_event_id) {
        const existing = await fetchScheduledEvent(deps.client, deps.guildId, row.discord_event_id);
        if (existing) {
          // Already linked: the only thing left to do is set/replace the banner.
          if (image) {
            const guild = await deps.client.guilds.fetch(deps.guildId).catch(() => null);
            if (guild) {
              await guild.scheduledEvents
                .edit(existing.id, { image: toImageDataUri(image) })
                .catch((err) =>
                  log.warn({ err, eventId, discordEventId: existing.id }, 'calendar.discord_events.image_edit_failed'),
                );
            }
          }
          return {
            ok: true,
            discordEventId: existing.id,
            url: existing.url,
            created: false,
            startAtLocal: fmt(existing.startAtMs),
            imageSet: image != null,
          };
        }
        deps.store.setDiscordEventId(eventId, null); // stale link — the admin deleted it
      }

      const nowMs = now();
      const next = nextOccurrenceOf(row, nowMs, deps.store);
      if (!next) {
        return {
          ok: false,
          reason: 'in_past',
          message:
            row.recurrence_freq !== null
              ? `La serie #${eventId} ya no tiene ocurrencias futuras.`
              : `El evento #${eventId} ya pasó; Discord no acepta eventos en el pasado.`,
        };
      }

      const outcome = await createScheduledEvent(deps.client, deps.guildId, {
        title: row.title,
        description: row.description,
        startAtMs: next.startAtMs,
        endAtMs: next.endAtMs,
        location: row.location,
        image,
      });
      if (!outcome.ok) {
        return {
          ok: false,
          reason: outcome.reason === 'missing_permission' ? 'missing_permission' : 'error',
          message: outcome.message,
        };
      }
      deps.store.setDiscordEventId(eventId, outcome.event.id);
      return {
        ok: true,
        discordEventId: outcome.event.id,
        url: outcome.event.url,
        created: true,
        startAtLocal: fmt(outcome.event.startAtMs),
        imageSet: image != null,
      };
    },

    /**
     * Make the linked Discord event match the calendar row after an edit.
     * Deliberately conservative about what it touches: it updates the fields
     * the calendar actually knows (title, description, time, a positively
     * resolved venue, an explicitly offered banner) and leaves everything
     * else — a manually set banner, a hand-picked room — alone.
     */
    async refresh(eventId, opts = {}): Promise<RefreshOutcome> {
      const row = deps.store.get(eventId);
      if (!row) return { ok: false, reason: 'not_found', message: `No existe el evento #${eventId}.` };
      if (!row.discord_event_id) return { ok: true, action: 'not_linked' };

      const guild = await deps.client.guilds.fetch(deps.guildId).catch(() => null);
      if (!guild) return { ok: false, reason: 'error', message: 'No pude acceder al servidor.' };

      const existing = await fetchScheduledEvent(deps.client, deps.guildId, row.discord_event_id);
      if (!existing) {
        deps.store.setDiscordEventId(eventId, null); // the admin deleted it by hand
        return { ok: true, action: 'stale_cleared' };
      }

      const next = nextOccurrenceOf(row, now(), deps.store);
      if (!next) return { ok: true, action: 'no_future', url: existing.url };

      const venueChannel = await resolveVenue(guild, row.location, row.title);
      const name = row.title.slice(0, 100);
      const description = row.description?.slice(0, 1000) ?? null;
      const endAtMs = next.endAtMs ?? (venueChannel ?? existing.channelId ? null : next.startAtMs + DEFAULT_EVENT_DURATION_MS);

      const changed: string[] = [];
      if (name !== existing.name) changed.push('título');
      if (description !== existing.description) changed.push('descripción');
      if (next.startAtMs !== existing.startAtMs) changed.push('fecha/hora');
      if (endAtMs !== null && endAtMs !== existing.endAtMs) changed.push('hora de fin');
      // Only move the event when a venue is POSITIVELY resolved and differs —
      // an unresolvable location never strips a room a mod picked by hand.
      const moveToVenue = venueChannel !== null && venueChannel.id !== existing.channelId;
      if (moveToVenue) changed.push('sala');

      const image = opts.imageUrl ? await fetchImage(opts.imageUrl) : null;
      if (image) changed.push('portada');

      if (changed.length === 0) return { ok: true, action: 'unchanged', url: existing.url };
      if (!(await canManage(guild))) return { ...missingPermission };

      try {
        await guild.scheduledEvents.edit(existing.id, {
          name,
          description: description ?? undefined,
          scheduledStartTime: new Date(next.startAtMs),
          scheduledEndTime: endAtMs !== null ? new Date(endAtMs) : undefined,
          ...(moveToVenue && venueChannel
            ? {
                channel: venueChannel.id,
                entityType:
                  venueChannel.type === ChannelType.GuildStageVoice
                    ? GuildScheduledEventEntityType.StageInstance
                    : GuildScheduledEventEntityType.Voice,
              }
            : {}),
          ...(image ? { image: toImageDataUri(image) } : {}),
        });
        log.info(
          { eventId, discordEventId: existing.id, changed },
          'calendar.discord_events.refreshed',
        );
        return { ok: true, action: 'updated', url: existing.url, changed, imageSet: image != null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err, eventId, discordEventId: existing.id }, 'calendar.discord_events.refresh_failed');
        return { ok: false, reason: 'error', message };
      }
    },

    /** Cancel the Discord side of a deleted calendar event (RSVPs end there). */
    async remove(eventId): Promise<RemoveOutcome> {
      const row = deps.store.get(eventId);
      if (!row) return { ok: false, reason: 'not_found', message: `No existe el evento #${eventId}.` };
      if (!row.discord_event_id) return { ok: true, action: 'not_linked' };

      const existing = await fetchScheduledEvent(deps.client, deps.guildId, row.discord_event_id);
      if (!existing) {
        deps.store.setDiscordEventId(eventId, null);
        return { ok: true, action: 'deleted' }; // already gone by hand
      }
      const guild = await deps.client.guilds.fetch(deps.guildId).catch(() => null);
      if (!guild || !(await canManage(guild))) return { ...missingPermission };
      try {
        await guild.scheduledEvents.delete(existing.id);
        deps.store.setDiscordEventId(eventId, null);
        log.info({ eventId, discordEventId: existing.id }, 'calendar.discord_events.deleted');
        return { ok: true, action: 'deleted' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err, eventId, discordEventId: existing.id }, 'calendar.discord_events.delete_failed');
        return { ok: false, reason: 'error', message };
      }
    },
  };
}

/** Normalize a name for fuzzy venue matching: accents off, decoration dropped. */
function normalizeVenue(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Generic words in this guild's room names that carry no signal for matching
 * ("Sala de Club de Poesía" is really about "club poesía"). Dropped from BOTH
 * sides before containment, so "Rosario Castellanos | Club de poesía" matches
 * the room whose significant phrase is "club poesia".
 */
const VENUE_STOPWORDS = new Set(['sala', 'salon', 'de', 'del', 'la', 'el', 'vc']);

/** A room's significant phrase: its normalized name minus the stopwords. */
function venueKeyPhrase(name: string): string {
  return normalizeVenue(name)
    .split(' ')
    .filter((t) => !VENUE_STOPWORDS.has(t))
    .join(' ');
}

/** Single-token phrases this short are too easy to hit by accident. */
const MIN_SINGLE_TOKEN_LEN = 4;

interface VenueCandidate {
  id: string;
  name: string;
  type: ChannelType;
}

/**
 * The voice/stage channel for an event, from two signals in priority order:
 *  1. the explicit free-text `location` a mod typed (containment either way —
 *     "sala de eventos" finds "🎙️ Sala de Eventos 🎙️");
 *  2. the event TITLE, matched on the room's significant phrase ("… | Club de
 *     poesía" → "🫀 Sala de Club de Poesía 🫀"). Conservative by design: the
 *     full significant phrase must appear in the title, and a one-word phrase
 *     must be at least a few letters — a wrong room is worse than none.
 * Only rooms the bot can `ViewChannel` are eligible (invisible ones can't host
 * an event we manage anyway).
 */
async function resolveVenue(
  guild: Guild,
  location: string | null,
  title: string,
): Promise<VenueCandidate | null> {
  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) return null;
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return null;

  const venues: VenueCandidate[] = [];
  for (const c of channels.values()) {
    if (!c) continue;
    if (c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice) continue;
    if (!c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) continue;
    venues.push({ id: c.id, name: c.name, type: c.type });
  }

  const wanted = normalizeVenue(location ?? '');
  if (wanted) {
    for (const v of venues) {
      const name = normalizeVenue(v.name);
      if (name === wanted || name.includes(wanted) || wanted.includes(name)) return v;
    }
  }

  const titleNorm = normalizeVenue(title)
    .split(' ')
    .filter((t) => !VENUE_STOPWORDS.has(t))
    .join(' ');
  if (titleNorm) {
    for (const v of venues) {
      const phrase = venueKeyPhrase(v.name);
      if (!phrase) continue;
      const tokens = phrase.split(' ');
      if (tokens.length === 1 && tokens[0]!.length < MIN_SINGLE_TOKEN_LEN) continue;
      if (titleNorm.includes(phrase)) {
        log.info({ venue: v.name, title }, 'calendar.discord_events.venue_inferred');
        return v;
      }
    }
  }
  return null;
}
