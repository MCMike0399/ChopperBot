import { Collection, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GESTION_ROLE_ID } from '../../../discord/mod-roles.js';
import { CONFIGURATION_CHANNEL_ID } from '../../configuration/constants.js';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CALENDAR_MIGRATIONS, CalendarStore } from '../store.js';
import { CalendarAnnouncer } from '../announcer.js';

vi.mock('../../../llm/client.js', () => ({ ask: vi.fn() }));
const { fetchScheduledEvents } = vi.hoisted(() => ({ fetchScheduledEvents: vi.fn() }));
vi.mock('../discord-events.js', () => ({ fetchScheduledEvents, fetchScheduledEvent: vi.fn() }));

const MOD = '1436055845392879778';
const SILENT_ADMIN = '1483734077944365149';
const NOW = Date.UTC(2026, 9, 7, 19); // Oct 7, 13:00 CDMX
const START = Date.UTC(2026, 9, 9, 2); // Oct 8, 20:00 CDMX
let memory: SqliteMemoryStore;
let store: CalendarStore;

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  const event = store.create({ created_by: 'mod', title: 'Club de poesía', start_at: START });
  store.setDiscordEventId(event.id, 'DE1');
  fetchScheduledEvents.mockResolvedValue([{
    id: 'DE1', name: event.title, description: null, startAtMs: START,
    endAtMs: null, channelId: null, location: null, recurring: false,
    url: 'https://discord.com/events/G1/DE1', imageUrl: null,
  }]);
});
afterEach(() => { memory.close(); vi.clearAllMocks(); });

function setup(opts: { canMention?: boolean; roleMentionable?: boolean; failManagement?: boolean; fallbackCanMention?: boolean; failPermissions?: boolean } = {}) {
  const send = vi.fn().mockResolvedValue({ id: 'MSG' });
  const fallbackSend = vi.fn().mockResolvedValue({ id: 'FALLBACK' });
  if (opts.failManagement) send.mockRejectedValue(new Error('send failed'));
  const roles = new Collection([
    [MOD, { id: MOD, name: 'Moderación', mentionable: true }],
    [GESTION_ROLE_ID, { id: GESTION_ROLE_ID, name: 'COMISIÓN | GESTIÓN', mentionable: opts.roleMentionable ?? false }],
    [SILENT_ADMIN, { id: SILENT_ADMIN, name: 'Administradora', mentionable: false }],
  ]);
  const management = {
    guildId: 'G1', isTextBased: () => true, send,
    permissionsFor: vi.fn(() => ({ has: (permission: bigint) => permission === PermissionFlagsBits.MentionEveryone && (opts.canMention ?? true) })),
  };
  const fallback = {
    ...management, type: 0, send: fallbackSend,
    permissionsFor: () => ({ has: () => opts.fallbackCanMention ?? false }),
  };
  const fetchMe = vi.fn().mockResolvedValue({ id: 'BOT' });
  if (opts.failPermissions) fetchMe.mockRejectedValue(new Error('member unavailable'));
  const client = {
    channels: { fetch: vi.fn(async (id: string) => id === CONFIGURATION_CHANNEL_ID ? fallback : management) },
    guilds: { fetch: async () => ({ roles: { cache: roles }, members: { fetchMe } }) },
  };
  const announcer = new CalendarAnnouncer({
    client: client as never, store, now: () => NOW,
    getAnnounceChannelId: () => 'ANNOUNCE', getAnnounceMentions: () => [],
    // Gestión must be included even when a custom approver list omits it.
    getModRoles: () => [MOD, SILENT_ADMIN], getManagementChannelId: () => 'MANAGEMENT',
    getAnnounceHour: () => 10,
  });
  return { announcer, send, fallbackSend };
}

describe('missing-cover reminders notify Gestión', () => {
  test('pings Gestión and mentionable staff once, without pinging other silent staff', async () => {
    const { announcer, send } = setup();
    const report = await announcer.run();
    expect(report.bannerReminded).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining(`<@&${GESTION_ROLE_ID}>`),
      allowedMentions: { parse: [], roles: [MOD, GESTION_ROLE_ID] },
    });
    await announcer.run();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test.each([{ canMention: false }, { failPermissions: true }])('keeps Gestión silent without verified channel permission: %j', async (opts) => {
    const { announcer, send } = setup(opts);
    await announcer.run();
    expect(send.mock.calls[0]![0].allowedMentions).toEqual({ parse: [], roles: [MOD] });
    expect(send.mock.calls[0]![0].content).not.toContain(`<@&${GESTION_ROLE_ID}>`);
  });

  test('pings mentionable Gestión without MentionEveryone', async () => {
    const { announcer, send } = setup({ canMention: false, roleMentionable: true });
    await announcer.run();
    expect(send.mock.calls[0]![0].allowedMentions.roles).toEqual([MOD, GESTION_ROLE_ID]);
  });

  test('checks permissions again for the config-channel fallback', async () => {
    const { announcer, fallbackSend } = setup({ failManagement: true });
    await announcer.run();
    expect(fallbackSend.mock.calls[0]![0].allowedMentions.roles).toEqual([MOD]);
    expect(fallbackSend.mock.calls[0]![0].content).not.toContain(`<@&${GESTION_ROLE_ID}>`);
  });

  test('missing-event nudges keep their existing mention policy', async () => {
    store.setDiscordEventId(1, null);
    fetchScheduledEvents.mockResolvedValue([]);
    const { announcer, send } = setup();
    const report = await announcer.run();
    expect(report.nudged).toHaveLength(1);
    expect(send.mock.calls[0]![0].allowedMentions.roles).toEqual([MOD]);
    expect(send.mock.calls[0]![0].content).not.toContain(`<@&${GESTION_ROLE_ID}>`);
  });
});
