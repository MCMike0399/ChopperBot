import { PermissionFlagsBits, type Client, type Message } from 'discord.js';
import { log } from '../../log.js';
import type { FileScannerStore } from './store.js';
import { FileScanner, downloadAttachment, type ScanOutcome } from './scanner.js';
import { isImageAttachment, isVideoAttachment, renderScanMessage, type FileLine } from './format.js';

/** Minimal shape of a Discord attachment we care about (also what tests pass). */
export interface AttachmentLike {
  name: string;
  size: number;
  url: string;
  contentType: string | null;
}

/** Alert dedup: one budget/auth admin alert per this window. */
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface FileScanWatcherDeps {
  scanner: FileScanner;
  store: FileScannerStore;
  client: Client;
  maxFileBytes: number;
  maxFiles: number;
  /** Sends operator alerts (budget exhausted / VT auth). Errors swallowed by caller. */
  alert: (lines: string[]) => Promise<void>;
  now?: () => number;
}

/**
 * The passive "hook": decides which uploaded files to scan, posts a friendly
 * progress reply, and edits it in place as each file resolves into a verdict.
 * All work is wrapped so a failure never propagates into the Discord gateway.
 */
export class FileScanWatcher {
  private readonly now: () => number;
  private lastAlertAt = 0;

  constructor(private readonly deps: FileScanWatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Entry point wired to Events.MessageCreate for watched channels. */
  async handleMessage(message: Message): Promise<void> {
    const attachments: AttachmentLike[] = [...message.attachments.values()].map((a) => ({
      name: a.name,
      size: a.size,
      url: a.url,
      contentType: a.contentType,
    }));
    const toScan = selectScannable(attachments, {
      maxFileBytes: this.deps.maxFileBytes,
      maxFiles: this.deps.maxFiles,
    });
    if (toScan.length === 0) return;

    // If we can't post the verdict, don't burn a VirusTotal budget call or leave
    // a confusing react-then-unreact with no result. Surface the misconfig in the
    // logs instead — this is almost always a missing "Send Messages in Threads"
    // (forum posts/threads) or "Send Messages" permission on the channel.
    if (!this.canPostVerdict(message)) {
      log.warn(
        { channelId: message.channelId, guildId: message.guildId },
        'file_scanner.watcher.cannot_send',
      );
      return;
    }

    const reaction = await message.react('🔬').catch(() => null);
    const lines: FileLine[] = toScan.map((a) => ({ fileName: a.name, status: { phase: 'queued' } }));

    let reply: Message | null = null;
    try {
      reply = await this.postInitial(message, lines);

      for (let i = 0; i < toScan.length; i++) {
        const att = toScan[i];
        lines[i].status = { phase: 'scanning' };
        await this.edit(reply, lines);

        const outcome = await this.scanOne(att, message.author?.id ?? null);
        lines[i].status = outcome;
        await this.edit(reply, lines);
        await this.maybeAlert(outcome, att.name);
      }
    } catch (err) {
      log.error({ err, channelId: message.channelId }, 'file_scanner.watcher.error');
    } finally {
      if (reaction && this.deps.client.user) {
        await reaction.users.remove(this.deps.client.user.id).catch(() => {});
      }
    }
  }

  /**
   * Whether the bot can actually post a verdict in this message's channel.
   * Threads and forum posts require `SendMessagesInThreads`, which is a DISTINCT
   * permission from `SendMessages` (enabling only the latter won't let the bot
   * reply inside a thread/forum). Returns true when permissions can't be
   * resolved — we never block on uncertainty, only on a positive denial.
   */
  private canPostVerdict(message: Message): boolean {
    if (!message.inGuild()) return true;
    const me = message.guild.members.me;
    if (!me) return true;
    const perms = message.channel.permissionsFor(me);
    if (!perms) return true;
    const needed = message.channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages;
    return perms.has(needed);
  }

  /**
   * Post the initial progress message. Prefer a reply (threads the verdict under
   * the upload), but a reply carries a `message_reference` that Discord only
   * accepts with `ReadMessageHistory` — so when we lack it we skip straight to a
   * plain `channel.send()` (which doesn't need it) instead of a guaranteed-to-
   * fail reply. A `.catch` fallback still covers any unexpected reply failure.
   */
  private async postInitial(message: Message, lines: FileLine[]): Promise<Message | null> {
    const content = renderScanMessage(lines);
    if (this.canReplyWithReference(message)) {
      const reply = await message.reply(content).catch((err) => {
        log.warn({ err, channelId: message.channelId }, 'file_scanner.watcher.reply_failed');
        return null;
      });
      if (reply) return reply;
    }
    if (!message.channel.isSendable()) return null;
    return await message.channel.send(content).catch((err) => {
      log.warn({ err, channelId: message.channelId }, 'file_scanner.watcher.send_failed');
      return null;
    });
  }

  /**
   * Whether a reply-with-reference will be accepted here: Discord requires
   * `ReadMessageHistory` to attach a `message_reference`. Returns true when
   * permissions can't be resolved (we optimistically try the reply then).
   */
  private canReplyWithReference(message: Message): boolean {
    if (!message.inGuild()) return true;
    const me = message.guild.members.me;
    if (!me) return true;
    const perms = message.channel.permissionsFor(me);
    if (!perms) return true;
    return perms.has(PermissionFlagsBits.ReadMessageHistory);
  }

  private async scanOne(att: AttachmentLike, uploader: string | null): Promise<ScanOutcome> {
    try {
      const bytes = await downloadAttachment(att.url);
      return await this.deps.scanner.scanBytes(bytes, { fileName: att.name, uploader });
    } catch (err) {
      log.error({ err, fileName: att.name }, 'file_scanner.watcher.download_failed');
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async edit(reply: Message | null, lines: FileLine[]): Promise<void> {
    if (!reply) return;
    await reply.edit(renderScanMessage(lines)).catch(() => {});
  }

  /** One operator alert per cooldown window on budget-exhaustion or a bad API key. */
  private async maybeAlert(outcome: ScanOutcome, fileName: string): Promise<void> {
    const now = this.now();
    const isAuth = outcome.kind === 'error' && outcome.authError === true;
    const isBudget = outcome.kind === 'budget_exhausted';
    if (!isAuth && !isBudget) return;
    if (now - this.lastAlertAt < ALERT_COOLDOWN_MS) return;
    this.lastAlertAt = now;
    if (isBudget) this.deps.store.markBudgetAlert(now);
    const lines = isAuth
      ? [
          '🛑 **File scanner: VirusTotal rechazó la API key**',
          `Archivo afectado: \`${fileName}\`.`,
          'Revisa `VIRUSTOTAL_API_KEY` en `.env` (¿caducó o es inválida?), luego `pnpm run build && systemctl --user restart chopperbot.service`.',
        ]
      : [
          'ℹ️ **File scanner: presupuesto diario de VirusTotal agotado**',
          'Se alcanzó el límite de peticiones en la ventana de 24 h; los análisis se pausan y se reanudan solos conforme se vacía la ventana.',
          'Si pasa seguido, sube `VIRUSTOTAL_DAILY_REQUEST_BUDGET` (el plan gratuito permite 500/día).',
        ];
    await this.deps.alert(lines).catch(() => {});
  }
}

/**
 * Pick the attachments worth scanning: skip images and videos (quota
 * protection), skip empty or oversized files, and cap the count per message.
 * Pure — unit-tested without Discord.
 */
export function selectScannable(
  attachments: AttachmentLike[],
  opts: { maxFileBytes: number; maxFiles: number },
): AttachmentLike[] {
  const out: AttachmentLike[] = [];
  for (const a of attachments) {
    if (out.length >= opts.maxFiles) break;
    if (a.size <= 0 || a.size > opts.maxFileBytes) continue;
    if (isImageAttachment(a.name, a.contentType)) continue;
    if (isVideoAttachment(a.name, a.contentType)) continue;
    out.push(a);
  }
  return out;
}
