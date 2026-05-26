/**
 * GeneralChatCapability — buildTurn produces a system prompt that snapshots
 * the other registered capabilities and where they live. No tools, so we
 * don't need to mock the OpenAI client or drive the agent loop.
 */
import { describe, test, expect } from 'vitest';
import type { Client, Guild, TextChannel } from 'discord.js';

import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { CapabilityRegistry } from '../../registry.js';
import { buildRouter, type MutableCapabilityRouter } from '../../routing.js';
import { CalendarCapability } from '../../calendar/capability.js';
import { ConfigurationCapability } from '../../configuration/capability.js';
import { GeneralChatCapability } from '../capability.js';
import { GENERAL_CHAT_CAPABILITY_ID } from '../constants.js';
import { FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS, UserDirectory } from '../../../users/store.js';
import type { Capability, CapabilityInitDeps } from '../../capability.js';

const NOW = new Date('2026-05-23T18:00:00.000Z');
const CALLER_USER = '50000000000000000099';
const GUILD_ID = '40000000000000000001';
const GUILD_NAME = 'TestGuild';
const CAL_CHANNEL_ID = '30000000000000000010';
const CAL_CHANNEL_NAME = 'agenda';
const MISSING_CHANNEL_ID = '30000000000000000099';

function makeFakeClient(): {
  client: Client;
  channels: Map<string, unknown>;
  guild: Guild;
} {
  const channels = new Map<string, unknown>();
  const guild = {
    id: GUILD_ID,
    name: GUILD_NAME,
    channels: { cache: new Map() },
  } as unknown as Guild;
  const client = {
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
    channels: { cache: channels },
  } as unknown as Client;
  return { client, channels, guild };
}

function seedTextChannel(
  channels: Map<string, unknown>,
  guild: Guild,
  channelId: string,
  channelName: string,
): void {
  const channel = {
    id: channelId,
    name: channelName,
    guild,
  } as unknown as TextChannel;
  channels.set(channelId, channel);
}

/**
 * A minimal stub capability for the "unbound" test. Avoids depending on a
 * real capability's `init()` side-effects.
 */
class StubCapability implements Capability {
  constructor(
    public readonly id: string,
    public readonly description: string,
  ) {}
  async init(): Promise<void> {}
  async buildTurn(): Promise<never> {
    throw new Error('not used in these tests');
  }
}

interface Harness {
  memory: SqliteMemoryStore;
  registry: CapabilityRegistry;
  router: MutableCapabilityRouter;
  client: Client;
  channels: Map<string, unknown>;
  guild: Guild;
  generalCap: GeneralChatCapability;
  configCap: ConfigurationCapability;
  calCap: CalendarCapability;
}

async function buildHarness(): Promise<Harness> {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  const userDirectory = new UserDirectory(memory.db());

  const registry = new CapabilityRegistry();
  let router: MutableCapabilityRouter | null = null;

  const { client, channels, guild } = makeFakeClient();

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

  const configCap = new ConfigurationCapability();
  const calCap = new CalendarCapability();
  const generalCap = new GeneralChatCapability();
  await configCap.init(initDeps(configCap.id));
  await calCap.init(initDeps(calCap.id));
  await generalCap.init(initDeps(generalCap.id));
  registry.register(configCap);
  registry.register(calCap);
  registry.register(generalCap);

  const channelMap = configCap.bootStore().loadBootBindings(new Map());
  router = buildRouter(channelMap);

  return { memory, registry, router, client, channels, guild, generalCap, configCap, calCap };
}

async function callBuildTurn(h: Harness) {
  return h.generalCap.buildTurn({
    channelId: '30000000000000000000',
    guildId: GUILD_ID,
    userId: CALLER_USER,
    userTag: 'tester#0001',
    now: NOW,
  });
}

describe('GeneralChatCapability — snapshot rendering', () => {
  test('lists registered capabilities but excludes self and configuration', async () => {
    const h = await buildHarness();
    const turn = await callBuildTurn(h);
    expect(turn.system).toContain('calendar');
    expect(turn.system).not.toContain(`**${GENERAL_CHAT_CAPABILITY_ID}**`);
    expect(turn.system).not.toContain('**configuration**');
    h.memory.close();
  });

  test('bound channel renders with channel name, guild name, and a Discord deep link', async () => {
    const h = await buildHarness();
    seedTextChannel(h.channels, h.guild, CAL_CHANNEL_ID, CAL_CHANNEL_NAME);
    h.router.setBinding(CAL_CHANNEL_ID, 'calendar');

    const turn = await callBuildTurn(h);
    expect(turn.system).toContain(`#${CAL_CHANNEL_NAME}`);
    expect(turn.system).toContain(GUILD_NAME);
    expect(turn.system).toContain(`https://discord.com/channels/${GUILD_ID}/${CAL_CHANNEL_ID}`);
    h.memory.close();
  });

  test('capability with zero bindings renders with the unbound marker', async () => {
    const h = await buildHarness();
    h.registry.register(new StubCapability('reports', 'Reportes diarios automáticos.'));
    const turn = await callBuildTurn(h);
    expect(turn.system).toContain('**reports**');
    expect(turn.system).toContain('sin canal asignado');
    h.memory.close();
  });

  test('cache-miss on the bound channel renders the inaccessible fallback and emits no Discord URL', async () => {
    const h = await buildHarness();
    // Bind a channel that is NOT in client.channels.cache.
    h.router.setBinding(MISSING_CHANNEL_ID, 'calendar');

    const turn = await callBuildTurn(h);
    const calLine = turn.system
      .split('\n')
      .find((line) => line.includes('**calendar**'));
    expect(calLine).toBeDefined();
    expect(calLine!).toContain(`canal no accesible, id: ${MISSING_CHANNEL_ID}`);
    expect(calLine!).not.toContain('https://discord.com/channels/');
    h.memory.close();
  });

  test('the tool bundle is empty (general_chat has no tools)', async () => {
    const h = await buildHarness();
    const turn = await callBuildTurn(h);
    expect(turn.tools.tools).toHaveLength(0);
    h.memory.close();
  });
});
