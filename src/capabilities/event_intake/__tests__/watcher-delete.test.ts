/**
 * Cancelling/deleting from inside a ticket (v1.20.0). The ticket used to answer
 * *"eso no se hace desde el ticket: las cancelaciones se gestionan en el canal de
 * gestión del calendario"* — the mod who may approve here may now also cancel
 * here. What's asserted: the write bundle is mod-gated exactly like create/update,
 * a whole-series delete of the ticket's OWN event un-approves the ticket row, and
 * deleting some other event (or only one occurrence) leaves the row alone.
 *
 * `ask` is mocked and drives the REAL calendar tool handlers against an in-memory
 * store; the Discord syncer is a fake via the makeEventSyncer seam.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from '../store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../../calendar/store.js';
import { EventIntakeWatcher } from '../watcher.js';
import type { DiscordEventSyncer } from '../../calendar/discord-events.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../../../llm/client.js', () => ({ ask: vi.fn() }));
const { ask } = await import('../../../llm/client.js');
const askMock = vi.mocked(ask);

const TICKET_BOT = '557628352828014614';
const BOT = '999999999999999999';
const CHANNEL = '1537711320307077182';
const GUILD = '1435843683541979248';
const MOD_ROLE = '1436055845392879778';
const REQUESTER = '187289179871248384';
const START = Date.parse('2026-08-19T02:00:00Z'); // Aug 18, 8:00 PM CDMX

interface Sent {
  content: string;
  allowedMentions?: { roles?: string[]; parse?: string[]; repliedUser?: boolean };
}

const removeMock = vi.fn();
const fakeSyncer: DiscordEventSyncer = {
  sync: vi.fn(async () => ({ ok: true, discordEventId: 'DE9', url: 'u', created: true }) as never),
  refresh: vi.fn(async () => ({ ok: true, action: 'not_linked' }) as never),
  remove: removeMock,
};

function makeMessage(opts: { content: string; memberRoles: string[]; sent: Sent[] }): Message {
  const reply = vi.fn(async (payload: string | Sent) => {
    opts.sent.push(typeof payload === 'string' ? { content: payload } : payload);
    return { id: 'posted-1', reply: vi.fn() } as unknown as Message;
  });
  return {
    id: 'msg-1',
    channelId: CHANNEL,
    guildId: GUILD,
    author: { id: 'mod-1', bot: false, tag: 'mod#0001' },
    content: opts.content,
    embeds: [],
    member: {
      roles: {
        cache: {
          map: <T>(fn: (r: { id: string; name: string }) => T) =>
            opts.memberRoles.map((id) => fn({ id, name: id })),
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
          map: <T>(fn: (r: { id: string; name: string; mentionable: boolean }) => T) =>
            [fn({ id: MOD_ROLE, name: '🚓Moderación🚓', mentionable: true })],
        },
        fetch: vi.fn(),
      },
    },
    channel: {
      isThread: () => false,
      isSendable: () => true,
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(),
      messages: { fetch: vi.fn(async () => new Map()) },
      permissionsFor: () => ({
        has: (flag: bigint) => (flag === PermissionFlagsBits.MentionEveryone ? false : true),
      }),
    },
    reply,
  } as unknown as Message;
}

async function newWatcher() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  await new NamespacedMemory(mem, 'calendar').migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  const calendarStore = new CalendarStore(mem.db());
  const watcher = new EventIntakeWatcher({
    store,
    calendarStore,
    client: { user: { id: BOT } } as never,
    botUserId: BOT,
    ticketBotId: TICKET_BOT,
    getModRoles: () => [MOD_ROLE],
    getAgitpropChannelId: () => null,
    getAgitpropRoles: () => [],
    makeEventSyncer: () => fakeSyncer,
    now: () => Date.parse('2026-08-14T18:00:00Z'),
  });
  return { watcher, store, calendarStore, mem };
}

/** Seed the ticket row + the calendar event this ticket approved. */
function seedApprovedEvent(
  store: EventIntakeStore,
  calendarStore: InstanceType<typeof CalendarStore>,
  opts: { weekly?: boolean } = {},
) {
  store.recordProposal({
    channelId: CHANNEL,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Conversatorio: DataCenters',
      dayRaw: 'martes 18 de agosto',
      timeRaw: '8pm',
      speaker: 'Burbuja',
      flyerSelf: false,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'posted-1',
  });
  const event = calendarStore.create({
    created_by: 'mod-1',
    title: 'Conversatorio: DataCenters',
    start_at: START,
    ...(opts.weekly ? { recurrence_freq: 'weekly' as const } : {}),
  });
  calendarStore.setDiscordEventId(event.id, 'DE1');
  store.markCreated(CHANNEL, event.id);
  return event;
}

beforeEach(() => {
  askMock.mockReset();
  removeMock.mockReset().mockResolvedValue({ ok: true, action: 'deleted' });
});

