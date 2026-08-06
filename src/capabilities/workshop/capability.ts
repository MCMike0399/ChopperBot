import { resolve } from 'node:path';
import {
  Events,
  type Client,
  type Interaction,
  type Message,
  type MessageReaction,
  type NonThreadGuildBasedChannel,
  type OmitPartialGroupDMChannel,
  type PartialMessageReaction,
  type PartialUser,
  type User,
  type DMChannel,
} from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type { TurnQueue } from '../../discord/turn-queue.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
} from '../capability.js';
import { WORKSHOP_CAPABILITY_ID } from './constants.js';
import { WORKSHOP_MIGRATIONS, WorkshopStore } from './store.js';
import { WorkshopWatcher } from './watcher.js';

/** How long the active-session channel set is cached before re-reading SQLite. */
const SESSION_CACHE_TTL_MS = 10_000;

/**
 * Private LLM workshop sessions ("Escuela/trabajo"). Passive, like
 * file_scanner/event_intake: never in the routing table. A member reacts to
 * the bot's welcome message in the configured WELCOME channel → the bot
 * creates a private text channel under the configured CATEGORY where that
 * member chats with the bot like a web LLM (every message answered, no
 * mention needed), with sandboxed Python + document skills and its own
 * session lifecycle (clear/close via buttons or natural language).
 *
 * Needs no secret, so init() never throws — unconfigured it simply idles.
 */
export class WorkshopCapability implements Capability {
  readonly id = WORKSHOP_CAPABILITY_ID;
  readonly description =
    'Talleres privados de escuela/trabajo: reacciona en el canal de bienvenida y obtén un canal personal con un asistente de IA completo (Python sandboxeado, genera Excel/Word/PowerPoint/gráficas, procesa tus archivos). Pasivo: no requiere routing.';

  private store: WorkshopStore | null = null;
  private watcher: WorkshopWatcher | null = null;
  private dataDir = './data';
  private boundClient: Client | null = null;
  private messageListener: ((m: OmitPartialGroupDMChannel<Message>) => void) | null = null;
  private reactionListener:
    | ((r: MessageReaction | PartialMessageReaction, u: User | PartialUser) => void)
    | null = null;
  private interactionListener: ((i: Interaction) => void) | null = null;
  private channelDeleteListener: ((c: DMChannel | NonThreadGuildBasedChannel) => void) | null = null;
  private sessionCache: { ids: Set<string>; at: number } | null = null;

  constructor(private readonly turnQueue: TurnQueue) {}

  async init({ memory, projectRoot }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, WORKSHOP_MIGRATIONS);
    this.store = new WorkshopStore(memory.db());
    this.dataDir = resolve(projectRoot, config.CHOPPERBOT_DATA_DIR);
    this.store.seedSettings({
      welcomeChannelId: config.WORKSHOP_WELCOME_CHANNEL_ID,
      categoryId: config.WORKSHOP_CATEGORY_ID,
    });
    const settings = this.store.getSettings();
    log.info(
      {
        capability: this.id,
        welcomeChannel: settings.welcome_channel_id,
        category: settings.category_id,
        activeSessions: this.store.countSessions().active,
      },
      'WorkshopCapability initialized',
    );
  }

  async start({ client }: CapabilityStartDeps): Promise<void> {
    if (!this.store) throw new Error('WorkshopCapability.start() before init()');
    this.boundClient = client;
    this.watcher = new WorkshopWatcher({
      client,
      store: this.store,
      turnQueue: this.turnQueue,
      dataDir: this.dataDir,
      reactionEmoji: () => this.store?.getSettings().reaction_emoji ?? '🎓',
      maxSessionsPerUser: config.WORKSHOP_MAX_SESSIONS_PER_USER,
      pyTimeoutMs: config.WORKSHOP_PY_TIMEOUT_S * 1000,
      onSessionsChanged: () => this.invalidateSessionCache(),
    });

    this.messageListener = (message: OmitPartialGroupDMChannel<Message>) => {
      try {
        if (message.author?.bot) return;
        if (!this.isSessionChannel(message.channelId)) return;
        void this.watcher?.handleMessage(message);
      } catch (err) {
        log.error({ err }, 'workshop.listener.error');
      }
    };
    this.reactionListener = (reaction, user) => {
      void this.watcher?.handleReaction(reaction, user);
    };
    this.interactionListener = (interaction: Interaction) => {
      void this.watcher?.handleInteraction(interaction);
    };
    this.channelDeleteListener = (channel) => {
      try {
        this.watcher?.handleChannelDelete(channel.id);
        this.sessionCache = null;
      } catch (err) {
        log.error({ err }, 'workshop.channel_delete.error');
      }
    };
    client.on(Events.MessageCreate, this.messageListener);
    client.on(Events.MessageReactionAdd, this.reactionListener);
    client.on(Events.InteractionCreate, this.interactionListener);
    client.on(Events.ChannelDelete, this.channelDeleteListener);

    await this.watcher.ensureWelcomeMessage();
    log.info(
      { capability: this.id, activeSessions: this.store.countSessions().active },
      'WorkshopCapability listeners registered',
    );
  }

  async buildTurn(): Promise<CapabilityTurnBundle> {
    return {
      system:
        'Eres ChopperBot. Esta capacidad (workshop) es pasiva y trabaja dentro de los canales de taller; no debería estar enlazada a un canal por routing. Responde brevemente en español.',
      tools: composeToolSources([]),
    };
  }

  async dispose(): Promise<void> {
    if (!this.boundClient) return;
    if (this.messageListener) this.boundClient.off(Events.MessageCreate, this.messageListener);
    if (this.reactionListener) this.boundClient.off(Events.MessageReactionAdd, this.reactionListener);
    if (this.interactionListener)
      this.boundClient.off(Events.InteractionCreate, this.interactionListener);
    if (this.channelDeleteListener)
      this.boundClient.off(Events.ChannelDelete, this.channelDeleteListener);
  }

  /**
   * Whether a channel is an ACTIVE workshop session — used by the listener
   * and by the main handler's `claimedChannel` guard (one method, one 10 s
   * cache, so they can never disagree). Sessions are created/closed rarely,
   * and creation invalidates by TTL within ~10 s (the intro message the bot
   * posts makes the session usable immediately anyway — the first user
   * message typically lands after that).
   */
  isSessionChannel(channelId: string): boolean {
    if (!this.store) return false;
    const now = Date.now();
    if (!this.sessionCache || now - this.sessionCache.at > SESSION_CACHE_TTL_MS) {
      this.sessionCache = { ids: new Set(this.store.activeChannelIds()), at: now };
    }
    return this.sessionCache.ids.has(channelId);
  }

  /** Invalidate the session-channel cache (after admin close, etc.). */
  invalidateSessionCache(): void {
    this.sessionCache = null;
  }

  /** For the admin source: close a session from the config channel. */
  async adminCloseSession(channelId: string): Promise<boolean> {
    const ok = (await this.watcher?.closeSession(channelId, 'admin')) ?? false;
    this.invalidateSessionCache();
    return ok;
  }

  /** For the admin source: repost/ensure the welcome message. */
  async adminEnsureWelcome(): Promise<void> {
    await this.watcher?.ensureWelcomeMessage();
  }
}
