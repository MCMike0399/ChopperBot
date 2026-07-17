import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Client } from 'discord.js';
import { config, getChannelCapabilityMap } from './config.js';
import { log } from './log.js';
import { SqliteMemoryStore, NamespacedMemory } from './memory/store.js';
import { FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS, UserDirectory } from './users/store.js';
import { CapabilityRegistry } from './capabilities/registry.js';
import { buildRouter, type MutableCapabilityRouter } from './capabilities/routing.js';
import type { Capability, CapabilityInitDeps } from './capabilities/capability.js';
import { CalendarCapability } from './capabilities/calendar/capability.js';
import { ConfigurationCapability } from './capabilities/configuration/capability.js';
import { GeneralChatCapability } from './capabilities/general_chat/capability.js';
import { InstagramMonitorCapability } from './capabilities/instagram_monitor/capability.js';
import { FileScannerCapability } from './capabilities/file_scanner/capability.js';
import { EventIntakeCapability } from './capabilities/event_intake/capability.js';
import { SancusOpsCapability } from './capabilities/sancus_ops/capability.js';
import { createClient } from './discord/client.js';
import { registerHandlers } from './discord/handlers.js';
import { sendAdminAlert } from './discord/admin-alert.js';
import { llmHealth } from './llm/health.js';
import { checkBootAndDetectCrash, markCleanShutdown } from './lifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

export async function run(): Promise<void> {
  // 0. Crash detection: did the previous run die without a clean shutdown?
  //    Checked first (consumes the markers); the alert posts after login.
  const dataDir = resolve(PROJECT_ROOT, config.CHOPPERBOT_DATA_DIR);
  const bootCheck = checkBootAndDetectCrash(dataDir);
  if (bootCheck.crashed) {
    log.warn({ suppressAlert: bootCheck.suppressAlert }, 'lifecycle.unclean_restart_detected');
  }

  // 1. Shared SQLite store. One file, namespaced per capability.
  const dbPath = resolve(PROJECT_ROOT, config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
  const memory = new SqliteMemoryStore({ path: dbPath });
  log.info({ dbPath }, 'Opened persistent memory store');

  // 1b. Framework-level user directory. Lives outside any capability namespace
  //     so every capability can scope state by Discord user id consistently.
  await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  const userDirectory = new UserDirectory(memory.db());
  log.info({ capability: FRAMEWORK_CAPABILITY_ID }, 'Framework user directory ready');

  // 2. Hoisted refs that lazy capability deps will capture. Populated in the
  //    bootstrap steps below — capabilities that call these getters during
  //    init() will throw, by design. Only `buildTurn` callsites are safe.
  let client: Client | null = null;
  let router: MutableCapabilityRouter | null = null;

  const registry = new CapabilityRegistry();
  const configCap = new ConfigurationCapability();
  // event_intake reuses the calendar's tables/tools, so it must init AFTER the
  // calendar capability (whose migrations create calendar_events et al.).
  const eventIntakeCap = new EventIntakeCapability();
  const candidates: Capability[] = [
    configCap,
    new CalendarCapability(),
    new InstagramMonitorCapability(),
    new FileScannerCapability(),
    eventIntakeCap,
    new SancusOpsCapability(),
    new GeneralChatCapability(),
  ];

  const initDepsFor = (cap: Capability): CapabilityInitDeps => ({
    memory: new NamespacedMemory(memory, cap.id),
    projectRoot: PROJECT_ROOT,
    getDiscordClient: () => {
      if (!client) throw new Error('Discord client not yet constructed');
      return client;
    },
    getRegistry: () => registry,
    getRouter: () => {
      if (!router) throw new Error('Router not yet built');
      return router;
    },
    getUserDirectory: () => userDirectory,
  });

  for (const cap of candidates) {
    try {
      await cap.init(initDepsFor(cap));
      registry.register(cap);
      log.info({ capability: cap.id, description: cap.description }, 'Capability initialized');
    } catch (err) {
      log.error({ err, capability: cap.id }, 'Capability failed to init — skipping');
    }
  }

  // 3. Bindings: env-var seed (one-time) → DB → force-bind the config channel.
  if (!registry.has(configCap.id)) {
    throw new Error(
      'ConfigurationCapability failed to initialize; cannot build the routing table. See earlier logs.',
    );
  }
  const envSeed = getChannelCapabilityMap();
  const channelMap = configCap.bootStore().loadBootBindings(envSeed);
  for (const [channelId, capabilityId] of channelMap) {
    if (!registry.has(capabilityId)) {
      log.warn(
        { channelId, capabilityId, registered: registry.list().map((c) => c.id) },
        'Channel mapped to unregistered capability — messages there will be ignored',
      );
    }
  }
  router = buildRouter(channelMap);
  log.info(
    {
      authorizedChannels: router.allChannelIds().size,
      capabilities: registry.list().map((c) => c.id),
      envSeedSize: envSeed.size,
    },
    'Router built',
  );

  // 4. Discord.
  client = createClient();
  registerHandlers(client, {
    registry,
    router,
    userDirectory,
    // Let event_intake own its ticket categories (its own listener replies
    // there) so the main mention handler doesn't also answer — no double-reply.
    claimedChannel: registry.has(eventIntakeCap.id)
      ? (message) => eventIntakeCap.isClaimedChannel(message)
      : undefined,
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    // Mark first: even if dispose/destroy below hang or throw, this exit was
    // operator-initiated, not a crash.
    try {
      markCleanShutdown(dataDir);
    } catch (err) {
      log.warn({ err }, 'lifecycle.clean_marker_failed');
    }
    for (const cap of registry.list()) {
      try {
        await cap.dispose?.();
      } catch (err) {
        log.warn({ err, capability: cap.id }, 'Capability dispose error');
      }
    }
    memory.close();
    if (client) await client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.DISCORD_TOKEN);

  // LLM health → admin channel. From here on, ask() failures (chat replies,
  // IG classifier) can page the operator instead of dying in the journal.
  {
    const c = client;
    llmHealth.setSink((lines) => sendAdminAlert(c, lines, 'llm.alert'));
  }

  if (bootCheck.crashed && !bootCheck.suppressAlert) {
    await sendAdminAlert(
      client,
      [
        '⚠️ **ChopperBot se reinició tras un fallo**',
        'El proceso anterior terminó sin un apagado limpio (crash, OOM o kill). systemd lo reinició automáticamente.',
        '',
        'Diagnóstico: `journalctl --user -u chopperbot -b --no-pager | tail -100` (busca `level: 50/60` o un stack trace al final del proceso anterior).',
        '(Si entra en bucle de reinicios, esta alerta se silencia a ~1 cada 15 min; systemd corta el bucle a los 10 reinicios en 5 min.)',
      ],
      'lifecycle.crash_alert',
    );
  }

  // 5. Post-login start hooks: capabilities that own background work (polling
  //    schedulers, etc.) start now that the Discord client is connected and
  //    the router has been built. Errors are isolated — a failing start() does
  //    not take down the bot or block sibling capabilities.
  for (const cap of registry.list()) {
    if (!cap.start) continue;
    try {
      await cap.start({ client, registry, router, userDirectory });
      log.info({ capability: cap.id }, 'Capability start() completed');
    } catch (err) {
      log.error({ err, capability: cap.id }, 'Capability start() failed');
    }
  }
}
