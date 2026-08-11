/**
 * The Discord-event syncer as a LIFECYCLE: create (with banner + venue),
 * refresh after a calendar edit, remove after a calendar delete. Everything
 * runs against a fake guild — no Discord, no network — with the real
 * `createEventSyncer` wiring.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

// Silence the module's own logging (failures surface as assertion misses).
vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  createEventSyncer,
  fetchDiscordCdnImage,
  type CalendarEventLike,
  type FetchedImage,
} from '../discord-events.js';

const GUILD = 'G1';
const NOW = Date.parse('2026-08-06T18:00:00Z');
/** 2026-08-12 02:00 UTC = Aug 11, 8:00 PM CDMX. */
const START = Date.parse('2026-08-12T02:00:00Z');

interface FakeEventState {
  id: string;
  name: string;
  description: string | null;
  scheduledStartTimestamp: number;
  scheduledEndTimestamp: number | null;
  channelId: string | null;
  location: string | null;
  image: string | null;
}

function makeClient(opts: {
  canManage?: boolean;
  venues?: Array<{ id: string; name: string; type: ChannelType }>;
  events?: FakeEventState[];
  /**
   * Reject an edit that gives a room to an EXTERNAL event without clearing its
   * location — the way Discord does, and the reason the REST conversion exists
   * (discord.js's `edit()` cannot send `entity_metadata: null`).
   */
  rejectStaleMetadata?: boolean;
}) {
  const events = new Map<string, FakeEventState>((opts.events ?? []).map((e) => [e.id, { ...e }]));
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    edit: [] as Array<{ id: string; payload: Record<string, unknown> }>,
    patch: [] as Array<{ route: string; body: Record<string, unknown> }>,
    delete: [] as string[],
  };
  let seq = 1;
  const toWire = (e: FakeEventState) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    scheduledStartTimestamp: e.scheduledStartTimestamp,
    scheduledEndTimestamp: e.scheduledEndTimestamp,
    channelId: e.channelId,
    entityMetadata: e.location !== null ? { location: e.location } : null,
    recurrenceRule: null,
    status: 1, // GuildScheduledEventStatus.Scheduled
    coverImageURL: () =>
      e.image !== null ? `https://cdn.discordapp.com/guild-events/${e.id}/hash.png` : null,
  });
  const guild: Record<string, unknown> = {
    id: GUILD,
    // The raw-REST escape hatch the external→voice conversion uses.
    client: {
      rest: {
        patch: async (route: string, options: { body: Record<string, unknown> }) => {
          calls.patch.push({ route, body: options.body });
          const id = route.split('/').pop()!;
          const e = events.get(id);
          if (!e) throw new Error('Unknown event');
          if (options.body.entity_metadata !== null) {
            throw new Error('Cannot have entity metadata for this event type');
          }
          e.channelId = options.body.channel_id as string;
          e.location = null;
          return toWire(e);
        },
      },
    },
    members: {
      fetchMe: async () => ({
        permissions: {
          has: (flag: bigint) =>
            flag === PermissionFlagsBits.ManageEvents ? (opts.canManage ?? true) : true,
        },
      }),
    },
    channels: {
      // Discord's own overload: no id → every channel, an id → that one.
      fetch: async (id?: string) => {
        const all = new Map(
          (opts.venues ?? []).map((v) => [
            v.id,
            { ...v, permissionsFor: () => ({ has: () => true }) },
          ]),
        );
        return id === undefined ? all : (all.get(id) ?? null);
      },
    },
    scheduledEvents: {
      fetch: async (id?: string) => {
        if (id === undefined) return new Map([...events.values()].map((e) => [e.id, toWire(e)]));
        const e = events.get(id);
        if (!e) throw new Error('Unknown event');
        return toWire(e);
      },
      create: async (payload: Record<string, unknown>) => {
        calls.create.push(payload);
        const e: FakeEventState = {
          id: `DE${seq++}`,
          name: payload.name as string,
          description: (payload.description as string | undefined) ?? null,
          scheduledStartTimestamp: new Date(payload.scheduledStartTime as Date).getTime(),
          scheduledEndTimestamp: payload.scheduledEndTime
            ? new Date(payload.scheduledEndTime as Date).getTime()
            : null,
          channelId: (payload.channel as string | undefined) ?? null,
          location:
            (payload.entityMetadata as { location?: string } | undefined)?.location ?? null,
          image: (payload.image as string | undefined) ?? null,
        };
        events.set(e.id, e);
        return toWire(e);
      },
      edit: async (id: string, payload: Record<string, unknown>) => {
        calls.edit.push({ id, payload });
        const e = events.get(id);
        if (!e) throw new Error('Unknown event');
        if (
          opts.rejectStaleMetadata &&
          payload.channel !== undefined &&
          e.channelId === null &&
          payload.entityMetadata === undefined
        ) {
          throw new Error('Cannot have entity metadata for this event type');
        }
        if (payload.name !== undefined) e.name = payload.name as string;
        if (payload.description !== undefined) e.description = payload.description as string;
        if (payload.scheduledStartTime !== undefined)
          e.scheduledStartTimestamp = new Date(payload.scheduledStartTime as Date).getTime();
        if (payload.scheduledEndTime !== undefined)
          e.scheduledEndTimestamp = new Date(payload.scheduledEndTime as Date).getTime();
        if (payload.channel !== undefined) e.channelId = payload.channel as string;
        if (payload.entityMetadata !== undefined)
          e.location = (payload.entityMetadata as { location?: string } | null)?.location ?? null;
        if (payload.image !== undefined) e.image = payload.image as string;
        return toWire(e);
      },
      delete: async (id: string) => {
        calls.delete.push(id);
        events.delete(id);
      },
    },
  };
  return { client: { guilds: { fetch: async () => guild } }, events, calls };
}

