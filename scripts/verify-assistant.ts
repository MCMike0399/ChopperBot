// Drive the NEW general_chat community assistant end-to-end against the real
// model and the LIVE database, posting NOTHING: boots the real capability
// stack (config + calendar + general_chat), builds the actual turn bundle for
// a RevZ guild channel, and asks the real text model a few probe questions —
// including the exact one that exposed the old corporate deflection.
//
//   npx tsx scripts/verify-assistant.ts
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS, UserDirectory } from '../src/users/store.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { buildRouter, type MutableCapabilityRouter } from '../src/capabilities/routing.js';
import { ConfigurationCapability } from '../src/capabilities/configuration/capability.js';
import { CalendarCapability } from '../src/capabilities/calendar/capability.js';
import { GeneralChatCapability } from '../src/capabilities/general_chat/capability.js';
import { REVZ_GUILD_ID } from '../src/capabilities/general_chat/profile.js';
import type { Capability, CapabilityInitDeps } from '../src/capabilities/capability.js';
import { ask } from '../src/llm/client.js';

const GENERAL_CHANNEL_ID = '1437237844966899742';

const PROBES = [
  'cuéntame del servidor, dónde puedo ver los eventos de la semana y dónde puedo votar para las peliculas que veremos',
  '¿cómo agendo un evento en el calendario?',
  'jajaja eres un agente verdad',
];

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dbPath = resolve(here, '..', config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const memory = new SqliteMemoryStore({ path: dbPath });
  await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  const userDirectory = new UserDirectory(memory.db());

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((r) => (client.isReady() ? r() : client.once('clientReady', () => r())));
  // Warm the channel cache so the prompt's "estás hablando en #…" line renders.
  await client.channels.fetch(GENERAL_CHANNEL_ID).catch(() => null);

  try {
    const registry = new CapabilityRegistry();
    let router: MutableCapabilityRouter | null = null;
    const initDeps = (cap: Capability): CapabilityInitDeps => ({
      memory: new NamespacedMemory(memory, cap.id),
      projectRoot: resolve(here, '..'),
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
    for (const cap of [configCap, calCap, generalCap]) {
      await cap.init(initDeps(cap));
      registry.register(cap);
    }
    router = buildRouter(configCap.bootStore().loadBootBindings(new Map()));

    const turn = await generalCap.buildTurn({
      channelId: GENERAL_CHANNEL_ID,
      guildId: REVZ_GUILD_ID,
      userId: 'verify-script',
      userTag: 'verify#0000',
      now: new Date(),
    });
    console.log(`=== system prompt: ${turn.system.length} chars; tools: ${turn.tools.tools.map((t) => t.name).join(', ') || '(ninguna)'} ===\n`);

    for (const probe of PROBES) {
      console.log(`\n━━━ TÚ: ${probe}`);
      const reply = await ask({
        system: turn.system,
        messages: [{ role: 'user', content: probe }],
        tools: turn.tools,
      });
      console.log(`━━━ CHOPPERBOT: ${reply}`);
    }
    console.log('\n✅ verify-assistant terminó (nada fue publicado en Discord)');
  } finally {
    await client.destroy();
    memory.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