describe('ticket cancel/delete', () => {
  test('a mod gets the delete + publish tools; a non-mod gets neither', async () => {
    const { watcher, store, calendarStore, mem } = await newWatcher();
    seedApprovedEvent(store, calendarStore);

    let modTools: string[] = [];
    askMock.mockImplementation(async (input) => {
      modTools = (input?.tools?.tools ?? []).map((t) => t.name);
      return 'Va.';
    });
    const sent: Sent[] = [];
    await watcher.handleMessage(makeMessage({ content: `<@${BOT}> hola`, memberRoles: [MOD_ROLE], sent }));
    expect(modTools).toContain('calendar_delete_event');
    expect(modTools).toContain('calendar_publish');

    let nonModTools: string[] = [];
    askMock.mockImplementation(async (input) => {
      nonModTools = (input?.tools?.tools ?? []).map((t) => t.name);
      return 'Va.';
    });
    const msg = makeMessage({ content: `<@${BOT}> cancélalo`, memberRoles: [], sent });
    (msg as { author: { id: string } }).author.id = REQUESTER;
    await watcher.handleMessage(msg);
    expect(nonModTools).not.toContain('calendar_delete_event');
    expect(nonModTools).not.toContain('calendar_publish');
    expect(nonModTools).toContain('calendar_search_events');
    mem.close();
  });

  test('a non-mod calling delete anyway is refused server-side (allowWrite:false)', async () => {
    const { watcher, store, calendarStore, mem } = await newWatcher();
    const event = seedApprovedEvent(store, calendarStore);
    let result: { status: string } | undefined;
    askMock.mockImplementation(async (input) => {
      result = await input?.tools?.handle('calendar_delete_event', { id: event.id });
      return 'Nel.';
    });
    const sent: Sent[] = [];
    const msg = makeMessage({ content: `<@${BOT}> bórralo`, memberRoles: [], sent });
    (msg as { author: { id: string } }).author.id = REQUESTER;
    await watcher.handleMessage(msg);
    expect(result?.status).toBe('error');
    expect(calendarStore.get(event.id)).toBeTruthy(); // still there
    mem.close();
  });

  test("a mod deleting the ticket's OWN series removes it, kills the Discord event, and un-approves the row", async () => {
    const { watcher, store, calendarStore, mem } = await newWatcher();
    const event = seedApprovedEvent(store, calendarStore);
    askMock.mockImplementation(async (input) => {
      await input?.tools?.handle('calendar_delete_event', { id: event.id });
      return 'Listo, cancelé el conversatorio.';
    });
    const sent: Sent[] = [];
    await watcher.handleMessage(
      makeMessage({ content: `<@${BOT}> cancélalo, ya no se hace`, memberRoles: [MOD_ROLE], sent }),
    );
    expect(calendarStore.get(event.id)).toBeNull();
    expect(removeMock).toHaveBeenCalledWith(event.id);
    const row = store.getTicket(CHANNEL);
    expect(row?.status).toBe('cancelled');
    expect(row?.created_event_id).toBeNull();
    mem.close();
  });

  test('cancelling ONE occurrence keeps the series and leaves the ticket row approved', async () => {
    const { watcher, store, calendarStore, mem } = await newWatcher();
    const event = seedApprovedEvent(store, calendarStore, { weekly: true });
    let payload: Record<string, unknown> | undefined;
    askMock.mockImplementation(async (input) => {
      const res = await input?.tools?.handle('calendar_delete_event', {
        id: event.id,
        scope: 'occurrence',
        occurrence_date_iso: '2026-08-18',
      });
      payload = res?.payload as Record<string, unknown>;
      return 'Va, solo esa semana.';
    });
    const sent: Sent[] = [];
    await watcher.handleMessage(
      makeMessage({ content: `<@${BOT}> esta semana no hay`, memberRoles: [MOD_ROLE], sent }),
    );
    expect(payload?.deleted_scope).toBe('occurrence');
    expect(calendarStore.get(event.id)).toBeTruthy();
    const row = store.getTicket(CHANNEL);
    expect(row?.status).toBe('created');
    expect(row?.created_event_id).toBe(event.id);
    mem.close();
  });

  test("deleting some OTHER event never touches this ticket's row", async () => {
    const { watcher, store, calendarStore, mem } = await newWatcher();
    const own = seedApprovedEvent(store, calendarStore);
    const other = calendarStore.create({ created_by: 'mod-1', title: 'Otro evento', start_at: START });
    askMock.mockImplementation(async (input) => {
      await input?.tools?.handle('calendar_delete_event', { id: other.id });
      return 'Listo.';
    });
    const sent: Sent[] = [];
    await watcher.handleMessage(
      makeMessage({ content: `<@${BOT}> borra el otro`, memberRoles: [MOD_ROLE], sent }),
    );
    expect(calendarStore.get(other.id)).toBeNull();
    const row = store.getTicket(CHANNEL);
    expect(row?.status).toBe('created');
    expect(row?.created_event_id).toBe(own.id);
    mem.close();
  });
});
