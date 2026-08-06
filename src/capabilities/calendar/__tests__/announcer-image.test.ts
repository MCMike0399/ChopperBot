/**
 * The daily announcement carries the event's flyer: when the linked Discord
 * event has a cover image, the announcement attaches it (like the admins'
 * manual posts, which always paste the flyer) — in addition to the event URL.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../llm/client.js', () => ({
  ask: vi.fn(async () => 'Amixes, hoy a las 8:00 PM tenemos Club de poesía. Lxs tqm.'),
}));

const fetchScheduledEvents = vi.fn();
const fetchScheduledEvent = vi.fn();
vi.mock('../discord-events.js', () => ({
  fetchScheduledEvents: (...args: unknown[]) => fetchScheduledEvents(...args),
  fetchScheduledEvent: (...args: unknown[]) => fetchScheduledEvent(...args),
}));

const { SqliteMemoryStore } = await import('../../../memory/store.js');
const { CALENDAR_MIGRATIONS, CalendarStore } = await import('../store.js');
const { CalendarAnnouncer } = await import('../announcer.js');

const BOT_ID = 'BOT';
const CHANNEL_ID = 'CH_ANUNCIOS';
const GUILD_ID = 'G1';
const EVENT_START = Date.UTC(2026, 7, 6, 2, 0, 0); // Aug 5, 8:00 PM CDMX
const NOW = Date.UTC(2026, 7, 5, 19, 0, 0); // 1:00 PM — past the 10:00 gate
const COVER = 'https://cdn.discordapp.com/guild-events/DE1/cover.png';

/** Captures the exact payload the announcer hands to Discord. */
class FakeChannel {
  guildId = GUILD_ID;
  sentPayloads: Array<{ content: string; files?: string[] }> = [];
  private seq = 100;

  isTextBased(): boolean {
    return true;
  }

  async send(payload: { content: string; files?: string[] }): Promise<{ id: string }> {
    this.sentPayloads.push(payload);
    return { id: String(++this.seq) };
  }

  get messages() {
    return {
      fetch: async () => new Map([['1', { id: '1', author: { id: BOT_ID }, delete: async () => {} }]]),
    };
  }
}

let memory: InstanceType<typeof SqliteMemoryStore>;
let store: InstanceType<typeof CalendarStore>;

function makeAnnouncer(channel: FakeChannel) {
  const client = {
    user: { id: BOT_ID },
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => ({ roles: { cache: new Map(), fetch: async () => new Map() }, members: {} }) },
  };
  return new CalendarAnnouncer({
    client: client as never,
    store,
    getAnnounceChannelId: () => CHANNEL_ID,
    getAnnounceMentions: () => ['ROLE_1'],
    getModRoles: () => [],
    getManagementChannelId: () => null,
    getAnnounceHour: () => 10,
    now: () => NOW,
  });
}

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  store.setAnnounceChannelId(CHANNEL_ID);
  const created = store.create({
    created_by: 'mod',
    title: 'Rosario Castellanos | Club de poesía',
    start_at: EVENT_START,
  });
  store.setDiscordEventId(created.id, 'DE1');
  fetchScheduledEvent.mockResolvedValue(null);
});

afterEach(() => {
  memory.close();
  vi.clearAllMocks();
});

function discordEvent(imageUrl: string | null) {
  return {
    id: 'DE1',
    name: 'Club de Poesía: Rosario Castellanos',
    description: null,
    startAtMs: EVENT_START,
    endAtMs: null,
    channelId: null,
    location: null,
    recurring: false,
    url: 'https://discord.com/events/G1/DE1',
    imageUrl,
  };
}

test('attaches the Discord event cover image when there is one', async () => {
  fetchScheduledEvents.mockResolvedValue([discordEvent(COVER)]);
  const channel = new FakeChannel();
  const report = await makeAnnouncer(channel).run();

  expect(channel.sentPayloads).toHaveLength(1);
  expect(channel.sentPayloads[0]!.files).toEqual([COVER]);
  expect(report.announced[0]!.imageUrl).toBe(COVER);
  // …and the event URL still rides in the text as before.
  expect(report.announced[0]!.text).toContain('https://discord.com/events/G1/DE1');
});

test('posts text-only when the Discord event has no banner', async () => {
  fetchScheduledEvents.mockResolvedValue([discordEvent(null)]);
  const channel = new FakeChannel();
  const report = await makeAnnouncer(channel).run();

  expect(channel.sentPayloads).toHaveLength(1);
  expect(channel.sentPayloads[0]!.files).toBeUndefined();
  expect(report.announced[0]!.imageUrl).toBeNull();
});
