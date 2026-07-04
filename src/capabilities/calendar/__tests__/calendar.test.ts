/**
 * Calendar capability tests.
 *
 * The calendar is GLOBAL (like instagram_monitor): one shared set of events for
 * the whole server, with no per-user scoping. `created_by` is attribution only.
 *
 * Two layers:
 *   1. Direct CalendarStore tests — global CRUD, recurrence expansion, the
 *      publish-tracking + settings tables, and the v5 migration shape.
 *   2. Full agent-loop integration via ask() with a mocked Kimi/OpenAI client,
 *      a real CalendarCapability and an in-memory SQLite store. The publisher is
 *      absent (no Discord client) so mutations report publishing_disabled.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send = createMock;
    constructor(_opts?: unknown) {}
  }
  class ConverseCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient, ConverseCommand };
});

const { ask } = await import('../../../llm/client.js');
const { SqliteMemoryStore, NamespacedMemory } = await import('../../../memory/store.js');
const { CalendarCapability } = await import('../capability.js');
const { CalendarStore, CALENDAR_MIGRATIONS } = await import('../store.js');
import type { Turn } from '../../../discord/history.js';

/** A migrated store with NO capability seeding (so settings start empty). */
async function bareStore() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  return { memory, store: new CalendarStore(memory.db()) };
}

function endStop(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

function toolCalls(calls: Array<{ id: string; name: string; input: unknown }>) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } })),
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

// Find the Converse toolResult block carrying a given toolUseId across all sent
// requests' messages, and return it in the legacy { tool_call_id, content }
// shape the test bodies expect (content is the JSON-encoded tool payload).
function findToolMessage(callIndex: number, toolCallId: string): { role: string; tool_call_id: string; content: string } {
  const input = (createMock.mock.calls[callIndex][0] as { input: { messages: Array<{ content: Array<Record<string, unknown>> }> } }).input;
  for (const m of input.messages) {
    for (const block of m.content ?? []) {
      const tr = (block as { toolResult?: { toolUseId: string; content: Array<{ text?: string }> } }).toolResult;
      if (tr && tr.toolUseId === toolCallId) {
        return { role: 'tool', tool_call_id: tr.toolUseId, content: tr.content?.[0]?.text ?? '' };
      }
    }
  }
  throw new Error(`No tool message with id ${toolCallId}`);
}

async function newCapability() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' });
  return { cap, memory, store: new CalendarStore(memory.db()) };
}

const NOW = new Date('2026-06-10T18:00:00.000Z');
const ctx = (over: Partial<{ channelId: string; userId: string }> = {}) => ({
  channelId: over.channelId ?? 'INPUT_CHAN',
  guildId: null,
  userId: over.userId ?? 'MOD_1',
  userTag: 'mod',
  now: NOW,
});

