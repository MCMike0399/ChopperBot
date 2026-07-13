import { Events, type Client, type Message, type OmitPartialGroupDMChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
} from '../capability.js';
import { CalendarStore } from '../calendar/store.js';
import { OutputChannelPublisher, type CalendarPublisher } from '../calendar/publisher.js';
import { parseChannelIdEnv } from '../file_scanner/store.js';
import { EVENT_INTAKE_MIGRATIONS, EventIntakeStore } from './store.js';
import { EventIntakeWatcher } from './watcher.js';

export const EVENT_INTAKE_CAPABILITY_ID = 'event_intake';

/** How long the watched-category set is cached before re-reading from SQLite. */
const WATCHED_CACHE_TTL_MS = 10_000;

/**
 * Passive capability that turns the ticket funnel into calendar events. Like
 * file_scanner it is NOT in the routing table: in `start()` it registers its
 * own MessageCreate listener over a watched set of ticket CATEGORIES. When the
 * ticket bot's request form lands it posts a normalized, conflict-checked
 * proposal; when a MODERATOR then talks to the bot in the ticket it creates the
 * real calendar event (reusing the calendar tools, so the PDF/ICS auto-publish).
 *
 * Needs no secret, so `init()` never throws — with no category configured it
 * simply idles until a mod points it at the ticket category via
 * `config_eventintake`.
 */
export class EventIntakeCapability implements Capability {
  readonly id = EVENT_INTAKE_CAPABILITY_ID;
  readonly description =
    'Recibe solicitudes de eventos por tickets: lee el formulario, publica una propuesta normalizada con chequeo de choques, y crea el evento en el calendario cuando un moderador lo aprueba (todo dentro del ticket). Pasivo: no requiere estar en la tabla de routing.';

  private store: EventIntakeStore | null = null;
  private db: Database.Database | null = null;
  private projectRoot = '.';
  private watcher: EventIntakeWatcher | null = null;
  private listener: ((message: OmitPartialGroupDMChannel<Message>) => void) | null = null;
  private boundClient: Client | null = null;
  private watchedCache: { ids: Set<string>; at: number } | null = null;

  async init({ memory, projectRoot }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, EVENT_INTAKE_MIGRATIONS);
    this.db = memory.db();
    this.store = new EventIntakeStore(this.db);
    this.projectRoot = projectRoot;
    this.store.seedWatchedCategories(parseChannelIdEnv(config.EVENT_INTAKE_TICKET_CATEGORY_IDS));
    this.store.seedModRoles(parseChannelIdEnv(config.EVENT_INTAKE_MOD_ROLES));
    log.info(
      { capability: this.id, watched: this.store.getWatchedCategories().length },
      'EventIntakeCapability initialized',
    );
  }

  async start({ client }: CapabilityStartDeps): Promise<void> {
    if (!this.store || !this.db) throw new Error('EventIntakeCapability.start() before init()');
    this.boundClient = client;
    const botUserId = client.user?.id ?? '';
    const calendarStore = new CalendarStore(this.db);
    const publisher = this.makePublisher(client, calendarStore);

    this.watcher = new EventIntakeWatcher({
      store: this.store,
      calendarStore,
      client,
      botUserId,
      ticketBotId: config.EVENT_INTAKE_TICKET_BOT_ID,
      getModRoles: () => this.store?.getModRoles() ?? [],
      publisher,
    });

    this.listener = (message: OmitPartialGroupDMChannel<Message>) => {
      try {
        if (message.author?.id === botUserId) return; // ignore our own posts
        if (!this.isClaimedChannel(message)) return;
        void this.watcher?.handleMessage(message);
      } catch (err) {
        log.error({ err }, 'event_intake.listener.error');
      }
    };
    client.on(Events.MessageCreate, this.listener);
    log.info(
      { capability: this.id, watched: this.store.getWatchedCategories() },
      'EventIntakeCapability listener registered',
    );
  }

  async buildTurn(): Promise<CapabilityTurnBundle> {
    return {
      system:
        'Eres ChopperBot. Esta capacidad (event_intake) es pasiva y trabaja dentro de los canales de ticket; no debería estar enlazada a un canal por routing. Responde brevemente en español.',
      tools: composeToolSources([]),
    };
  }

  async dispose(): Promise<void> {
    if (this.boundClient && this.listener) {
      this.boundClient.off(Events.MessageCreate, this.listener);
      this.listener = null;
    }
  }

  /**
   * Whether this message's channel is a watched ticket channel — used both by
   * the listener and by the main handler's `claimedChannel` guard (one method,
   * one 10 s cache, so the guard and the listener can never disagree). Matches
   * the message's category against the watched set, plus explicit channel ids
   * and the `all` / `guild:<id>` wildcards.
   */
  isClaimedChannel(message: Message): boolean {
    if (!this.store) return false;
    const now = Date.now();
    if (!this.watchedCache || now - this.watchedCache.at > WATCHED_CACHE_TTL_MS) {
      this.watchedCache = { ids: new Set(this.store.getWatchedCategories()), at: now };
    }
    const set = this.watchedCache.ids;
    if (set.size === 0) return false;
    if (set.has('all')) return true;
    if (set.has(message.channelId)) return true;
    const categoryId = resolveCategoryId(message);
    if (categoryId && set.has(categoryId)) return true;
    if (message.guildId && set.has(`guild:${message.guildId}`)) return true;
    return false;
  }

  private makePublisher(client: Client, store: CalendarStore): CalendarPublisher {
    return new OutputChannelPublisher({
      client,
      store,
      projectRoot: this.projectRoot,
      getOutputChannelId: () =>
        store.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID ?? null,
    });
  }
}

/**
 * The category id a message belongs to: a text channel's `parentId` IS its
 * category; a thread/forum post's category is its parent channel's `parentId`.
 */
function resolveCategoryId(message: Message): string | null {
  const channel = message.channel;
  if (channel.isThread()) return channel.parent?.parentId ?? null;
  const parentId = (channel as { parentId?: string | null }).parentId;
  return parentId ?? null;
}
