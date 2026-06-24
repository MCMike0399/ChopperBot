/**
 * ConfigurationCapability — integration tests with a mocked Kimi/OpenAI
 * client and an in-memory SQLite store. Drives the agent loop via ask() so
 * we exercise the actual tool dispatch path that runs in production.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Client, Guild } from 'discord.js';

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
const { CapabilityRegistry } = await import('../../registry.js');
const { buildRouter } = await import('../../routing.js');
const { CalendarCapability } = await import('../../calendar/capability.js');
const { ConfigurationCapability } = await import('../capability.js');
const { CONFIGURATION_CAPABILITY_ID, CONFIGURATION_CHANNEL_ID } = await import('../constants.js');
const { ConfigurationStore } = await import('../store.js');
const { FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS, UserDirectory } = await import(
  '../../../users/store.js'
);
import type { Turn } from '../../../discord/history.js';
import type { CapabilityInitDeps } from '../../capability.js';

const NOW = new Date('2026-05-23T18:00:00.000Z');
const OPERATOR_USER = 'OPERATOR_1';
const TARGET_CH = '30000000000000000005';

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

function makeFakeClient(): Client {
  const fakeGuild = {
    id: '40000000000000000001',
    name: 'TestGuild',
    memberCount: 3,
    channels: { cache: new Map() },
  } as unknown as Guild;
  return {
    guilds: { cache: new Map([[fakeGuild.id, fakeGuild]]) },
    channels: { cache: new Map() },
  } as unknown as Client;
}

async function buildHarness() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  const userDirectory = new UserDirectory(memory.db());
  // Seed the operator so config_list_users / config_calendar_peek have a tag
  // to surface.
  userDirectory.upsert(OPERATOR_USER, 'op#0001', NOW.getTime());

  const registry = new CapabilityRegistry();

  const configCap = new ConfigurationCapability();
  const calCap = new CalendarCapability();

  let router: ReturnType<typeof buildRouter> | null = null;
  const client = makeFakeClient();
  const initDeps = (id: string): CapabilityInitDeps => ({
    memory: new NamespacedMemory(memory, id),
    projectRoot: '.',
    getDiscordClient: () => client,
    getRegistry: () => registry,
    getRouter: () => {
      if (!router) throw new Error('router not yet built');
      return router;
    },
    getUserDirectory: () => userDirectory,
  });

  await configCap.init(initDeps(configCap.id));
  await calCap.init(initDeps(calCap.id));
  registry.register(configCap);
  registry.register(calCap);

  const channelMap = configCap.bootStore().loadBootBindings(new Map());
  router = buildRouter(channelMap);

  return { memory, registry, router, client, configCap, calCap, userDirectory };
}

describe('ConfigurationCapability — boot wiring', () => {
  beforeEach(() => createMock.mockReset());

  test('hardcoded channel is force-bound after init', async () => {
    const { router, memory } = await buildHarness();
    expect(router.resolve(CONFIGURATION_CHANNEL_ID)).toBe(CONFIGURATION_CAPABILITY_ID);
    memory.close();
  });

  test('buildTurn produces a system prompt that includes current time and admin guidance', async () => {
    const { configCap, memory } = await buildHarness();
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    expect(turn.system).toContain('2026-05-23T18:00:00.000Z');
    expect(turn.system).toContain('config_bindings');
    expect(turn.system).toContain('configuración');
    memory.close();
  });
});

describe('ConfigurationCapability — bind / unbind via the agent loop', () => {
  beforeEach(() => createMock.mockReset());

  test('list_bindings reflects what the bootstrap created', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'l1', name: 'config_bindings', input: { action: 'list' } }]))
      .mockResolvedValueOnce(endStop('Hay 1 binding activo.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'list bindings' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'l1');
    const payload = JSON.parse(toolMsg.content) as {
      bindings: Array<{ channel_id: string; is_protected: boolean }>;
    };
    expect(payload.bindings).toHaveLength(1);
    expect(payload.bindings[0].channel_id).toBe(CONFIGURATION_CHANNEL_ID);
    expect(payload.bindings[0].is_protected).toBe(true);
    memory.close();
  });

  test('bind_channel persists to DB AND updates the live router', async () => {
    const { configCap, router, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'b1', name: 'config_bindings', input: { action: 'bind', channel_id: TARGET_CH, capability: 'calendar' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('Listo, bindeé el canal a calendar.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'bindea ese canal a calendar' }] as Turn[],
      tools: turn.tools,
    });

    expect(router.resolve(TARGET_CH)).toBe('calendar');
    const persisted = new ConfigurationStore(memory.db()).get(TARGET_CH);
    expect(persisted?.capability_id).toBe('calendar');
    expect(persisted?.updated_by).toBe(OPERATOR_USER);
    memory.close();
  });

  test('bind_channel refuses to touch the configuration channel', async () => {
    const { configCap, router, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'b1',
            name: 'config_bindings',
            input: { action: 'bind', channel_id: CONFIGURATION_CHANNEL_ID, capability: 'calendar' },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('No puedo reasignar el canal de configuración.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'reasigna este canal' }] as Turn[],
      tools: turn.tools,
    });
    expect(router.resolve(CONFIGURATION_CHANNEL_ID)).toBe(CONFIGURATION_CAPABILITY_ID);
    const toolMsg = findToolMessage(1, 'b1');
    expect(toolMsg.content).toContain('error');
    memory.close();
  });

  test('bind_channel refuses unknown capabilities and lists what is available', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'b1', name: 'config_bindings', input: { action: 'bind', channel_id: TARGET_CH, capability: 'nonexistent' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('Esa capability no existe.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'bind to nonexistent' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'b1');
    const payload = JSON.parse(toolMsg.content) as { error?: string };
    expect(payload.error).toMatch(/Unknown capability/);
    expect(payload.error).toMatch(/calendar/);
    memory.close();
  });

  test('bind_channel refuses to assign the configuration capability elsewhere', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'b1', name: 'config_bindings', input: { action: 'bind', channel_id: TARGET_CH, capability: 'configuration' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('No puede.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'bind to configuration' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'b1');
    expect(toolMsg.content).toContain('error');
    memory.close();
  });

  test('unbind_channel refuses the configuration channel', async () => {
    const { configCap, router, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'u1', name: 'config_bindings', input: { action: 'unbind', channel_id: CONFIGURATION_CHANNEL_ID } },
        ]),
      )
      .mockResolvedValueOnce(endStop('No puedo.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'unbind this channel' }] as Turn[],
      tools: turn.tools,
    });
    expect(router.resolve(CONFIGURATION_CHANNEL_ID)).toBe(CONFIGURATION_CAPABILITY_ID);
    memory.close();
  });

  test('unbind_channel removes a real binding from both DB and router', async () => {
    const { configCap, router, memory } = await buildHarness();
    new ConfigurationStore(memory.db()).upsert(TARGET_CH, 'calendar', 'admin');
    router.setBinding(TARGET_CH, 'calendar');

    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'u1', name: 'config_bindings', input: { action: 'unbind', channel_id: TARGET_CH } }]),
      )
      .mockResolvedValueOnce(endStop('Desasignado.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'unbind it' }] as Turn[],
      tools: turn.tools,
    });
    expect(router.resolve(TARGET_CH)).toBeNull();
    expect(new ConfigurationStore(memory.db()).get(TARGET_CH)).toBeNull();
    memory.close();
  });
});

describe('ConfigurationCapability — destructive guards', () => {
  beforeEach(() => createMock.mockReset());

  test('purge_channel_data without confirm is rejected', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'p1',
            name: 'config_system',
            input: { action: 'purge_channel_data', capability: 'calendar', channel_id: TARGET_CH, confirm: false },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('Necesito confirmación.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'purge calendar' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'p1');
    const payload = JSON.parse(toolMsg.content) as { error?: string };
    expect(payload.error).toMatch(/confirm/);
    memory.close();
  });

  test('calendar_delete without confirm is rejected', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'd1',
            name: 'config_calendar',
            input: { action: 'delete', event_id: 1, confirm: false },
          },
        ]),
      )
      .mockResolvedValueOnce(endStop('Necesito confirmación.'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'delete event' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'd1');
    expect(toolMsg.content).toContain('error');
    memory.close();
  });
});

describe('ConfigurationCapability — DB introspection tools', () => {
  beforeEach(() => createMock.mockReset());

  test('list_capabilities returns every registered capability', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'c1', name: 'config_discovery', input: { action: 'capabilities' } }]))
      .mockResolvedValueOnce(endStop('ok'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'list capabilities' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'c1');
    const payload = JSON.parse(toolMsg.content) as { capabilities: Array<{ id: string }> };
    const ids = payload.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(['calendar', 'configuration'].sort());
    memory.close();
  });

  test('list_users returns every Discord user the bot has interacted with', async () => {
    const { configCap, userDirectory, memory } = await buildHarness();
    userDirectory.upsert('USER_B', 'beta#0002', NOW.getTime() + 1_000);
    userDirectory.upsert('USER_C', 'gamma#0003', NOW.getTime() + 2_000);

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'u1', name: 'config_system', input: { action: 'list_users' } }]))
      .mockResolvedValueOnce(endStop('ok'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'list known users' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 'u1');
    const payload = JSON.parse(toolMsg.content) as { users: Array<{ discord_user_id: string }> };
    const ids = payload.users.map((u) => u.discord_user_id).sort();
    expect(ids).toEqual(['OPERATOR_1', 'USER_B', 'USER_C'].sort());
    memory.close();
  });

  test('config_calendar peek surfaces the global calendar with creator tags', async () => {
    const { configCap, calCap, userDirectory, memory } = await buildHarness();
    void calCap;
    const USER_ALICE = '50000000000000000001';
    const USER_BOB = '50000000000000000002';
    userDirectory.upsert(USER_ALICE, 'alice#0001', NOW.getTime());
    userDirectory.upsert(USER_BOB, 'bob#0002', NOW.getTime());

    const { CalendarStore } = await import('../../calendar/store.js');
    const cal = new CalendarStore(memory.db());
    cal.create({ created_by: USER_ALICE, title: 'AliceEvent', start_at: Date.now() + 60_000 });
    cal.create({ created_by: USER_BOB, title: 'BobEvent', start_at: Date.now() + 120_000 });

    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 'p1', name: 'config_calendar', input: { action: 'peek' } }]))
      .mockResolvedValueOnce(endStop('ok'));

    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });

    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'peek calendar' }] as Turn[],
      tools: turn.tools,
    });
    const peekAll = JSON.parse(findToolMessage(1, 'p1').content) as {
      events: Array<{ title: string; created_by: string; created_by_tag: string | null }>;
    };
    expect(peekAll.events.map((e) => e.title).sort()).toEqual(['AliceEvent', 'BobEvent']);
    const alice = peekAll.events.find((e) => e.title === 'AliceEvent');
    expect(alice?.created_by).toBe(USER_ALICE);
    expect(alice?.created_by_tag).toBe('alice#0001');
    memory.close();
  });

  test('list_tables surfaces user tables including those from other capabilities', async () => {
    const { configCap, memory } = await buildHarness();
    createMock
      .mockResolvedValueOnce(toolCalls([{ id: 't1', name: 'config_db', input: { action: 'list_tables' } }]))
      .mockResolvedValueOnce(endStop('ok'));
    const turn = await configCap.buildTurn({
      channelId: CONFIGURATION_CHANNEL_ID,
      guildId: null,
      userId: OPERATOR_USER,
      userTag: 'op',
      now: NOW,
    });
    await ask({
      system: turn.system,
      messages: [{ role: 'user', content: 'list tables' }] as Turn[],
      tools: turn.tools,
    });
    const toolMsg = findToolMessage(1, 't1');
    const payload = JSON.parse(toolMsg.content) as { tables: Array<{ name: string }> };
    const names = payload.tables.map((t) => t.name);
    expect(names).toContain('configuration_bindings');
    expect(names).toContain('calendar_events');
    memory.close();
  });
});
