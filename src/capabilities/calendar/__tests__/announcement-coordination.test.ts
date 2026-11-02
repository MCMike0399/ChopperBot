import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import { CalendarAnnouncer } from '../announcer.js';
import { announceKey } from '../announce.js';

vi.mock('../../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { askMock, fetchEvents, fetchEvent } = vi.hoisted(() => ({ askMock: vi.fn(), fetchEvents: vi.fn(), fetchEvent: vi.fn() }));
vi.mock('../../../llm/client.js', () => ({ ask: askMock }));
vi.mock('../discord-events.js', () => ({ fetchScheduledEvents: fetchEvents, fetchScheduledEvent: fetchEvent }));

const NOW = Date.parse('2026-10-28T10:33:00-06:00');
const START = Date.parse('2026-10-28T20:00:00-06:00');
const CHANNEL = '200000000000000001';
const GOOD = 'Hoy tenemos el círculo de lectura especial de historias de terror, a las 8 PM en Sala de Lectura. Caiganle, lxs tqm.';
let memory: SqliteMemoryStore;
let store: CalendarStore;
let id: number;
let clock: number;
let sent: Array<{ id: string; content: string; author: { id: string }; delete: () => Promise<void> }>;
let client: any;
let channel: any;
let beforeSend: (() => Promise<void>) | undefined;
let writer: ReturnType<typeof vi.fn>;
let deletedReceipts: Set<string>;
let nextMessageId: number;

function source(now = clock, requestText = 'anuncia el evento') {
  return new CalendarToolSource(store, 'moderator', now, undefined, {
    broadcaster: {
      resolve: async () => [{ query: 'anuncios', reason: 'ok', match: { id: CHANNEL, name: 'anuncios', kind: 'text' }, candidates: [] }],
      post: async ({ content }) => { const m = await channel.send({ content }); return { ok: true, messageId: m.id }; },
      ...{ checkReceipt: async (_target: unknown, messageId: string) => deletedReceipts.has(messageId) ? 'deleted' as const : 'present' as const },
    },
    writeAnnouncement: writer,
    announcementRequestText: requestText,
    sourceChannelId: 'MANAGEMENT',
  });
}
function announcer() {
  return new CalendarAnnouncer({ client, store, getAnnounceChannelId: () => CHANNEL, getAnnounceMentions: () => [],
    getModRoles: () => [], getManagementChannelId: () => null, getAnnounceHour: () => 10, now: () => clock });
}
async function manual(instruction?: string) {
  return source().handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'], publish_now: true, ...(instruction ? { instruction } : {}) });
}

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  store.setAnnounceChannelId(CHANNEL);
  id = store.create({ created_by: 'moderator', title: 'Círculo de lectura: Especial historias de terror', start_at: START, location: 'Sala de Lectura' }).id;
  store.setDiscordEventId(id, 'EVENT');
  clock = NOW;
  sent = [];
  deletedReceipts = new Set();
  nextMessageId = 100;
  beforeSend = undefined;
  channel = { guildId: 'GUILD', isTextBased: () => true,
    messages: { fetch: async ({ after, limit }: { after?: string; limit?: number }) => new Map(sent.filter(m => !after || BigInt(m.id) > BigInt(after)).slice(-(limit ?? 100)).map(m => [m.id, m])) },
    send: async ({ content }: { content: string }) => {
      if (beforeSend) { const hook = beforeSend; beforeSend = undefined; await hook(); }
      const m = { id: String(nextMessageId++), content, author: { id: 'BOT' }, delete: async () => {} };
      sent.push(m); return m;
    } };
  client = { user: { id: 'BOT' }, channels: { fetch: async () => channel }, guilds: { fetch: async () => ({ roles: { cache: new Map(), fetch: async () => new Map() } }) } };
  const event = { id: 'EVENT', name: 'Círculo de lectura: Especial historias de terror', startAtMs: START, description: null, channelId: 'ROOM', imageUrl: null, url: 'https://discord.com/events/GUILD/EVENT' };
  fetchEvents.mockResolvedValue([event]); fetchEvent.mockResolvedValue(event);
  askMock.mockReset().mockResolvedValue(GOOD);
  writer = vi.fn().mockResolvedValue(GOOD);
});
afterEach(() => memory.close());

