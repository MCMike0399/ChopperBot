import { Events, type Client, type Message } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import { sendAdminAlert } from '../../discord/admin-alert.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
} from '../capability.js';
import { FILE_SCANNER_MIGRATIONS, FileScannerStore, parseChannelIdEnv } from './store.js';
import { VirusTotalClient } from './virustotal.js';
import { ScanRateLimiter } from './rate-limiter.js';
import { FileScanner } from './scanner.js';
import { FileScanWatcher } from './watcher.js';
import { renderFileScannerPrompt } from './preamble.js';

export const FILE_SCANNER_CAPABILITY_ID = 'file_scanner';

/** How long the watched-channel set is cached before re-reading from SQLite. */
const WATCHED_CACHE_TTL_MS = 10_000;

/**
 * Passive file-scanning capability. Unlike the routed capabilities, this one is
 * NOT bound to a channel: it registers its own MessageCreate listener in
 * `start()` and scans non-image uploads in a configurable set of channels,
 * regardless of what capability (if any) those channels are bound to. This lets
 * scanning coexist with chat/calendar/IG in the same channel.
 *
 * Self-disables (throws in init → not registered) when `VIRUSTOTAL_API_KEY` is
 * unset, exactly like the IG monitor degrades without cookies.
 */
export class FileScannerCapability implements Capability {
  readonly id = FILE_SCANNER_CAPABILITY_ID;
  readonly description =
    'Analiza automáticamente los archivos (no imágenes) subidos a los canales vigilados con VirusTotal y publica un veredicto (limpio/sospechoso/malicioso). Pasivo: no requiere menciones.';

  private store: FileScannerStore | null = null;
  private scanner: FileScanner | null = null;
  private watcher: FileScanWatcher | null = null;
  private listener: ((message: Message) => void) | null = null;
  private boundClient: Client | null = null;
  private watchedCache: { ids: Set<string>; at: number } | null = null;

  async init({ memory }: CapabilityInitDeps): Promise<void> {
    if (!config.VIRUSTOTAL_API_KEY) {
      log.warn(
        { capability: this.id },
        'file_scanner disabled: VIRUSTOTAL_API_KEY not set. Set it in .env to enable file scanning.',
      );
      throw new Error('VIRUSTOTAL_API_KEY not set');
    }

    await memory.migrate(this.id, FILE_SCANNER_MIGRATIONS);
    this.store = new FileScannerStore(memory.db());
    this.store.seedWatchedChannels(parseChannelIdEnv(config.FILE_SCANNER_CHANNEL_IDS));

    const client = new VirusTotalClient(config.VIRUSTOTAL_API_KEY);
    const limiter = new ScanRateLimiter({
      store: this.store,
      dailyBudget: config.VIRUSTOTAL_DAILY_REQUEST_BUDGET,
      minIntervalMs: config.VIRUSTOTAL_MIN_REQUEST_INTERVAL_MS,
    });
    this.scanner = new FileScanner({
      client,
      limiter,
      store: this.store,
      maliciousThreshold: config.VIRUSTOTAL_MALICIOUS_THRESHOLD,
      maxPolls: config.VIRUSTOTAL_MAX_POLLS,
    });
    log.info(
      { capability: this.id, watched: this.store.getWatchedChannels().length },
      'FileScannerCapability initialized (VirusTotal enabled)',
    );
  }

  async start({ client }: CapabilityStartDeps): Promise<void> {
    if (!this.store || !this.scanner) {
      throw new Error('FileScannerCapability.start() called before init()');
    }
    this.boundClient = client;
    this.watcher = new FileScanWatcher({
      scanner: this.scanner,
      store: this.store,
      client,
      maxFileBytes: config.VIRUSTOTAL_MAX_FILE_BYTES,
      maxFiles: config.MAX_ATTACHMENT_COUNT,
      alert: (lines) => sendAdminAlert(client, lines, 'file_scanner.alert'),
    });

    // Dedicated listener (independent of the main mention-gated handler). We
    // only act when a non-bot message with attachments lands in a watched
    // channel; everything else returns immediately. Never throws into the
    // gateway.
    this.listener = (message: Message) => {
      try {
        if (message.author?.bot) return;
        if (message.attachments.size === 0) return;
        if (!this.isWatched(message.channelId, message.guildId)) return;
        void this.watcher?.handleMessage(message);
      } catch (err) {
        log.error({ err }, 'file_scanner.listener.error');
      }
    };
    client.on(Events.MessageCreate, this.listener);
    log.info(
      { capability: this.id, watched: this.store.getWatchedChannels() },
      'FileScannerCapability listener registered',
    );
  }

  async buildTurn(): Promise<CapabilityTurnBundle> {
    return { system: renderFileScannerPrompt(), tools: composeToolSources([]) };
  }

  async dispose(): Promise<void> {
    if (this.boundClient && this.listener) {
      this.boundClient.off(Events.MessageCreate, this.listener);
      this.listener = null;
    }
  }

  /**
   * Whether a message's channel should be scanned, with a short TTL cache
   * (avoids a DB read per message). The watched set may contain, besides plain
   * channel ids: `all` (every channel the bot can see, across all guilds) and
   * `guild:<guildId>` (every channel the bot can see in that one guild). Since
   * the bot only receives MessageCreate for channels it has access to, these
   * wildcards naturally scope to "everywhere ChopperBot can read".
   */
  private isWatched(channelId: string, guildId: string | null): boolean {
    const now = Date.now();
    if (!this.watchedCache || now - this.watchedCache.at > WATCHED_CACHE_TTL_MS) {
      this.watchedCache = { ids: new Set(this.store!.getWatchedChannels()), at: now };
    }
    const set = this.watchedCache.ids;
    if (set.has('all')) return true;
    if (set.has(channelId)) return true;
    if (guildId && set.has(`guild:${guildId}`)) return true;
    return false;
  }
}