function makeStore(rows: CalendarEventLike[]) {
  const map = new Map<number, CalendarEventLike>(rows.map((r) => [r.id, { ...r }]));
  return {
    get: (id: number) => map.get(id) ?? null,
    listUpcoming: (fromMs: number, _limit: number) =>
      [...map.values()]
        .filter((r) => r.start_at > fromMs)
        .map((r) => ({ id: r.id, start_at: r.start_at, end_at: r.end_at })),
    setDiscordEventId: (id: number, v: string | null) => {
      const r = map.get(id);
      if (r) r.discord_event_id = v;
    },
  };
}

function row(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: 1,
    title: 'Rosario Castellanos | Club de poesía',
    description: null,
    location: null,
    start_at: START,
    end_at: null,
    recurrence_freq: null,
    discord_event_id: null,
    ...overrides,
  };
}

const PNG: FetchedImage = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
const fetchImageOk = vi.fn(async () => PNG);

function makeSyncer(client: unknown, store: ReturnType<typeof makeStore>, fetchImage = fetchImageOk) {
  return createEventSyncer({
    client: client as never,
    guildId: GUILD,
    store,
    now: () => NOW,
    fetchImage,
  });
}

afterEach(() => vi.clearAllMocks());

describe('sync — create', () => {
  test('infers the venue from the event title when there is no location', async () => {
    const { client, calls } = makeClient({
      venues: [
        { id: 'POESIA', name: '🫀 Sala de Club de Poesía 🫀', type: ChannelType.GuildStageVoice },
        { id: 'CINE', name: '🎬 Sala de Cineclub 🎬', type: ChannelType.GuildStageVoice },
      ],
    });
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store).sync(1);

    expect(out.ok).toBe(true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.channel).toBe('POESIA');
    expect(store.get(1)!.discord_event_id).toBe('DE1');
  });

  test('an explicit location beats title inference', async () => {
    const { client, calls } = makeClient({
      venues: [
        { id: 'POESIA', name: '🫀 Sala de Club de Poesía 🫀', type: ChannelType.GuildStageVoice },
        { id: 'CINE', name: '🎬 Sala de Cineclub 🎬', type: ChannelType.GuildStageVoice },
      ],
    });
    const store = makeStore([row({ location: 'sala de cineclub' })]);
    await makeSyncer(client, store).sync(1);
    expect(calls.create[0]!.channel).toBe('CINE');
  });

  test('no venue match falls back to an external event with a synthesized end', async () => {
    const { client, calls } = makeClient({ venues: [] });
    const store = makeStore([row({ title: 'Conversatorio: Data Centers y LLMs' })]);
    await makeSyncer(client, store).sync(1);
    expect(calls.create[0]!.channel).toBeUndefined();
    expect(calls.create[0]!.scheduledEndTime).toBeDefined();
  });

  test('the roomless fallback is REPORTED, not silent', async () => {
    // Live on 2026-08-10: #29 was created as `venue: external` and the bot
    // confirmed "listo" without ever saying nobody could join it.
    const { client } = makeClient({ venues: [] });
    const store = makeStore([row({ title: 'Conversatorio: Data Centers y LLMs' })]);
    const out = await makeSyncer(client, store).sync(1);
    expect(out.ok && out.venue).toEqual({ kind: 'external', name: 'Revolución Z' });
  });

  test('a resolved room comes back named, so the confirmation can say it', async () => {
    const { client } = makeClient({
      venues: [{ id: 'POESIA', name: '🫀 Sala de Club de Poesía 🫀', type: ChannelType.GuildStageVoice }],
    });
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store).sync(1);
    expect(out.ok && out.venue).toEqual({ kind: 'stage', name: '🫀 Sala de Club de Poesía 🫀' });
  });

  test('a conservative title match does NOT grab a room on a weak overlap', async () => {
    const { client, calls } = makeClient({
      venues: [
        { id: 'GESTION', name: 'VC gestión', type: ChannelType.GuildVoice },
        { id: 'EVENTOS', name: '🎙️ Sala de Eventos 🎙️', type: ChannelType.GuildStageVoice },
      ],
    });
    // No full significant phrase of either room appears in this title.
    const store = makeStore([row({ title: 'Charla: organización comunitaria' })]);
    await makeSyncer(client, store).sync(1);
    expect(calls.create[0]!.channel).toBeUndefined();
  });

  test('sets the cover image when one is offered', async () => {
    const { client, events, calls } = makeClient({ venues: [] });
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store).sync(1, {
      imageUrl: 'https://cdn.discordapp.com/attachments/1/2/flyer.png',
    });

    expect(fetchImageOk).toHaveBeenCalledWith('https://cdn.discordapp.com/attachments/1/2/flyer.png');
    expect((calls.create[0]!.image as string).startsWith('data:image/png;base64,')).toBe(true);
    expect(events.get('DE1')!.image).not.toBeNull();
    expect(out.ok && out.imageSet).toBe(true);
  });

  test('a failed image download never blocks the create', async () => {
    const { client, calls } = makeClient({ venues: [] });
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store, vi.fn(async () => null)).sync(1, {
      imageUrl: 'https://cdn.discordapp.com/attachments/1/2/gone.png',
    });
    expect(out.ok).toBe(true);
    expect(calls.create[0]!.image).toBeUndefined();
    expect(out.ok && out.imageSet).toBe(false);
  });
});