describe('manual and daily announcement coordination', () => {
  test('a deleted announcement can be previewed and confirmed again immediately, without a later automatic duplicate', async () => {
    await manual();
    deletedReceipts.add(sent[0]!.id);
    sent.length = 0; // Moderator deleted the original Discord message.
    clock += 60_000;
    const preview = await source().handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'] });
    expect(sent).toHaveLength(0);
    const result = await source().handle('calendar_send_announcement', { token: (preview.payload as any).token });
    expect(result.status).toBe('success');
    expect(sent).toHaveLength(1);
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('an explicit repost works immediately and survives preview/confirmation across source instances', async () => {
    await manual();
    const preview = await source().handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'], repost: true });
    const result = await source().handle('calendar_send_announcement', { token: (preview.payload as any).token });
    expect(result.status).toBe('success');
    expect(sent).toHaveLength(2);
    await announcer().run();
    expect(sent).toHaveLength(2);
  });
  test('repeated repost drafts in one model turn cannot create repeated pings', async () => {
    await manual();
    const tools = source();
    for (const instruction of ['primero', 'segundo', 'tercero'])
      await tools.handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'], instruction, publish_now: true, repost: true });
    expect(sent).toHaveLength(2);
  });
  test('even an explicit repost cannot bypass an unconfirmed delivery', async () => {
    channel.send = async () => { throw new Error('ambiguous timeout'); };
    await manual();
    channel.send = vi.fn();
    await source().handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'], publish_now: true, repost: true });
    expect(channel.send).not.toHaveBeenCalled();
  });
  test('a known pre-send failure keeps the approved draft retryable after permissions are fixed', async () => {
    const tools = source();
    (tools as any).options.broadcaster.post = async () => ({ ok: false, error: 'channel_not_sendable' });
    const first = await tools.handle('calendar_draft_announcement', { event_id: id, channels: ['anuncios'], publish_now: true });
    const token = (first.payload as any).token;
    const retry = await source().handle('calendar_send_announcement', { token });
    expect(retry.status).toBe('success');
    expect(sent).toHaveLength(1);
    expect(store.getAnnouncementDraft(token)?.postedMessageIds).toEqual([sent[0]!.id]);
  });
  test('a manual same-day announcement prevents the next automatic ping', async () => {
    expect((await manual()).status).toBe('success');
    clock += 32_000;
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('a daily announcement suppresses an immediate requested copy', async () => {
    await announcer().run();
    clock += 32_000;
    const result = await manual();
    expect(result.payload).toMatchObject({ already_posted: true });
    expect(result.payload).toMatchObject({ posted: false });
    expect(sent).toHaveLength(1);
  });
  test('simultaneous deleted-receipt checks cannot both acquire a replacement lease', async () => {
    await manual();
    deletedReceipts.add(sent[0]!.id);
    sent.length = 0;
    const results = await Promise.all([manual(), manual()]);
    expect(results.some(r => r.status === 'success')).toBe(true);
    expect(sent).toHaveLength(1);
  });
  test('a legacy daily receipt can also recover after deletion', async () => {
    store.recordAnnouncement({ announceKey: announceKey(id, START), eventId: id, occurrenceStartAt: START,
      channelId: CHANNEL, messageId: 'LEGACY_DELETED', discordEventId: 'EVENT', announcedAt: clock });
    deletedReceipts.add('LEGACY_DELETED');
    await manual();
    expect(sent).toHaveLength(1);
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('a same-day receipt persists beyond the ten-minute manual repeat window and a new announcer instance', async () => {
    await manual(); clock += 20 * 60_000;
    await announcer().run();
    expect(sent).toHaveLength(1);
    expect(store.isAnnounced(announceKey(id, START))).toBe(true);
  });
  test('an advance announcement does not suppress tomorrow\'s automatic announcement', async () => {
    clock -= 24 * 3600_000;
    await manual();
    expect(store.isAnnounced(announceKey(id, START))).toBe(false);
    clock += 24 * 3600_000;
    await announcer().run();
    expect(sent).toHaveLength(2);
  });
  test('an announcement to another destination does not fulfill the official daily announcement', async () => {
    store.setAnnounceChannelId('ANOTHER_CHANNEL');
    await manual();
    expect(store.isAnnounced(announceKey(id, START))).toBe(false);
  });
  test('daily cannot overtake a manual post awaiting its send receipt', async () => {
    beforeSend = async () => { await announcer().run(); };
    await manual();
    expect(sent).toHaveLength(1);
  });
  test('manual cannot overtake a daily post awaiting its send receipt', async () => {
    beforeSend = async () => { await manual(); };
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('daily reserves before writing, so a manual request during model latency also waits', async () => {
    askMock.mockImplementationOnce(async () => { await manual(); return GOOD; });
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('a daily writer that outlives its lease cannot send after a manual delivery took ownership', async () => {
    askMock.mockImplementationOnce(async () => { clock += 11 * 60_000; await manual(); return GOOD; });
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('a slow daily writer renews its own reservation before awaiting the send', async () => {
    askMock.mockImplementationOnce(async () => { clock += 11 * 60_000; return GOOD; });
    beforeSend = async () => { await manual(); };
    await announcer().run();
    expect(sent).toHaveLength(1);
  });
  test('a failed manual send without a receipt cannot cause an immediate automatic retry/ping', async () => {
    channel.send = async () => { throw new Error('ambiguous timeout'); };
    await manual();
    channel.send = vi.fn();
    await announcer().run();
    expect(channel.send).not.toHaveBeenCalled();
    expect(store.isAnnounced(announceKey(id, START))).toBe(false);
  });
  test('a later explicit manual repost and an operator daily repost remain available', async () => {
    await announcer().run(); clock += 11 * 60_000;
    await manual();
    expect(sent).toHaveLength(2);
    await announcer().run({ ignoreLedger: true });
    expect(sent).toHaveLength(3);
  });
  test('legacy same-day manual receipts are recognized without a backfill write', async () => {
    store.reserveBroadcast(id, START, CHANNEL, 'legacy', clock);
    store.finishBroadcast(id, START, CHANNEL, 'legacy', 'LEGACY_MESSAGE');
    clock += 20 * 60_000;
    await announcer().run();
    expect(sent).toHaveLength(0);
  });
  test('legacy recent daily receipts also suppress requested posts', async () => {
    store.recordAnnouncement({ announceKey: announceKey(id, START), eventId: id, occurrenceStartAt: START,
      channelId: CHANNEL, messageId: 'LEGACY_DAILY', discordEventId: 'EVENT', announcedAt: clock });
    const result = await manual();
    expect(result.payload).toMatchObject({ already_posted: true });
    expect(sent).toHaveLength(0);
  });
  test('a dry run cannot reserve or fulfill a delivery', async () => {
    await announcer().run({ dryRun: true });
    expect(memory.db().prepare('SELECT count(*) AS n FROM calendar_broadcast_deliveries').get()).toEqual({ n: 0 });
    await manual();
    expect(sent).toHaveLength(1);
  });
});

describe('announcement facts', () => {
  test('the observed invented bring-a-story instruction is not published', async () => {
    writer.mockResolvedValue('Amixes de RevZ, hoy a las 8 PM nos vemos en Sala de Lectura. Trae tu cuento o poema de terror favorito para compartirlo con la banda.');
    await manual();
    expect(sent.some(m => /trae tu cuento/i.test(m.content))).toBe(false);
    expect(writer).toHaveBeenCalledTimes(2);
  });
  test('a corrected second draft is published once', async () => {
    writer.mockResolvedValueOnce('Trae tu cuento o poema de terror favorito a la lectura de hoy.').mockResolvedValueOnce(GOOD);
    expect((await manual()).status).toBe('success');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain(GOOD);
  });
  test('explicit moderator participation instructions are preserved', async () => {
    writer.mockResolvedValue('Hoy a las 8 PM en Sala de Lectura. Trae tu poema favorito para compartirlo.');
    const result = await source(clock, 'Anuncia la sesión: que traigan un poema favorito.').handle('calendar_draft_announcement',
      { event_id: id, channels: ['anuncios'], publish_now: true });
    expect(result.status).toBe('success');
    expect(sent[0]!.content).toContain('Trae tu poema');
  });
  test('model-authored instructions cannot authorize invented requirements', async () => {
    writer.mockResolvedValue('Hoy a las 8 PM, trae tu poema para compartirlo con la banda.');
    expect((await manual('que traigan poemas')).status).toBe('error');
    expect(sent).toHaveLength(0);
  });
  test('the daily writer also rejects unsupported participation and falls back safely', async () => {
    askMock.mockResolvedValue('Hoy a las 8 PM hay círculo de lectura. Trae tu cuento o poema favorito para compartirlo.');
    await announcer().run();
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).not.toMatch(/trae|poema favorito/i);
  });
});
