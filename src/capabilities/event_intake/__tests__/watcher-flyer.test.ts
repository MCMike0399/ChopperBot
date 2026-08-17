/**
 * Agitprop flyer subsystem (v1.23.0): auto-open on flyerSelf=false, image-reply
 * fulfill, mirror to ticket, stored pointer for Discord cover. `ask` is mocked;
 * store/calendar on real in-memory SQLite; Discord is faked.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from '../store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../../calendar/store.js';
import { EventIntakeWatcher } from '../watcher.js';
import { parseTicketForm } from '../parse.js';
import type { DiscordEventSyncer } from '../../calendar/discord-events.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../../../llm/client.js', () => ({ ask: vi.fn() }));
const { ask } = await import('../../../llm/client.js');
const askMock = vi.mocked(ask);

const TICKET_BOT = '557628352828014614';
const BOT = '999999999999999999';
const TICKET = '1534429008786227390';
const AGITPROP = '1483639272413200606';
const GUILD = '1435843683541979248';
const MOD_ROLE = '1436055845392879778';
const AGITPROP_ROLE = '1517610228969902131';
const REQUESTER = '341470607378219018';
const FLYER_URL = 'https://cdn.discordapp.com/attachments/1/2/flyer.png';

const FORM_NO_FLYER = {
  description: [
    '**¿Cuál es el título o tema del evento?** ```',
    'Charla Z```',
    '**¿Qué día?** ```',
    'sábado```',
    '**¿A qué hora?** ```',
    '7pm```',
    '**¿Quién es el/la ponente?** ```',
    'Ana```',
    '**¿Harás tú el flyer?** ```',
    'no```',
  ].join('\n'),
  fields: [],
};

const FORM_SELF_FLYER = {
  description: [
    '**¿Cuál es el título o tema del evento?** ```',
    'Charla Z```',
    '**¿Qué día?** ```',
    'sábado```',
    '**¿A qué hora?** ```',
    '7pm```',
    '**¿Quién es el/la ponente?** ```',
    'Ana```',
    '**¿Harás tú el flyer?** ```',
    'sí```',
  ].join('\n'),
  fields: [],
};

interface Sent {
  content: string;
  files?: unknown[];
  allowedMentions?: { roles?: string[]; parse?: string[] };
}

function makeAgitpropChannel(sent: Sent[], cardEdits: Sent[]) {
  let cardSeq = 1;
  return {
    isTextBased: () => true,
    isDMBased: () => false,
    guild: {
      id: GUILD,
      members: { me: { id: BOT } },
      roles: {
        cache: {
          size: 2,
          map: <T>(fn: (r: { id: string; name: string; mentionable: boolean }) => T) =>
            [
              fn({ id: AGITPROP_ROLE, name: 'Agitprop', mentionable: true }),
              fn({ id: MOD_ROLE, name: 'Moderación', mentionable: true }),
            ],
        },
      },
    },
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async (payload: Sent) => {
      sent.push(payload);
      const id = `card-${cardSeq}`;
      cardSeq += 1;
      return { id };
    }),
    messages: {
      fetch: vi.fn(async (id: string) => ({
        id,
        edit: vi.fn(async (payload: Sent) => {
          cardEdits.push(payload);
        }),
        attachments: new Map([
          [
            'att1',
            { url: FLYER_URL, name: 'flyer.png', contentType: 'image/png', size: 100 },
          ],
        ]),
      })),
    },
  };
}

function makeTicketChannel(sent: Sent[], history: unknown[] = []) {
  return {
    isTextBased: () => true,
    isDMBased: () => false,
    isThread: () => false,
    isSendable: () => true,
    sendTyping: vi.fn(async () => {}),
    send: vi.fn(async (payload: Sent) => {
      sent.push(payload);
      return { id: `ticket-${sent.length}`, reply: vi.fn() };
    }),
    messages: {
      fetch: vi.fn(async () => new Map(history.map((m, i) => [`h${i}`, m]))),
    },
    permissionsFor: () => ({ has: () => true }),
  };
}

function makeClient(opts: {
  agitpropSent: Sent[];
  cardEdits: Sent[];
  ticketSent: Sent[];
  ticketHistory?: unknown[];
}) {
  const agitprop = makeAgitpropChannel(opts.agitpropSent, opts.cardEdits);
  const ticket = makeTicketChannel(opts.ticketSent, opts.ticketHistory);
  return {
    user: { id: BOT },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === AGITPROP) return agitprop;
        if (id === TICKET) return ticket;
        return ticket;
      }),
    },
  };
}

function formMessage(embed: unknown): Message {
  const ticketSent: Sent[] = [];
  return {
    id: 'form-1',
    channelId: TICKET,
    guildId: GUILD,
    author: { id: TICKET_BOT, bot: true },
    content: `<@${REQUESTER}>`,
    embeds: [embed],
    attachments: new Map(),
    member: null,
    mentions: { users: { has: () => false }, repliedUser: null },
    reference: null,
    inGuild: () => true,
    guild: {
      id: GUILD,
      members: { me: { id: BOT }, fetch: vi.fn() },
      roles: {
        cache: {
          size: 2,
          map: <T>(fn: (r: { id: string; name: string; mentionable: boolean }) => T) =>
            [
              fn({ id: AGITPROP_ROLE, name: 'Agitprop', mentionable: true }),
              fn({ id: MOD_ROLE, name: 'Moderación', mentionable: true }),
            ],
        },
        fetch: vi.fn(),
      },
    },
    channel: makeTicketChannel(ticketSent),
    reply: vi.fn(async (payload: Sent) => {
      ticketSent.push(payload);
      return { id: 'prop-1', reply: vi.fn() } as unknown as Message;
    }),
  } as unknown as Message;
}

function imageReplyMessage(opts: {
  channelId: string;
  refId: string;
  authorId: string;
  isAgitprop?: boolean;
  isMod?: boolean;
  sent: Sent[];
}): Message {
  const roles: Array<{ id: string; name: string }> = [];
  if (opts.isAgitprop) roles.push({ id: AGITPROP_ROLE, name: 'Agitprop' });
  if (opts.isMod) roles.push({ id: MOD_ROLE, name: 'Moderación' });
  const channel =
    opts.channelId === AGITPROP
      ? makeAgitpropChannel(opts.sent, [])
      : makeTicketChannel(opts.sent);
  return {
    id: 'img-reply',
    channelId: opts.channelId,
    guildId: GUILD,
    author: { id: opts.authorId, bot: false },
    content: '',
    embeds: [],
    attachments: new Map([
      ['a', { url: FLYER_URL, name: 'flyer.png', contentType: 'image/png', size: 100 }],
    ]),
    member: {
      roles: {
        cache: {
          map: <T>(fn: (r: { id: string; name: string }) => T) => roles.map(fn),
        },
      },
      permissions: { has: () => false },
    },
    mentions: { users: { has: () => false }, repliedUser: null },
    reference: { messageId: opts.refId },
    inGuild: () => true,
    guild: {
      id: GUILD,
      members: { me: { id: BOT }, fetch: vi.fn() },
      roles: {
        cache: {
          size: 2,
          map: <T>(fn: (r: { id: string; name: string; mentionable: boolean }) => T) =>
            [
              fn({ id: AGITPROP_ROLE, name: 'Agitprop', mentionable: true }),
              fn({ id: MOD_ROLE, name: 'Moderación', mentionable: true }),
            ],
        },
      },
    },
    channel,
    reply: vi.fn(),
  } as unknown as Message;
}

async function newWatcher(client: unknown, store: EventIntakeStore, calendarStore: CalendarStore) {
  return new EventIntakeWatcher({
    store,
    calendarStore,
    client: client as never,
    botUserId: BOT,
    ticketBotId: TICKET_BOT,
    getModRoles: () => [MOD_ROLE],
    getAgitpropChannelId: () => AGITPROP,
    getAgitpropRoles: () => ['Agitprop'],
    now: () => Date.parse('2026-08-05T21:00:00Z'),
  });
}

beforeEach(() => {
  askMock.mockReset();
  askMock.mockResolvedValue('Propuesta de prueba para mods.');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

test('ticket form with flyer=no parses flyerSelf false', () => {
  const parsed = parseTicketForm({
    authorId: TICKET_BOT,
    authorBot: true,
    content: '',
    embeds: [FORM_NO_FLYER],
  });
  expect(parsed?.flyerSelf).toBe(false);
});

test('flyerSelf=false opens Agitprop card and ticket notice; flyerSelf=true does not', async () => {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  await new NamespacedMemory(mem, 'calendar').migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.setAgitpropChannelId(AGITPROP);

  const agitpropSent: Sent[] = [];
  const cardEdits: Sent[] = [];
  const ticketSent: Sent[] = [];
  const client = makeClient({ agitpropSent, cardEdits, ticketSent });
  const watcher = await newWatcher(client, store, new CalendarStore(mem.db()));

  await watcher.handleMessage(formMessage(FORM_NO_FLYER) as never);
  const row = store.getTicket(TICKET);
  expect(row).toBeTruthy();
  expect(row!.flyer_status).toBe('requested');
  expect(agitpropSent.some((s) => s.content.includes('Solicitud de flyer'))).toBe(true);
  expect(ticketSent.some((s) => s.content.includes('Agitprop'))).toBe(true);

  // Second ticket — requester makes their own flyer → no Agitprop job.
  const ticket2 = '1534429008786227391';
  store.setAgitpropChannelId(AGITPROP);
  const msg2 = formMessage(FORM_SELF_FLYER) as Message & { channelId: string };
  Object.assign(msg2, { channelId: ticket2, id: 'form-2' });
  (msg2.channel as { send: ReturnType<typeof vi.fn> }).send = vi.fn(async (p: Sent) => {
    ticketSent.push(p);
    return { id: 'p2', reply: vi.fn() };
  });
  askMock.mockResolvedValueOnce('Propuesta sin Agitprop.');
  const before = agitpropSent.length;
  await watcher.handleMessage(msg2 as never);
  expect(agitpropSent.length).toBe(before);
  mem.close();
});

test('image reply in Agitprop fulfills job and mirrors to ticket', async () => {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  await new NamespacedMemory(mem, 'calendar').migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.setAgitpropChannelId(AGITPROP);
  store.recordProposal({
    channelId: TICKET,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Charla Z',
      dayRaw: 'sábado',
      timeRaw: '7pm',
      speaker: 'Ana',
      flyerSelf: false,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'prop-1',
  });
  store.markFlyerRequested(TICKET, 'card-1', null);

  const agitpropSent: Sent[] = [];
  const cardEdits: Sent[] = [];
  const ticketSent: Sent[] = [];
  const client = makeClient({ agitpropSent, cardEdits, ticketSent });
  const watcher = await newWatcher(client, store, new CalendarStore(mem.db()));

  const fulfillSent: Sent[] = [];
  await watcher.handleMessage(
    imageReplyMessage({
      channelId: AGITPROP,
      refId: 'card-1',
      authorId: 'agitprop-user',
      isAgitprop: true,
      sent: fulfillSent,
    }) as never,
  );

  const row = store.getTicket(TICKET)!;
  expect(row.flyer_status).toBe('delivered');
  expect(row.flyer_image_message_id).toBe('img-reply');
  expect(
    ticketSent.some(
      (s) =>
        s.content.includes('Flyer del evento') ||
        s.content.includes('Flyer listo'),
    ),
  ).toBe(true);
  expect(cardEdits.some((s) => s.content.includes('Flyer entregado'))).toBe(true);
  mem.close();
});

test('non-Agitprop image reply in Agitprop channel is ignored', async () => {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.recordProposal({
    channelId: TICKET,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Charla Z',
      dayRaw: 'sábado',
      timeRaw: '7pm',
      speaker: 'Ana',
      flyerSelf: false,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'prop-1',
  });
  store.markFlyerRequested(TICKET, 'card-1', null);

  const agitpropSent: Sent[] = [];
  const cardEdits: Sent[] = [];
  const ticketSent: Sent[] = [];
  const client = makeClient({ agitpropSent, cardEdits, ticketSent });
  const watcher = await newWatcher(client, store, new CalendarStore(mem.db()));

  await watcher.handleMessage(
    imageReplyMessage({
      channelId: AGITPROP,
      refId: 'card-1',
      authorId: 'random-user',
      sent: [],
    }) as never,
  );

  expect(store.getTicket(TICKET)!.flyer_status).toBe('requested');
  mem.close();
});

test('approval uses stored flyer pointer instead of findLatestTicketImage', async () => {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  await new NamespacedMemory(mem, 'calendar').migrate('calendar', CALENDAR_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  const calendarStore = new CalendarStore(mem.db());
  store.recordProposal({
    channelId: TICKET,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Charla Z',
      dayRaw: 'sábado',
      timeRaw: '7pm',
      speaker: 'Ana',
      flyerSelf: false,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'prop-1',
  });
  store.markFlyerDelivered(TICKET, AGITPROP, 'flyer-msg-1');

  const syncMock = vi.fn(async () => ({
    ok: true,
    discordEventId: 'DE1',
    url: 'https://discord.com/events/x/DE1',
    created: true,
    imageSet: true,
  }));
  const fakeSyncer: DiscordEventSyncer = {
    sync: syncMock,
    refresh: vi.fn(),
    remove: vi.fn(),
  };

  askMock.mockImplementation(async (input) => {
    await input?.tools?.handle('calendar_create_event', {
      title: 'Charla Z',
      start_at_iso: '2026-08-10T01:00:00Z',
    });
    return 'Listo, quedó agendado.';
  });

  const sent: Sent[] = [];
  const reply = vi.fn(async (payload: Sent) => {
    sent.push(payload);
    return { id: 'posted-1', reply: vi.fn() } as unknown as Message;
  });
  const msg = {
    id: 'approval',
    channelId: TICKET,
    guildId: GUILD,
    author: { id: 'mod-1', bot: false },
    content: `<@${BOT}> aprueba`,
    embeds: [],
    attachments: new Map(),
    member: {
      roles: { cache: { map: <T>(fn: (r: { id: string; name: string }) => T) => [fn({ id: MOD_ROLE, name: 'mod' })] } },
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
            [fn({ id: MOD_ROLE, name: 'Moderación', mentionable: true })],
        },
      },
    },
    channel: {
      ...makeTicketChannel(sent, []),
      messages: {
        fetch: vi.fn(async () => new Map()), // no human images in history
      },
    },
    reply,
  } as unknown as Message;

  const client = {
    user: { id: BOT },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === AGITPROP) {
          return {
            isTextBased: () => true,
            isDMBased: () => false,
            messages: {
              fetch: vi.fn(async () => ({
                attachments: new Map([
                  ['a', { url: FLYER_URL, name: 'flyer.png', contentType: 'image/png', size: 100 }],
                ]),
              })),
            },
          };
        }
        return msg.channel;
      }),
    },
  };

  const watcher = new EventIntakeWatcher({
    store,
    calendarStore,
    client: client as never,
    botUserId: BOT,
    ticketBotId: TICKET_BOT,
    getModRoles: () => [MOD_ROLE],
    getAgitpropChannelId: () => AGITPROP,
    getAgitpropRoles: () => ['Agitprop'],
    makeEventSyncer: () => fakeSyncer,
    now: () => Date.parse('2026-08-05T21:00:00Z'),
  });

  await watcher.handleMessage(msg as never);
  expect(syncMock).toHaveBeenCalled();
  expect((syncMock.mock.calls[0]![1] as { imageUrl?: string }).imageUrl).toBe(FLYER_URL);
  mem.close();
});

test('Agitprop author does not get calendar_create_event in Agitprop channel', async () => {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.recordProposal({
    channelId: TICKET,
    guildId: GUILD,
    requesterId: REQUESTER,
    parsedForm: {
      title: 'Charla Z',
      dayRaw: 'sábado',
      timeRaw: '7pm',
      speaker: 'Ana',
      flyerSelf: false,
      pairs: [],
    },
    resolvedStartAt: null,
    proposalMessageId: 'prop-1',
  });
  store.markFlyerRequested(TICKET, 'card-1', null);

  askMock.mockImplementation(async (input) => {
    const names = input?.tools?.tools().map((t) => t.name) ?? [];
    expect(names).not.toContain('calendar_create_event');
    expect(names).toContain('flyer_cancel');
    return 'Ok.';
  });

  const agitpropSent: Sent[] = [];
  const cardEdits: Sent[] = [];
  const ticketSent: Sent[] = [];
  const client = makeClient({ agitpropSent, cardEdits, ticketSent });
  const watcher = await newWatcher(client, store, new CalendarStore(mem.db()));

  const msg = {
    id: 'conv-1',
    channelId: AGITPROP,
    guildId: GUILD,
    author: { id: 'agitprop-user', bot: false },
    content: `<@${BOT}> cancela el flyer`,
    embeds: [],
    attachments: new Map(),
    member: {
      roles: {
        cache: {
          map: <T>(fn: (r: { id: string; name: string }) => T) =>
            [fn({ id: AGITPROP_ROLE, name: 'Agitprop' })],
        },
      },
      permissions: { has: () => false },
    },
    mentions: { users: { has: (id: string) => id === BOT }, repliedUser: null },
    reference: { messageId: 'card-1' },
    inGuild: () => true,
    channel: makeAgitpropChannel(agitpropSent, cardEdits),
    reply: vi.fn(async () => ({ id: 'r1' })),
  } as unknown as Message;

  await watcher.handleMessage(msg as never);
  mem.close();
});
