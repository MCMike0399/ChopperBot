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
      .map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description ?? null,
        startAtMs: e.scheduledStartTimestamp ?? 0,
        endAtMs: e.scheduledEndTimestamp ?? null,
        channelId: e.channelId ?? null,
        location: e.entityMetadata?.location ?? null,
        recurring: e.recurrenceRule != null,
        url: `https://discord.com/events/${guildId}/${e.id}`,
      }))
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
    };
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

/** The calendar-side facts needed to mint a Discord scheduled event. */
export interface ScheduledEventDraft {
  title: string;
  description: string | null;
  startAtMs: number;
  endAtMs: number | null;
  /** Free-text location from the calendar row ("Sala de Eventos", "El Ángel"). */
  location: string | null;
}

/**
 * Create the Discord scheduled event for a calendar row.
 *
 * Venue resolution is deliberately forgiving, because the calendar's `location`
 * is free text a mod typed: if it fuzzily names a voice/stage channel the bot
 * can see, we tie the event to that channel (members get the join button);
 * otherwise we fall back to an EXTERNAL event with the text as its location —
 * which Discord requires an end time for, so one is synthesized when absent.
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

  const venueChannel = await resolveVenueChannel(guild, draft.location);
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
    });
    log.info(
      { guildId, discordEventId: created.id, title: draft.title, venue: venueChannel?.name ?? 'external' },
      'calendar.discord_events.created',
    );
    return {
      ok: true,
      event: {
        id: created.id,
        name: created.name,
        description: created.description ?? null,
        startAtMs: created.scheduledStartTimestamp ?? draft.startAtMs,
        endAtMs: created.scheduledEndTimestamp ?? null,
        channelId: created.channelId ?? null,
        location: created.entityMetadata?.location ?? null,
        recurring: created.recurrenceRule != null,
        url: `https://discord.com/events/${guildId}/${created.id}`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, guildId, title: draft.title }, 'calendar.discord_events.create_failed');
    return { ok: false, reason: 'error', message };
  }
}

/**
 * Creating the Discord scheduled event for a calendar row, as a tool-facing
 * capability. Injected into {@link ../source.js CalendarToolSource} so the tool
 * layer stays free of discord.js and unit-testable with a fake.
 */
export interface DiscordEventSyncer {
  sync(eventId: number): Promise<SyncOutcome>;
}

export type SyncOutcome =
  | {
      ok: true;
      discordEventId: string;
      url: string;
      /** False when the row was already linked to a live Discord event. */
      created: boolean;
      startAtLocal: string;
    }
  | {
      ok: false;
      reason: 'not_found' | 'in_past' | 'missing_permission' | 'error';
      message: string;
    };

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
  return {
    async sync(eventId: number): Promise<SyncOutcome> {
      const row = deps.store.get(eventId);
      if (!row) return { ok: false, reason: 'not_found', message: `No existe el evento #${eventId}.` };

      if (row.discord_event_id) {
        const existing = await fetchScheduledEvent(deps.client, deps.guildId, row.discord_event_id);
        if (existing) {
          return {
            ok: true,
            discordEventId: existing.id,
            url: existing.url,
            created: false,
            startAtLocal: fmt(existing.startAtMs),
          };
        }
        deps.store.setDiscordEventId(eventId, null); // stale link — the admin deleted it
      }

      // A series' master start is usually in the past; schedule what's next.
      const nowMs = now();
      let startAtMs = row.start_at;
      let endAtMs = row.end_at;
      if (startAtMs <= nowMs && row.recurrence_freq !== null) {
        const next = deps.store.listUpcoming(nowMs, 60).find((o) => o.id === eventId);
        if (!next) {
          return {
            ok: false,
            reason: 'in_past',
            message: `La serie #${eventId} ya no tiene ocurrencias futuras.`,
          };
        }
        startAtMs = next.start_at;
        endAtMs = next.end_at;
      }
      if (startAtMs <= nowMs) {
        return {
          ok: false,
          reason: 'in_past',
          message: `El evento #${eventId} ya pasó; Discord no acepta eventos en el pasado.`,
        };
      }

      const outcome = await createScheduledEvent(deps.client, deps.guildId, {
        title: row.title,
        description: row.description,
        startAtMs,
        endAtMs,
        location: row.location,
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
      };
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
 * The voice/stage channel a free-text location names, if the bot can see it.
 * Matches on normalized containment either way round, so "sala de eventos"
 * finds "🎙️ Sala de Eventos 🎙️" and "Asamblea-Z" finds "⛓️‍💥 Asamblea-Z ⛓️‍💥".
 */
async function resolveVenueChannel(
  guild: Guild,
  location: string | null,
): Promise<{ id: string; name: string; type: ChannelType } | null> {
  const wanted = normalizeVenue(location ?? '');
  if (!wanted) return null;
  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) return null;
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return null;
  for (const c of channels.values()) {
    if (!c) continue;
    if (c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice) continue;
    if (!c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) continue;
    const name = normalizeVenue(c.name);
    if (name === wanted || name.includes(wanted) || wanted.includes(name)) {
      return { id: c.id, name: c.name, type: c.type };
    }
  }
  return null;
}