describe('CalendarStore (direct, global)', () => {
  test('create → get → update → delete roundtrip', async () => {
    const { store, memory } = await newCapability();
    const created = store.create({ created_by: 'MOD_1', title: 'Asamblea', start_at: Date.parse('2026-06-20T02:00:00Z') });
    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Asamblea');
    expect(created.created_by).toBe('MOD_1');

    expect(store.get(created.id)?.title).toBe('Asamblea');
    expect(store.update(created.id, { title: 'Asamblea constituyente' })?.title).toBe('Asamblea constituyente');
    expect(store.delete(created.id)?.title).toBe('Asamblea constituyente');
    expect(store.get(created.id)).toBeNull();
    memory.close();
  });

  test('events are global: every caller sees the same calendar (no user scoping)', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({ created_by: 'MOD_1', title: 'Círculo', start_at: NOW.getTime() + 60_000 });
    store.create({ created_by: 'MOD_2', title: 'Taller', start_at: NOW.getTime() + 120_000 });

    expect(store.listUpcoming(NOW.getTime(), 10).map((e) => e.title)).toEqual(['Círculo', 'Taller']);
    expect(store.listAll().map((e) => e.title).sort()).toEqual(['Círculo', 'Taller']);

    // Both mods get the same snapshot in their system prompt.
    const a = await cap.buildTurn(ctx({ userId: 'MOD_1' }));
    const b = await cap.buildTurn(ctx({ userId: 'MOD_2' }));
    for (const turn of [a, b]) {
      expect(turn.system).toContain('Círculo');
      expect(turn.system).toContain('Taller');
    }
    memory.close();
  });

  test('listUpcoming returns only future events, ordered by start_at', async () => {
    const { store, memory } = await newCapability();
    store.create({ created_by: 'U', title: 'past', start_at: NOW.getTime() - 10_000 });
    store.create({ created_by: 'U', title: 'second', start_at: NOW.getTime() + 20_000 });
    store.create({ created_by: 'U', title: 'first', start_at: NOW.getTime() + 10_000 });
    expect(store.listUpcoming(NOW.getTime(), 10).map((r) => r.title)).toEqual(['first', 'second']);
    memory.close();
  });

  test('search filters by query and optional date range', async () => {
    const { store, memory } = await newCapability();
    store.create({ created_by: 'U', title: 'Sprint planning', start_at: NOW.getTime() + 1000 });
    store.create({ created_by: 'U', title: 'Demo', description: 'Sprint demo', start_at: NOW.getTime() + 2000 });
    store.create({ created_by: 'U', title: 'Unrelated', start_at: NOW.getTime() + 3000 });
    expect(store.search('sprint', null, null, 10).map((r) => r.title).sort()).toEqual(['Demo', 'Sprint planning']);
    expect(store.search('sprint', NOW.getTime() + 1500, null, 10).map((r) => r.title)).toEqual(['Demo']);
    memory.close();
  });

  // Regression for the live incident (2026-07-03): a mod asked to delete
  // "club de poesía: rosario castellanos" and the LIKE search returned zero rows
  // because the query dropped the stored title's colon (and, in other turns, the
  // accent). Fuzzy matching must find it regardless of punctuation/accents/order.
  test('search is tolerant of punctuation, accents, case and word order', async () => {
    const { store, memory } = await newCapability();
    const ev = store.create({ created_by: 'U', title: 'Club de poesía: Rosario Castellanos', start_at: NOW.getTime() + 86_400_000 });

    // Colon dropped (the exact failing query).
    expect(store.search('club de poesía rosario castellanos', null, null, 10).map((r) => r.id)).toEqual([ev.id]);
    // Accent dropped too.
    expect(store.search('club de poesia rosario castellanos', null, null, 10).map((r) => r.id)).toEqual([ev.id]);
    // Reordered + different case.
    expect(store.search('ROSARIO castellanos poesia', null, null, 10).map((r) => r.id)).toEqual([ev.id]);
    // A clearly different event is not matched on the shared "club"/"de" tokens.
    expect(store.search('club de cine', null, null, 10)).toHaveLength(0);
    memory.close();
  });

  test('search disambiguates two similar titles and excludes weak token overlap', async () => {
    const { store, memory } = await newCapability();
    const rosario = store.create({ created_by: 'U', title: 'Club de poesía: Rosario Castellanos', start_at: NOW.getTime() + 86_400_000 });
    store.create({ created_by: 'U', title: 'Club de poesía: Jaime Sabines', start_at: NOW.getTime() + 2 * 86_400_000 });

    // The distinctive words pin it to the right one; the other poetry club (only
    // "club"+"poesia" in common, 2/4 < 0.6) is filtered out.
    expect(store.search('rosario castellanos', null, null, 10).map((r) => r.id)).toEqual([rosario.id]);
    memory.close();
  });

  test('search returns one representative per recurring master (not every occurrence)', async () => {
    const { store, memory } = await newCapability();
    const master = store.create({
      created_by: 'U',
      title: 'Círculo de estudios',
      start_at: NOW.getTime() + 86_400_000,
      recurrence_freq: 'weekly',
    });
    const rows = store.search('círculo de estudios', null, null, 25);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(master.id);
    memory.close();
  });

  test('an empty or "*" query lists everything in range', async () => {
    const { store, memory } = await newCapability();
    store.create({ created_by: 'U', title: 'Uno', start_at: NOW.getTime() + 1000 });
    store.create({ created_by: 'U', title: 'Dos', start_at: NOW.getTime() + 2000 });
    expect(store.search('*', null, null, 10).map((r) => r.title)).toEqual(['Uno', 'Dos']);
    expect(store.search('', null, null, 10).map((r) => r.title)).toEqual(['Uno', 'Dos']);
    memory.close();
  });

  test('recurring weekly event expands into multiple occurrences', async () => {
    const { store, memory } = await newCapability();
    const master = store.create({
      created_by: 'U',
      title: 'Book club',
      start_at: Date.parse('2026-05-27T02:00:00Z'),
      recurrence_freq: 'weekly',
    });
    const rows = store.listUpcoming(Date.parse('2026-05-27T00:00:00Z'), 4);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.id === master.id)).toBe(true);
    expect(rows.map((r) => new Date(r.start_at).toISOString())).toEqual([
      '2026-05-27T02:00:00.000Z',
      '2026-06-03T02:00:00.000Z',
      '2026-06-10T02:00:00.000Z',
      '2026-06-17T02:00:00.000Z',
    ]);
    expect(rows[1].is_recurring_instance).toBe(true);
    memory.close();
  });

  test('listOccurrences expands a series within an explicit window', async () => {
    const { store, memory } = await newCapability();
    store.create({ created_by: 'U', title: 'Domingo', start_at: Date.parse('2026-06-15T02:00:00Z'), recurrence_freq: 'weekly' });
    const occ = store.listOccurrences(Date.parse('2026-06-01T06:00:00Z'), Date.parse('2026-07-01T06:00:00Z'));
    // Sundays in June (local): Jun 14, 21, 28 → 02:00Z on the 15/22/29.
    expect(occ.map((o) => new Date(o.start_at).toISOString())).toEqual([
      '2026-06-15T02:00:00.000Z',
      '2026-06-22T02:00:00.000Z',
      '2026-06-29T02:00:00.000Z',
    ]);
    memory.close();
  });

  test('updating recurrence_freq to null converts a series into a one-off', async () => {
    const { store, memory } = await newCapability();
    const master = store.create({ created_by: 'U', title: 'Was weekly', start_at: Date.parse('2026-06-15T02:00:00Z'), recurrence_freq: 'weekly' });
    expect(store.listUpcoming(master.start_at, 5).length).toBeGreaterThanOrEqual(2);
    store.update(master.id, { recurrence_freq: null });
    const after = store.listUpcoming(master.start_at, 5);
    expect(after).toHaveLength(1);
    expect(after[0].recurrence_freq).toBeNull();
    memory.close();
  });

  test('output channel setting round-trips', async () => {
    const { store, memory } = await bareStore();
    expect(store.getOutputChannelId()).toBeNull();
    store.setOutputChannelId('1518328211165941912');
    expect(store.getOutputChannelId()).toBe('1518328211165941912');
    store.setOutputChannelId(null);
    expect(store.getOutputChannelId()).toBeNull();
    memory.close();
  });

  test('capability.init seeds the output channel from config when set', async () => {
    // dotenv (via config import) has populated process.env by now.
    const expected = process.env.CALENDAR_OUTPUT_CHANNEL_ID ?? null;
    const { store, memory } = await newCapability();
    expect(store.getOutputChannelId()).toBe(expected);
    memory.close();
  });

  test('published-message tracking set/get/clear', async () => {
    const { store, memory } = await bareStore();
    expect(store.getPublished('pdf:2026-06')).toBeNull();
    store.setPublished('pdf:2026-06', 'CHAN', 'MSG1');
    expect(store.getPublished('pdf:2026-06')).toMatchObject({ channel_id: 'CHAN', message_id: 'MSG1' });
    store.setPublished('pdf:2026-06', 'CHAN', 'MSG2'); // upsert
    expect(store.getPublished('pdf:2026-06')?.message_id).toBe('MSG2');
    store.clearPublished('pdf:2026-06');
    expect(store.getPublished('pdf:2026-06')).toBeNull();
    memory.close();
  });

  test('v5 migration: global schema (no discord_user_id) + publish/settings tables', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    const c1 = new CalendarCapability();
    await c1.init({ memory: new NamespacedMemory(memory, c1.id), projectRoot: '.' });

    const cols = (memory.db().prepare('PRAGMA table_info(calendar_events)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('discord_user_id');
    expect(cols).not.toContain('channel_id');
    expect(cols).toContain('created_by');
    expect(cols).toContain('recurrence_freq');

    const tables = (memory.db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('calendar_published');
    expect(tables).toContain('calendar_settings');

    const indexes = (memory.db().prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('calendar_events_start');
    memory.close();
  });
});

describe('CalendarCapability + agent loop (mocked Kimi)', () => {
  beforeEach(() => createMock.mockReset());

  test('buildTurn snapshot includes the current time and all events', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({ created_by: 'MOD_1', title: 'Deploy review', start_at: Date.parse('2026-06-12T21:00:00Z') });
    const turn = await cap.buildTurn(ctx());
    expect(turn.system).toContain('2026-06-10T18:00:00.000Z');
    expect(turn.system).toContain('Deploy review');
    memory.close();
  });

  test('create path persists the event (created_by = caller) and reports publishing_disabled', async () => {
    const { cap, store, memory } = await newCapability();
    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'c1', name: 'calendar_create_event', input: { title: 'Asamblea', start_at_iso: '2026-06-20T02:00:00Z' } }]),
      )
      .mockResolvedValueOnce(endStop('Listo, agendé **Asamblea**.'));

    const turn = await cap.buildTurn(ctx({ userId: 'MOD_7' }));
    const out = await ask({ system: turn.system, messages: [{ role: 'user', content: 'agenda asamblea el 19 a las 8pm' }] as Turn[], tools: turn.tools });
    expect(out).toContain('Asamblea');

    const rows = store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe('MOD_7');

    const toolMsg = findToolMessage(1, 'c1');
    const payload = JSON.parse(toolMsg.content) as { published?: { ok: boolean; error?: string } };
    expect(payload.published?.ok).toBe(false);
    expect(payload.published?.error).toBe('publishing_disabled');
    memory.close();
  });

  test('list path returns every event on the shared calendar', async () => {
    const { cap, store, memory } = await newCapability();
    store.create({ created_by: 'MOD_1', title: 'Standup', start_at: NOW.getTime() + 60_000 });
    store.create({ created_by: 'MOD_2', title: 'Taller', start_at: NOW.getTime() + 90_000 });

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'l1', name: 'calendar_list_upcoming', input: {} }]))
      .mockResolvedValueOnce(endStop('Hay 2 eventos.'));

    const turn = await cap.buildTurn(ctx());
    await ask({ system: turn.system, messages: [{ role: 'user', content: '¿qué viene?' }] as Turn[], tools: turn.tools });

    const payload = JSON.parse(findToolMessage(1, 'l1').content) as { events: Array<{ title: string }> };
    expect(payload.events.map((e) => e.title)).toEqual(['Standup', 'Taller']);
    memory.close();
  });

  test('any mod can delete any event; delete echoes the deleted event', async () => {
    const { cap, store, memory } = await newCapability();
    const created = store.create({ created_by: 'MOD_1', title: 'Lunch', start_at: NOW.getTime() + 60_000 });

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'd1', name: 'calendar_delete_event', input: { id: created.id } }]))
      .mockResolvedValueOnce(endStop('Borrado: **Lunch**.'));

    // A different mod deletes it.
    const turn = await cap.buildTurn(ctx({ userId: 'MOD_2' }));
    const out = await ask({ system: turn.system, messages: [{ role: 'user', content: 'borra el lunch' }] as Turn[], tools: turn.tools });
    expect(out).toContain('Lunch');
    expect(store.get(created.id)).toBeNull();
    memory.close();
  });

  test('recurring create: model sets recurrence_freq; snapshot then shows the series', async () => {
    const { cap, memory } = await newCapability();
    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'c1', name: 'calendar_create_event', input: { title: 'Círculo: Repensar la Pobreza', start_at_iso: '2026-06-15T02:00:00Z', recurrence_freq: 'weekly' } }]),
      )
      .mockResolvedValueOnce(endStop('Listo, cada domingo a las 8pm.'));

    const turn = await cap.buildTurn(ctx());
    await ask({ system: turn.system, messages: [{ role: 'user', content: 'círculo cada domingo 8pm' }] as Turn[], tools: turn.tools });

    const all = memory.db().prepare('SELECT * FROM calendar_events').all() as Array<{ title: string; recurrence_freq: string | null }>;
    expect(all).toHaveLength(1);
    expect(all[0].recurrence_freq).toBe('weekly');

    const turn2 = await cap.buildTurn(ctx());
    expect(turn2.system).toContain('Repensar la Pobreza');
    expect(turn2.system).toContain('serie weekly');
    memory.close();
  });

  test('recurrence_freq outside the enum is rejected (nothing persisted)', async () => {
    const { cap, memory } = await newCapability();
    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'c1', name: 'calendar_create_event', input: { title: 'x', start_at_iso: '2026-06-15T02:00:00Z', recurrence_freq: 'biweekly' } }]),
      )
      .mockResolvedValueOnce(endStop('Solo soporto daily, weekly y monthly.'));

    const turn = await cap.buildTurn(ctx());
    await ask({ system: turn.system, messages: [{ role: 'user', content: 'cada 15 días' }] as Turn[], tools: turn.tools });
    expect(memory.db().prepare('SELECT * FROM calendar_events').all()).toHaveLength(0);
    expect(findToolMessage(1, 'c1').content).toContain('error');
    memory.close();
  });

  test('invalid ISO date returns a structured tool error', async () => {
    const { cap, memory } = await newCapability();
    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'c1', name: 'calendar_create_event', input: { title: 'x', start_at_iso: 'mañana' } }]))
      .mockResolvedValueOnce(endStop('Necesito una fecha ISO 8601.'));

    const turn = await cap.buildTurn(ctx());
    await ask({ system: turn.system, messages: [{ role: 'user', content: 'crea evento mañana' }] as Turn[], tools: turn.tools });
    expect(findToolMessage(1, 'c1').content).toContain('error');
    memory.close();
  });
});
