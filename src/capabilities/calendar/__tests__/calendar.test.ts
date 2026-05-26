/**
 * Calendar capability tests.
 *
 * Two layers of coverage:
 *   1. Direct CalendarStore tests — schema, channel + user isolation,
 *      CRUD shapes, scope: 'all' reveal path.
 *   2. Full agent-loop integration via ask() with a mocked Kimi/OpenAI
 *      client, a real CalendarCapability, and an in-memory SQLite store.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const { ask } = await import('../../../llm/client.js');
const { SqliteMemoryStore, NamespacedMemory } = await import('../../../memory/store.js');
const { CalendarCapability } = await import('../capability.js');
const { CalendarStore } = await import('../store.js');
import type { Turn } from '../../../discord/history.js';

function endStop(text: string) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function toolCalls(calls: Array<{ id: string; name: string; input: unknown }>) {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function findToolMessage(callIndex: number, toolCallId: string): { role: string; tool_call_id: string; content: string } {
  const req = createMock.mock.calls[callIndex][0] as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
  const found = req.messages.find((m) => m.role === 'tool' && m.tool_call_id === toolCallId);
  if (!found) throw new Error(`No tool message with id ${toolCallId}`);
  return found as { role: string; tool_call_id: string; content: string };
}

async function newCapability() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' });
  return { cap, memory, store: new CalendarStore(memory.db()) };
}

const NOW = new Date('2026-05-23T18:00:00.000Z');

describe('CalendarStore (direct)', () => {
  test('create → get → update → delete roundtrip', async () => {
    const { store, memory } = await newCapability();
    const created = store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Standup',
      start_at: Date.parse('2026-05-24T15:00:00Z'),
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Standup');
    expect(created.channel_id).toBe('CHAN_A');
    expect(created.discord_user_id).toBe('USER_1');
    expect(created.created_by).toBe('USER_1');

    const fetched = store.get('CHAN_A', 'USER_1', 'mine', created.id);
    expect(fetched?.title).toBe('Standup');

    const updated = store.update('CHAN_A', 'USER_1', created.id, { title: 'Daily Standup' });
    expect(updated?.title).toBe('Daily Standup');

    const deleted = store.delete('CHAN_A', 'USER_1', created.id);
    expect(deleted?.title).toBe('Daily Standup');
    expect(store.get('CHAN_A', 'USER_1', 'mine', created.id)).toBeNull();
    memory.close();
  });

  test('channel isolation: cannot read or mutate another channel\'s events', async () => {
    const { store, memory } = await newCapability();
    const e = store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Lunch',
      start_at: Date.parse('2026-05-24T18:00:00Z'),
    });
    expect(store.get('CHAN_B', 'USER_1', 'mine', e.id)).toBeNull();
    expect(store.get('CHAN_B', 'USER_1', 'all', e.id)).toBeNull();
    expect(store.update('CHAN_B', 'USER_1', e.id, { title: 'Hacked' })).toBeNull();
    expect(store.delete('CHAN_B', 'USER_1', e.id)).toBeNull();
    expect(store.get('CHAN_A', 'USER_1', 'mine', e.id)?.title).toBe('Lunch');
    memory.close();
  });

  test('user isolation: in the same channel, scope: "mine" only returns the caller\'s events', async () => {
    const { store, memory } = await newCapability();
    store.create({
      channel_id: 'C',
      discord_user_id: 'USER_A',
      title: 'A-event',
      start_at: NOW.getTime() + 1000,
    });
    store.create({
      channel_id: 'C',
      discord_user_id: 'USER_B',
      title: 'B-event',
      start_at: NOW.getTime() + 2000,
    });

    const aOnly = store.listUpcoming('C', 'USER_A', 'mine', NOW.getTime(), 10);
    expect(aOnly.map((r) => r.title)).toEqual(['A-event']);

    const bOnly = store.listUpcoming('C', 'USER_B', 'mine', NOW.getTime(), 10);
    expect(bOnly.map((r) => r.title)).toEqual(['B-event']);

    const everyone = store.listUpcoming('C', 'USER_A', 'all', NOW.getTime(), 10);
    expect(everyone.map((r) => r.title).sort()).toEqual(['A-event', 'B-event']);

    const everyoneSearch = store.search('C', 'USER_B', 'all', 'event', null, null, 10);
    expect(everyoneSearch.map((r) => r.title).sort()).toEqual(['A-event', 'B-event']);

    const mineSearch = store.search('C', 'USER_A', 'mine', 'event', null, null, 10);
    expect(mineSearch.map((r) => r.title)).toEqual(['A-event']);

    memory.close();
  });

  test('user isolation: cannot update or delete another user\'s event in the same channel', async () => {
    const { store, memory } = await newCapability();
    const a = store.create({
      channel_id: 'C',
      discord_user_id: 'USER_A',
      title: 'A-event',
      start_at: NOW.getTime() + 1000,
    });

    // USER_B sees scope:'mine' as not-found:
    expect(store.get('C', 'USER_B', 'mine', a.id)).toBeNull();
    // ...but scope:'all' reveals it:
    expect(store.get('C', 'USER_B', 'all', a.id)?.title).toBe('A-event');

    // USER_B cannot mutate via update/delete (no scope knob — always 'mine'):
    expect(store.update('C', 'USER_B', a.id, { title: 'Hacked' })).toBeNull();
    expect(store.delete('C', 'USER_B', a.id)).toBeNull();

    // Owner still sees + mutates fine:
    expect(store.get('C', 'USER_A', 'mine', a.id)?.title).toBe('A-event');
    expect(store.update('C', 'USER_A', a.id, { title: 'Renamed' })?.title).toBe('Renamed');
    memory.close();
  });

  test('adminDelete bypasses the user filter', async () => {
    const { store, memory } = await newCapability();
    const a = store.create({
      channel_id: 'C',
      discord_user_id: 'USER_A',
      title: 'Owned by A',
      start_at: NOW.getTime() + 1000,
    });
    const deleted = store.adminDelete('C', a.id);
    expect(deleted?.title).toBe('Owned by A');
    expect(store.get('C', 'USER_A', 'mine', a.id)).toBeNull();
    // Channel isolation still applies — different channel returns null:
    const b = store.create({
      channel_id: 'C',
      discord_user_id: 'USER_A',
      title: 'Other',
      start_at: NOW.getTime() + 2000,
    });
    expect(store.adminDelete('OTHER_CHAN', b.id)).toBeNull();
    memory.close();
  });

  test('listUpcoming returns only future events, ordered by start_at', async () => {
    const { store, memory } = await newCapability();
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'past', start_at: NOW.getTime() - 10_000 });
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'second', start_at: NOW.getTime() + 20_000 });
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'first', start_at: NOW.getTime() + 10_000 });
    const rows = store.listUpcoming('C', 'U', 'mine', NOW.getTime(), 10);
    expect(rows.map((r) => r.title)).toEqual(['first', 'second']);
    memory.close();
  });

  test('search filters by query and optional date range', async () => {
    const { store, memory } = await newCapability();
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'Sprint planning', start_at: NOW.getTime() + 1000 });
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'Demo', description: 'Sprint demo for stakeholders', start_at: NOW.getTime() + 2000 });
    store.create({ channel_id: 'C', discord_user_id: 'U', title: 'Unrelated', start_at: NOW.getTime() + 3000 });
    const sprintMatches = store.search('C', 'U', 'mine', 'sprint', null, null, 10);
    expect(sprintMatches.map((r) => r.title).sort()).toEqual(['Demo', 'Sprint planning']);
    const ranged = store.search('C', 'U', 'mine', 'sprint', NOW.getTime() + 1500, null, 10);
    expect(ranged.map((r) => r.title)).toEqual(['Demo']);
    memory.close();
  });

  test('migration is idempotent across reinitialisations', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    const c1 = new CalendarCapability();
    await c1.init({ memory: new NamespacedMemory(memory, c1.id), projectRoot: '.' });
    const c2 = new CalendarCapability();
    await c2.init({ memory: new NamespacedMemory(memory, c2.id), projectRoot: '.' });
    const tableInfo = memory.db().prepare('PRAGMA table_info(calendar_events)').all() as { name: string }[];
    const cols = tableInfo.map((c) => c.name);
    expect(cols).toContain('channel_id');
    expect(cols).toContain('discord_user_id');
    expect(cols).toContain('recurrence_freq');
    expect(cols).toContain('recurrence_until');
    const indexes = memory.db().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('calendar_events_channel_user_start');
    memory.close();
  });

  test('recurring weekly event expands into multiple occurrences when listed', async () => {
    const { store, memory } = await newCapability();
    const master = store.create({
      channel_id: 'C',
      discord_user_id: 'U',
      title: 'Book club',
      start_at: Date.parse('2026-05-27T02:00:00Z'),
      recurrence_freq: 'weekly',
    });
    expect(master.recurrence_freq).toBe('weekly');
    expect(master.recurrence_until).toBeNull();

    const rows = store.listUpcoming('C', 'U', 'mine', Date.parse('2026-05-27T00:00:00Z'), 4);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.id === master.id)).toBe(true);
    expect(rows.map((r) => new Date(r.start_at).toISOString())).toEqual([
      '2026-05-27T02:00:00.000Z',
      '2026-06-03T02:00:00.000Z',
      '2026-06-10T02:00:00.000Z',
      '2026-06-17T02:00:00.000Z',
    ]);
    expect(rows[0].is_recurring_instance).toBe(false);
    expect(rows[1].is_recurring_instance).toBe(true);
    expect(rows[3].occurrence_index).toBe(3);
    memory.close();
  });

  test('recurring + one-off events merge and sort by occurrence start time', async () => {
    const { store, memory } = await newCapability();
    store.create({
      channel_id: 'C',
      discord_user_id: 'U',
      title: 'Weekly standup',
      start_at: Date.parse('2026-05-27T15:00:00Z'),
      recurrence_freq: 'weekly',
      recurrence_until: Date.parse('2026-06-30T23:59:59Z'),
    });
    store.create({
      channel_id: 'C',
      discord_user_id: 'U',
      title: 'One-off',
      start_at: Date.parse('2026-05-29T18:00:00Z'),
    });
    const rows = store.listUpcoming('C', 'U', 'mine', Date.parse('2026-05-27T00:00:00Z'), 10);
    const labels = rows.map((r) => `${r.title}@${new Date(r.start_at).toISOString().slice(0, 10)}`);
    expect(labels).toEqual([
      'Weekly standup@2026-05-27',
      'One-off@2026-05-29',
      'Weekly standup@2026-06-03',
      'Weekly standup@2026-06-10',
      'Weekly standup@2026-06-17',
      'Weekly standup@2026-06-24',
    ]);
    memory.close();
  });

  test('updating recurrence_freq to null converts a series into a one-off', async () => {
    const { store, memory } = await newCapability();
    const master = store.create({
      channel_id: 'C',
      discord_user_id: 'U',
      title: 'Was weekly',
      start_at: Date.parse('2026-05-27T15:00:00Z'),
      recurrence_freq: 'weekly',
    });
    expect(store.listUpcoming('C', 'U', 'mine', master.start_at, 5).length).toBeGreaterThanOrEqual(2);
    store.update('C', 'U', master.id, { recurrence_freq: null });
    const after = store.listUpcoming('C', 'U', 'mine', master.start_at, 5);
    expect(after).toHaveLength(1);
    expect(after[0].recurrence_freq).toBeNull();
    memory.close();
  });
});

describe('CalendarCapability + agent loop (mocked Kimi)', () => {
  beforeEach(() => createMock.mockReset());

  test('buildTurn snapshot is user-scoped — only the caller\'s events appear in the system prompt', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Deploy review',
      start_at: Date.parse('2026-05-24T21:00:00Z'),
    });
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_2',
      title: 'Other user event',
      start_at: Date.parse('2026-05-24T22:00:00Z'),
    });

    const turn1 = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 'tester',
      now: NOW,
    });
    expect(turn1.system).toContain('2026-05-23T18:00:00.000Z');
    expect(turn1.system).toContain('Deploy review');
    expect(turn1.system).not.toContain('Other user event');

    const turn2 = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_2',
      userTag: 'other',
      now: NOW,
    });
    expect(turn2.system).toContain('Other user event');
    expect(turn2.system).not.toContain('Deploy review');
    memory.close();
  });

  test('"create event tomorrow at 3pm" path: create → list confirms persistence', async () => {
    const { cap, store, memory } = await newCapability();

    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'c1',
            name: 'calendar_create_event',
            input: { title: 'Deploy review', start_at_iso: '2026-05-24T21:00:00Z' },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('Listo, agendé **Deploy review** para mañana 3pm.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'agenda deploy review mañana 3pm' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('Deploy review');
    const rows = store.listUpcoming('CHAN_A', 'USER_1', 'mine', NOW.getTime(), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Deploy review');
    expect(rows[0].discord_user_id).toBe('USER_1');
    memory.close();
  });

  test('list path: returns only the calling user\'s events by default', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Standup',
      start_at: NOW.getTime() + 60_000,
    });
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'OTHER',
      title: 'OtherUserMeeting',
      start_at: NOW.getTime() + 90_000,
    });

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'l1', name: 'calendar_list_upcoming', input: {} }]))
      .mockResolvedValueOnce(endStop('Tienes 1 evento próximo: Standup.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: '¿qué tengo pendiente?' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('Standup');

    const toolMsg = findToolMessage(1, 'l1');
    const payload = JSON.parse(toolMsg.content) as { scope: string; events: Array<{ title: string }> };
    expect(payload.scope).toBe('mine');
    expect(payload.events.map((e) => e.title)).toEqual(['Standup']);
    memory.close();
  });

  test('scope: "all" path: model can ask for the channel-wide calendar', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Mine event',
      start_at: NOW.getTime() + 60_000,
    });
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'OTHER',
      title: 'TeamMeeting',
      start_at: NOW.getTime() + 90_000,
    });

    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'l1', name: 'calendar_list_upcoming', input: { scope: 'all' } }]),
      )
      .mockResolvedValueOnce(endStop('Hay 2 eventos en el canal: Mine event y TeamMeeting.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: '¿qué hay en el calendario del equipo?' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('TeamMeeting');

    const toolMsg = findToolMessage(1, 'l1');
    const payload = JSON.parse(toolMsg.content) as { scope: string; events: Array<{ title: string; discord_user_id: string }> };
    expect(payload.scope).toBe('all');
    expect(payload.events.map((e) => e.title).sort()).toEqual(['Mine event', 'TeamMeeting']);
    expect(payload.events.some((e) => e.discord_user_id === 'OTHER')).toBe(true);
    memory.close();
  });

  test('cannot delete another user\'s event through the tool layer (returns not-found)', async () => {
    const { cap, store, memory } = await newCapability();
    const a = store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_A',
      title: 'A-event',
      start_at: NOW.getTime() + 60_000,
    });

    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'd1', name: 'calendar_delete_event', input: { id: a.id } }]),
      )
      .mockResolvedValueOnce(endStop('No encontré ese evento entre los tuyos.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_B',
      userTag: 'b',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'borra el evento 1' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('No encontré');

    const toolMsg = findToolMessage(1, 'd1');
    const payload = JSON.parse(toolMsg.content) as { error?: string };
    expect(payload.error).toMatch(/not found/);
    // Event survives:
    expect(store.get('CHAN_A', 'USER_A', 'mine', a.id)?.title).toBe('A-event');
    memory.close();
  });

  test('channel isolation through the tool layer: capability for CHAN_B cannot see CHAN_A events', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Channel-A only',
      start_at: NOW.getTime() + 1000,
    });

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'l1', name: 'calendar_list_upcoming', input: { scope: 'all' } }]))
      .mockResolvedValueOnce(endStop('No tienes eventos próximos.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_B',
      guildId: null,
      userId: 'OTHER',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'list events' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('No tienes');

    const toolMsg = findToolMessage(1, 'l1');
    const payload = JSON.parse(toolMsg.content) as { events: unknown[] };
    expect(payload.events).toEqual([]);
    memory.close();
  });

  test('delete echoes the deleted event back to the model as a tool result', async () => {
    const { cap, store, memory } = await newCapability();
    const created = store.create({
      channel_id: 'CHAN_A',
      discord_user_id: 'USER_1',
      title: 'Lunch',
      start_at: NOW.getTime() + 60_000,
    });

    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'd1', name: 'calendar_delete_event', input: { id: created.id } }]),
      )
      .mockResolvedValueOnce(endStop('Borrado: **Lunch**.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'borra el lunch' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('Lunch');
    expect(store.get('CHAN_A', 'USER_1', 'mine', created.id)).toBeNull();
    memory.close();
  });

  test('recurring create: model calls create_event with recurrence_freq, snapshot then shows instances', async () => {
    const { cap, memory } = await newCapability();

    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'c1',
            name: 'calendar_create_event',
            input: {
              title: 'Círculo de lectura: repensando la pobreza',
              start_at_iso: '2026-05-28T02:00:00Z',
              recurrence_freq: 'weekly',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        endStop('Listo, cada miércoles a las 8pm. El siguiente: miércoles 27 de mayo.'),
      );

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [
        { role: 'user', content: 'agrega un nuevo evento del círculo de lectura cada miércoles a las 8pm' },
      ] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('miércoles');

    const all = memory.db().prepare('SELECT * FROM calendar_events WHERE channel_id = ?').all('CHAN_A') as Array<{
      title: string;
      recurrence_freq: string | null;
      discord_user_id: string;
    }>;
    expect(all).toHaveLength(1);
    expect(all[0].recurrence_freq).toBe('weekly');
    expect(all[0].title).toContain('Círculo de lectura');
    expect(all[0].discord_user_id).toBe('USER_1');

    const turn2 = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    expect(turn2.system).toContain('Círculo de lectura');
    expect(turn2.system).toContain('recurring weekly');
    memory.close();
  });

  test('recurrence_freq with a value outside the allowed enum is rejected', async () => {
    const { cap, memory } = await newCapability();

    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'c1',
            name: 'calendar_create_event',
            input: {
              title: 'every-other',
              start_at_iso: '2026-05-28T02:00:00Z',
              recurrence_freq: 'biweekly',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('Lo siento, sólo soporto daily, weekly y monthly.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'every other Wednesday' }] as Turn[],
      tools: turn.tools,
    });

    const all = memory.db().prepare('SELECT * FROM calendar_events').all() as unknown[];
    expect(all).toHaveLength(0);

    const toolMsg = findToolMessage(1, 'c1');
    expect(toolMsg.content).toContain('error');
    memory.close();
  });

  test('invalid ISO date returns a structured tool error the model can recover from', async () => {
    const { cap, memory } = await newCapability();

    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'c1',
            name: 'calendar_create_event',
            input: { title: 'x', start_at_iso: 'tomorrow' },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('No pude parsear la fecha — necesito ISO 8601.'));

    const turn = await cap.buildTurn({
      channelId: 'CHAN_A',
      guildId: null,
      userId: 'USER_1',
      userTag: 't',
      now: NOW,
    });
    const out = await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'crea evento mañana' }] as Turn[],
      tools: turn.tools,
    });
    expect(out).toContain('ISO');

    const toolMsg = findToolMessage(1, 'c1');
    expect(toolMsg.content).toContain('error');
    memory.close();
  });
});
