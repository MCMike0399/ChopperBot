/**
 * The ticket-approval flow closes the loop WITH the flyer: when the requester
 * attached an image anywhere in the ticket, the Discord scheduled event the
 * watcher creates on approval carries it as its cover — before this, a mod had
 * to open the Discord event and upload the banner by hand (observed live on
 * the Calibán ticket, 2026-08-05).
 *
 * `ask` is mocked; the store/calendar run on a real in-memory SQLite; the
 * Discord side is a fake guild; the CDN download is a stubbed `fetch`.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from '../store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../../calendar/store.js';
import { EventIntakeWatcher } from '../watcher.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../../../llm/client.js', () => ({ ask: vi.fn() }));
const { ask } = await import('../../../llm/client.js');
const askMock = vi.mocked(ask);

const TICKET_BOT = '557628352828014614';
const BOT = '999999999999999999';
const CHANNEL = '1534429008786227390';
const GUILD = '1435843683541979248';
const MOD_ROLE = '1436055845392879778';
const REQUESTER = '341470607378219018';
const FLYER_URL = 'https://cdn.discordapp.com/attachments/1534429008786227390/1/Caliban_y_la_Bruja.png';

interface Sent {
  content: string;
  allowedMentions?: { roles?: string[]; parse?: string[]; repliedUser?: boolean };
}

/** The fake Discord side: records what the scheduled-event create received. */
function makeClientWithGuild() {
  const created: Array<Record<string, unknown>> = [];
  const guild = {
    members: {
      fetchMe: async () => ({ permissions: { has: () => true } }),
    },
    channels: { fetch: async () => new Map() }, // no venues → external event
    scheduledEvents: {
      create: async (payload: Record<string, unknown>) => {
        created.push(payload);
        return {
          id: 'DE1',
          name: payload.name,
          description: payload.description ?? null,
          scheduledStartTimestamp: new Date(payload.scheduledStartTime as Date).getTime(),
          scheduledEndTimestamp: payload.scheduledEndTime
            ? new Date(payload.scheduledEndTime as Date).getTime()
            : null,
          channelId: null,
          entityMetadata: payload.entityMetadata ?? null,
          recurrenceRule: null,
          status: 1,
          coverImageURL: () => null,
        };
      },
    },
  };
  const client = {
    user: { id: BOT },
    guilds: { fetch: async () => guild },
  };
  return { client, created };
}

function makeApprovalMessage(opts: { sent: Sent[]; history: unknown[] }): Message {
  const reply = vi.fn(async (payload: string | Sent) => {
    const norm = typeof payload === 'string' ? { content: payload } : payload;
    opts.sent.push(norm);
    return { id: 'posted-1', reply: vi.fn() } as unknown as Message;
  });
  return {
    id: 'msg-approval',
    channelId: CHANNEL,
    guildId: GUILD,
    author: { id: 'mod-1', bot: false, tag: 'mod' },
    content: `<@${BOT}> aprueba el evento`,
    embeds: [],
    attachments: new Map(),
    member: {
      roles: {
        cache: {
          map: <T>(fn: (r: { id: string; name: string }) => T) => [fn({ id: MOD_ROLE, name: 'mod' })],
        },
      },
      permissions: { has: () => false },
    },
    mentions: { users: { has: (id: string) => id === BOT }, repliedUser: null },
    reference: null,
    inGuild: () => true,
    react: vi.fn(async () => null),
    guild: {
      id: GUILD,
      members: { me: { id: BOT }, fetch: vi.fn() },
      roles: {
        cache: {
          size: 1,
          map: <T>(fn: (r: { id: string; name: string; mentionable: boolean }) => T) => [
            fn({ id: MOD_ROLE, name: '🚓Moderación🚓', mentionable: true }),
          ],
        },
        fetch: vi.fn(),
      },
    },
    channel: {
      isThread: () => false,
      isSendable: () => true,
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(),
      messages: { fetch: vi.fn(async () => new Map(opts.history.map((m, i) => [`h${i}`, m]))) },
      permissionsFor: () => ({ has: () => true }),
    },
    reply,
  } as unknown as Message;
}

