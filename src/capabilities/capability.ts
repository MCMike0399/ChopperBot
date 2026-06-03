import type { Client } from 'discord.js';
import type { ComposedTools } from '../tools/source.js';
import type { MemoryStore } from '../memory/store.js';
import type { UserDirectory } from '../users/store.js';
import type { CapabilityRegistry } from './registry.js';
import type { MutableCapabilityRouter } from './routing.js';

/**
 * A Capability bundles one coherent mode of the bot: a system prompt, a set
 * of tool sources (Actionables), an optional set of Contextables (managed
 * privately by the capability — the framework does not see them), and a
 * private MemoryStore namespace. One Discord channel runs exactly one
 * Capability.
 */
export interface Capability {
  /** Stable id used in config maps, logs, and memory namespace. e.g. "calendar". */
  readonly id: string;
  /** Human-readable description, used in logs and (eventually) /capabilities introspection. */
  readonly description: string;

  /**
   * Bot-lifetime init. Called once at boot, BEFORE Discord login.
   * Use for: loading markdown, running migrations, warming caches.
   * Throw to skip registering this capability (others continue).
   */
  init(deps: CapabilityInitDeps): Promise<void>;

  /**
   * Per-turn bundle. Called on EVERY user message. The capability decides
   * whether to return a cached bundle (static prompt + static tools) or
   * rebuild with live data (e.g. a fresh snapshot of upcoming calendar
   * events in the system prompt). The framework does not cache this.
   */
  buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle>;

  /**
   * Post-Discord-login startup hook. Called once after `client.login()`
   * succeeds, in registry order. Use for autonomous background work that
   * needs the Discord client to be connected — e.g. a scheduler that polls
   * an external API and posts alerts to a channel. The framework ignores
   * thrown errors here (logged + capability stays registered).
   */
  start?(deps: CapabilityStartDeps): Promise<void>;

  /** Bot shutdown — close DB handles, flush state. Optional. */
  dispose?(): Promise<void>;
}

export interface CapabilityInitDeps {
  /** Namespaced memory store for this capability. */
  memory: MemoryStore;
  /** Repository root, useful for resolving context/ and other on-disk paths. */
  projectRoot: string;
  /**
   * Optional lazy handles for admin-style capabilities (e.g. configuration).
   * The values these return are only meaningful AFTER bootstrap completes —
   * capabilities that close over them should call them at `buildTurn` time,
   * not inside `init()`. Most capabilities leave these untouched.
   */
  getDiscordClient?: () => Client;
  getRegistry?: () => CapabilityRegistry;
  getRouter?: () => MutableCapabilityRouter;
  /**
   * Framework-level Discord-user directory (lazy: only available after
   * bootstrap completes). Capabilities that scope state per user can capture
   * this in `init()` and call it at `buildTurn` time to look up tags,
   * first-seen timestamps, etc. The user record for the *calling* user is
   * already populated by the message handler before `buildTurn` runs.
   */
  getUserDirectory?: () => UserDirectory;
}

/**
 * Dependencies passed to `start()`. Unlike `init()`, by the time `start()`
 * runs the Discord client is logged in, the router exists, and the registry
 * is fully populated — so the handles are plain references, not lazy getters.
 */
export interface CapabilityStartDeps {
  client: Client;
  registry: CapabilityRegistry;
  router: MutableCapabilityRouter;
  userDirectory: UserDirectory;
}

/** Per-turn context derived from the Discord message. */
export interface CapabilityTurnContext {
  channelId: string;
  guildId: string | null;
  userId: string;
  userTag: string;
  /** Injected (not Date.now()) so capabilities are testable with frozen time. */
  now: Date;
}

/** What a Capability returns to the orchestrator each turn. */
export interface CapabilityTurnBundle {
  /** The full system prompt for this turn. */
  system: string;
  /** Already collision-checked, ready to pass to llm/client.ts:ask(). */
  tools: ComposedTools;
}