describe('sync — already linked', () => {
  const linkedEvent: FakeEventState = {
    id: 'DE9',
    name: 'Rosario Castellanos | Club de poesía',
    description: null,
    scheduledStartTimestamp: START,
    scheduledEndTimestamp: null,
    channelId: null,
    location: 'Revolución Z',
    image: null,
  };

  test('returns the existing event instead of duplicating it', async () => {
    const { client, calls } = makeClient({ events: [linkedEvent] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const out = await makeSyncer(client, store).sync(1);
    expect(out.ok && !out.created && out.discordEventId === 'DE9').toBe(true);
    expect(calls.create).toHaveLength(0);
  });

  test('but still sets the banner on it when one is offered ("ponle esta portada")', async () => {
    const { client, events, calls } = makeClient({ events: [linkedEvent] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const out = await makeSyncer(client, store).sync(1, {
      imageUrl: 'https://cdn.discordapp.com/attachments/1/2/flyer.png',
    });
    expect(out.ok && out.imageSet).toBe(true);
    expect(calls.edit).toHaveLength(1);
    expect((calls.edit[0]!.payload.image as string).startsWith('data:image/png;base64,')).toBe(true);
    expect(events.get('DE9')!.image).not.toBeNull();
  });
});

describe('refresh — a calendar edit propagates', () => {
  const staleEvent: FakeEventState = {
    id: 'DE9',
    name: 'Título viejo',
    description: null,
    scheduledStartTimestamp: Date.parse('2026-08-08T02:00:00Z'),
    scheduledEndTimestamp: null,
    channelId: 'POESIA',
    location: null,
    image: 'data:image/png;base64,oldbanner',
  };

  test('not linked → a quiet no-op, no Discord call', async () => {
    const { client, calls } = makeClient({});
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store).refresh(1);
    expect(out).toEqual({ ok: true, action: 'not_linked' });
    expect(calls.edit).toHaveLength(0);
  });

  test('updates title and time, and never touches a manually set banner', async () => {
    const { client, events, calls } = makeClient({ events: [staleEvent] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const out = await makeSyncer(client, store).refresh(1);

    expect(out.ok && out.action === 'updated').toBe(true);
    if (out.ok && out.action === 'updated') {
      expect(out.changed).toContain('título');
      expect(out.changed).toContain('fecha/hora');
    }
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]!.payload.image).toBeUndefined(); // the hand-set banner survives
    expect(events.get('DE9')!.image).toBe('data:image/png;base64,oldbanner');
    expect(events.get('DE9')!.name).toBe('Rosario Castellanos | Club de poesía');
    expect(events.get('DE9')!.scheduledStartTimestamp).toBe(START);
  });

  /** An event that exists but has no room — what a silent `external` create leaves behind. */
  const roomlessEvent: FakeEventState = {
    ...staleEvent,
    name: 'Rosario Castellanos | Club de poesía',
    scheduledStartTimestamp: START,
    channelId: null,
    location: 'Revolución Z',
  };
  const cineclub = [{ id: 'CINE', name: '🎬 Sala de Cineclub 🎬', type: ChannelType.GuildStageVoice }];

  test('giving a roomless event a location moves it into that room', async () => {
    // The repair path the bot now offers out loud ("quedó sin sala — ¿en cuál va?").
    const { client, events } = makeClient({ events: [roomlessEvent], venues: cineclub });
    const store = makeStore([row({ discord_event_id: 'DE9', location: 'sala de cineclub' })]);
    const out = await makeSyncer(client, store).refresh(1);

    expect(out.ok && out.action === 'updated').toBe(true);
    if (out.ok && out.action === 'updated') {
      expect(out.changed).toContain('sala');
      expect(out.venue).toEqual({ kind: 'stage', name: '🎬 Sala de Cineclub 🎬' });
    }
    expect(events.get('DE9')!.channelId).toBe('CINE');
  });

  test('…and still lands when Discord rejects the leftover entity_metadata', async () => {
    const { client, events, calls } = makeClient({
      events: [roomlessEvent],
      venues: cineclub,
      rejectStaleMetadata: true,
    });
    const store = makeStore([row({ discord_event_id: 'DE9', location: 'sala de cineclub' })]);
    const out = await makeSyncer(client, store).refresh(1);

    expect(out.ok && out.action === 'updated').toBe(true);
    if (out.ok && out.action === 'updated') expect(out.changed).toContain('sala');
    // The library edit bounced; the REST conversion sent the documented shape.
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0]!.body.entity_metadata).toBeNull();
    expect(calls.patch[0]!.body.channel_id).toBe('CINE');
    expect(events.get('DE9')!.channelId).toBe('CINE');
    expect(events.get('DE9')!.location).toBeNull();
  });

  test('a refresh that fails for any OTHER reason is still reported as a failure', async () => {
    const { client } = makeClient({ events: [roomlessEvent], venues: [] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const syncer = makeSyncer(client, store);
    // No venue in play → nothing to convert; a broken edit must surface.
    const guild = await (client as { guilds: { fetch: () => Promise<Record<string, never>> } }).guilds.fetch();
    (guild as unknown as { scheduledEvents: { edit: () => Promise<never> } }).scheduledEvents.edit = async () => {
      throw new Error('boom');
    };
    const out = await syncer.refresh(1);
    expect(out).toMatchObject({ ok: false, reason: 'error', message: 'boom' });
  });

  test('an unresolvable location never strips the room a mod picked by hand', async () => {
    const { client, events } = makeClient({ events: [staleEvent], venues: [] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    await makeSyncer(client, store).refresh(1);
    expect(events.get('DE9')!.channelId).toBe('POESIA');
  });

  test('nothing changed → unchanged, no edit call', async () => {
    const inSync: FakeEventState = {
      ...staleEvent,
      name: 'Rosario Castellanos | Club de poesía',
      scheduledStartTimestamp: START,
      // An external event always carries an end (Discord requires one); the
      // syncer synthesizes start+2h, so an event we created looks like this.
      scheduledEndTimestamp: START + 2 * 60 * 60_000,
      channelId: null,
      location: 'Revolución Z',
    };
    const { client, calls } = makeClient({ events: [inSync] });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const out = await makeSyncer(client, store).refresh(1);
    expect(out).toMatchObject({ ok: true, action: 'unchanged' });
    expect(calls.edit).toHaveLength(0);
  });

  test('a link to a deleted Discord event is cleared, not revived', async () => {
    const { client } = makeClient({ events: [] });
    const store = makeStore([row({ discord_event_id: 'DE_GONE' })]);
    const out = await makeSyncer(client, store).refresh(1);
    expect(out).toMatchObject({ ok: true, action: 'stale_cleared' });
    expect(store.get(1)!.discord_event_id).toBeNull();
  });

  test('a past one-off has nothing to reflect → no_future', async () => {
    const { client } = makeClient({ events: [staleEvent] });
    const store = makeStore([
      row({ discord_event_id: 'DE9', start_at: Date.parse('2026-08-01T02:00:00Z') }),
    ]);
    const out = await makeSyncer(client, store).refresh(1);
    expect(out).toMatchObject({ ok: true, action: 'no_future' });
  });
});

describe('remove — a calendar delete cancels the Discord event', () => {
  test('deletes the linked event and forgets the link', async () => {
    const { client, events, calls } = makeClient({
      events: [
        {
          id: 'DE9',
          name: 'X',
          description: null,
          scheduledStartTimestamp: START,
          scheduledEndTimestamp: null,
          channelId: null,
          location: null,
          image: null,
        },
      ],
    });
    const store = makeStore([row({ discord_event_id: 'DE9' })]);
    const out = await makeSyncer(client, store).remove(1);
    expect(out).toEqual({ ok: true, action: 'deleted' });
    expect(calls.delete).toEqual(['DE9']);
    expect(events.has('DE9')).toBe(false);
    expect(store.get(1)!.discord_event_id).toBeNull();
  });

  test('not linked → quiet no-op', async () => {
    const { client, calls } = makeClient({});
    const store = makeStore([row()]);
    const out = await makeSyncer(client, store).remove(1);
    expect(out).toEqual({ ok: true, action: 'not_linked' });
    expect(calls.delete).toHaveLength(0);
  });
});

describe('fetchDiscordCdnImage — the injection guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('refuses a non-Discord host without fetching anything', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchDiscordCdnImage('https://evil.example.com/x.png')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('refuses a non-image response from the CDN host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Map([['content-type', 'text/html']]),
        arrayBuffer: async () => new ArrayBuffer(4),
      })),
    );
    expect(await fetchDiscordCdnImage('https://cdn.discordapp.com/attachments/1/2/x.png')).toBeNull();
  });

  test('downloads a real CDN image with its mime type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Map([['content-type', 'image/png']]),
        arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
      })),
    );
    const img = await fetchDiscordCdnImage('https://cdn.discordapp.com/attachments/1/2/x.png');
    expect(img?.mimeType).toBe('image/png');
    expect([...(img?.bytes ?? [])]).toEqual([9, 8, 7]);
  });
});
