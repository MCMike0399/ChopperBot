import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import type { UserDirectory } from '../../users/store.js';
import { CONFIGURATION_CAPABILITY_ID } from './constants.js';
import { CONFIGURATION_MIGRATIONS, ConfigurationStore } from './store.js';
import { ConfigurationToolSource } from './source.js';
import { ConfigInstagramAdminSource } from './instagram-admin-source.js';
import { ConfigCalendarAdminSource } from './calendar-admin-source.js';
import { ConfigDbSource } from './db-source.js';
import { renderConfigurationPrompt } from './preamble.js';

/**
 * Admin / config console capability. Lives in a single hardcoded channel and
 * exposes tools that mutate the channel→capability routing table (persisted
 * in SQLite + applied to the live router), inspect the DB, surface bot
 * health, and perform scoped data admin.
 *
 * Unlike Calendar or instagram_monitor, this capability needs handles to the registry,
 * the mutable router, and the Discord client. Those are passed via the
 * lazy getters in `CapabilityInitDeps`. They are guaranteed populated by the
 * time `buildTurn` runs (post-bootstrap).
 */
export class ConfigurationCapability implements Capability {
  readonly id = CONFIGURATION_CAPABILITY_ID;
  readonly description =
    'Admin console. Manage channel→capability bindings, inspect the DB, and run scoped data admin from a single Discord channel.';

  private store: ConfigurationStore | null = null;
  private db: Database.Database | null = null;
  private getDiscordClient: CapabilityInitDeps['getDiscordClient'] = undefined;
  private getRegistry: CapabilityInitDeps['getRegistry'] = undefined;
  private getRouter: CapabilityInitDeps['getRouter'] = undefined;
  private getUserDirectory: CapabilityInitDeps['getUserDirectory'] = undefined;
  private readonly startedAtMs = Date.now();
  private dbPath = '';

  async init(deps: CapabilityInitDeps): Promise<void> {
    await deps.memory.migrate(this.id, CONFIGURATION_MIGRATIONS);
    this.db = deps.memory.db();
    this.store = new ConfigurationStore(this.db);
    this.getDiscordClient = deps.getDiscordClient;
    this.getRegistry = deps.getRegistry;
    this.getRouter = deps.getRouter;
    this.getUserDirectory = deps.getUserDirectory;
    this.dbPath = resolve(deps.projectRoot, config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
    log.info({ capability: this.id }, 'ConfigurationCapability initialized');
  }

  /**
   * Exposed for app.ts so the bootstrap can read/seed bindings before the
   * router is built. After bootstrap, the same store is reused inside
   * `buildTurn` via the tool source.
   */
  bootStore(): ConfigurationStore {
    if (!this.store) throw new Error('ConfigurationCapability not initialized');
    return this.store;
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store || !this.db) {
      throw new Error('ConfigurationCapability.buildTurn called before init');
    }
    if (
      !this.getDiscordClient ||
      !this.getRegistry ||
      !this.getRouter ||
      !this.getUserDirectory
    ) {
      throw new Error(
        'ConfigurationCapability missing admin handles (registry/router/client/userDirectory)',
      );
    }
    const userDirectory: UserDirectory = this.getUserDirectory();
    const core = new ConfigurationToolSource({
      store: this.store,
      db: this.db,
      registry: this.getRegistry(),
      router: this.getRouter(),
      client: this.getDiscordClient(),
      userDirectory,
      callerUserId: ctx.userId,
      startedAtMs: this.startedAtMs,
      dbPath: this.dbPath,
    });
    const instagram = new ConfigInstagramAdminSource({
      db: this.db,
      callerUserId: ctx.userId,
    });
    const calendar = new ConfigCalendarAdminSource({
      db: this.db,
      userDirectory,
      callerUserId: ctx.userId,
    });
    const database = new ConfigDbSource({ db: this.db, store: this.store });
    return {
      system: renderConfigurationPrompt(ctx.now),
      tools: composeToolSources([core, instagram, calendar, database]),
    };
  }
}