/** The requester's flyer message, as it sits in the ticket's history. */
function flyerMessage() {
  return {
    author: { id: REQUESTER, bot: false },
    createdTimestamp: Date.parse('2026-08-05T05:14:00Z'),
    attachments: new Map([
      [
        'att1',
        {
          url: FLYER_URL,
          name: 'Caliban_y_la_Bruja.png',
          contentType: 'image/png',
          size: 123_456,
        },
      ],
    ]),
  };
}

async function newWatcher(client: unknown) {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  const ns = new NamespacedMemory(mem, 'event_intake');
  await ns.migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  await new NamespacedMemory(mem, 'calendar').migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.recordProposal({
    channelId: CHANNEL,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Calibán y la Bruja: Mujeres, cuerpo y acumulación originaria',
      dayRaw: '9 de Agosto',
      timeRaw: '8:00 pm',
      speaker: 'Abeja comunista y Luna',
      flyerSelf: true,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'posted-0',
  });
  const watcher = new EventIntakeWatcher({
    store,
    calendarStore: new CalendarStore(mem.db()),
    client: client as never,
    botUserId: BOT,
    ticketBotId: TICKET_BOT,
    getModRoles: () => store.getModRoles(),
    getAgitpropChannelId: () => null,
    getAgitpropRoles: () => [],
    now: () => Date.parse('2026-08-05T21:00:00Z'),
  });
  return { watcher, store, mem };
}

beforeEach(() => {
  askMock.mockReset();
  // The CDN download of the flyer: a tiny valid image response.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    })),
  );
  // The mod's approval turn: the model calls the real create tool.
  askMock.mockImplementation(async (input) => {
    await input?.tools?.handle('calendar_create_event', {
      title: 'Calibán y la Bruja: Mujeres, cuerpo y acumulación originaria',
      start_at_iso: '2026-08-10T02:00:00Z',
    });
    return 'Listo, quedó agendado el domingo 9 de agosto a las 8:00 PM.';
  });
});

afterEach(() => vi.unstubAllGlobals());

test('approval creates the Discord event WITH the ticket flyer as its cover', async () => {
  const { client, created } = makeClientWithGuild();
  const { watcher, mem } = await newWatcher(client);
  const sent: Sent[] = [];

  await watcher.handleMessage(makeApprovalMessage({ sent, history: [flyerMessage()] }));

  expect(created).toHaveLength(1);
  expect((created[0]!.image as string).startsWith('data:image/png;base64,')).toBe(true);
  expect(sent[0].content).toContain('evento de Discord');
  expect(sent[0].content).toContain('portada');
  expect(sent[0].content).toContain(`https://discord.com/events/${GUILD}/DE1`);
  mem.close();
});

test('approval without a flyer in the ticket creates a plain event', async () => {
  const { client, created } = makeClientWithGuild();
  const { watcher, mem } = await newWatcher(client);
  const sent: Sent[] = [];

  await watcher.handleMessage(makeApprovalMessage({ sent, history: [] }));

  expect(created).toHaveLength(1);
  expect(created[0]!.image).toBeUndefined();
  expect(sent[0].content).toContain('evento de Discord');
  expect(sent[0].content).not.toContain('portada');
  mem.close();
});

test('the bot\'s own and the ticket bot\'s images are never picked as the flyer', async () => {
  const { client, created } = makeClientWithGuild();
  const { watcher, mem } = await newWatcher(client);
  const sent: Sent[] = [];
  const botImage = {
    author: { id: TICKET_BOT, bot: true },
    createdTimestamp: Date.parse('2026-08-05T05:15:00Z'),
    attachments: new Map([
      ['a', { url: FLYER_URL, name: 'x.png', contentType: 'image/png', size: 10 }],
    ]),
  };

  await watcher.handleMessage(makeApprovalMessage({ sent, history: [botImage] }));

  expect(created).toHaveLength(1);
  expect(created[0]!.image).toBeUndefined();
  mem.close();
});
