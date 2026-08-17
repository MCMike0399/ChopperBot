import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  GuildScheduledEventStatus,
  type Guild,
  type GuildScheduledEvent,
  type Message,
  type VoiceBasedChannel,
} from 'discord.js';
import { log } from '../../log.js';
import { config } from '../../config.js';
import {
  ARTIFACTS,
  CAPTURE_FAILURE_ALARM_AFTER,
  EMPTY_CHANNEL_GRACE_MS,
  MIN_BURST_BYTES,
  SILENCE_END_MS,
} from './constants.js';
import type { PendingBurst } from './live.js';
import {
  burstCapturedNothing,
  CaptureHealth,
  pcmDurationMs,
  recordOpusStreamToPcm,
  sanitizeFileFragment,
} from './audio.js';
import type { MinutasSessionRow, MinutasStore } from './store.js';

/** Errors whose message is safe to show the member who ran the command. */
export class UserVisibleError extends Error {}

export interface ClosedSession {
  row: MinutasSessionRow;
  dir: string;
  reason: string;
}

/**
 * Raised once per session when consecutive bursts capture no audio at all.
 * The people in the room must find out while the meeting is still happening —
 * a minute that silently omits half an assembly is worse than none.
 */
export interface CaptureFailure {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  consecutiveFailures: number;
  lastFile: string;
}

interface ActiveSession {
  id: string;
  guild: Guild;
  channelId: string;
  channelName: string;
  dir: string;
  startedAtMs: number;
  startedBy: { id: string; tag: string };
  title: string | null;
  connection: VoiceConnection;
  participants: Map<string, string>;
  seq: number;
  openBursts: Map<string, Promise<void>>;
  maxTimer: NodeJS.Timeout | null;
  emptyTimer: NodeJS.Timeout | null;
  onSpeakStart: (userId: string) => void;
  closed: boolean;
  /** Tracks bursts that received packets but wrote no audio. */
  captureHealth: CaptureHealth;
}

/** Persisted to session.json — the finalize step's manifest on disk. */
export interface SessionManifest {
  id: string;
  guildId: string;
  channelId: string;
  channelName: string;
  title: string | null;
  startedBy: string;
  startedByTag: string | null;
  startedAt: number;
  participants: Record<string, string>;
}

/** One line per audio burst, appended when the burst OPENS (crash-safe: the
 * start time is what the timeline needs; bytes are stat'ed at finalize). */
export interface BurstManifestLine {
  seq: number;
  userId: string;
  speaker: string;
  file: string;
  startedAtMs: number;
}

function cdmxParts(now: Date): { date: string; compact: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    compact: `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`,
  };
}

export function newSessionId(now = new Date()): string {
  return `${cdmxParts(now).compact}-${randomBytes(2).toString('hex')}`;
}

/** MinIO key prefix for a session's artifacts (trailing slash included). */
export function minioPrefixFor(row: { id: string; guild_id: string; started_at: number }): string {
  const { date } = cdmxParts(new Date(row.started_at));
  return `minutas/${row.guild_id}/${date}/${row.id}/`;
}

/**
 * Owns the live recording sessions — at most one per guild. Joins the voice
 * connection, turns each speaker's voice into PCM burst files on disk,
 * captures the channel's text chat, and watches the conditions that end a
 * session without anyone typing the command (channel emptied, scheduled event
 * over, bot disconnected, max duration). Finalization lives in pipeline.ts;
 * the manager reports a closed session through `onClosed`.
 */
export class MinutasSessions {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly deps: {
      store: MinutasStore;
      /** Absolute dir under which per-session dirs are created. */
      sessionsDir: string;
      /** Fires once per closed session (async finalize — never awaited here). */
      onClosed: (closed: ClosedSession) => void;
      /** Fires once per session when audio capture has evidently died. */
      onCaptureFailure?: (failure: CaptureFailure) => void;
      /** A burst finished recording with usable audio — live transcription hook. */
      onBurstRecorded?: (dir: string, burst: PendingBurst) => void;
    },
  ) {}

  getActive(
    guildId: string,
  ): { id: string; channelId: string; channelName: string; startedAtMs: number } | null {
    const s = this.active.get(guildId);
    if (!s) return null;
    return { id: s.id, channelId: s.channelId, channelName: s.channelName, startedAtMs: s.startedAtMs };
  }

  /** Whether a message belongs to an active session's voice-channel chat. */
  isSessionChannel(channelId: string): boolean {
    for (const s of this.active.values()) if (s.channelId === channelId) return true;
    return false;
  }

  async start(params: {
    guild: Guild;
    channel: VoiceBasedChannel;
    startedBy: { id: string; tag: string };
    title?: string | null;
  }): Promise<MinutasSessionRow> {
    const { guild, channel } = params;
    if (this.active.has(guild.id) || this.deps.store.getActiveSessionForGuild(guild.id)) {
      throw new UserVisibleError(
        'Ya hay una grabación activa en este servidor — ciérrala con `/chopperbot-leave` antes de abrir otra.',
      );
    }
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(['ViewChannel', 'Connect'])) {
      throw new UserVisibleError(
        `No tengo permiso para ver/conectar a **${channel.name}**. Revisa los permisos del canal.`,
      );
    }

    const id = newSessionId();
    const dir = join(this.deps.sessionsDir, id);
    mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
    mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      // Recording requires undeafened; muted is fine (we never play audio).
      selfDeaf: false,
      selfMute: true,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      throw new UserVisibleError(
        `No pude conectar a **${channel.name}** (tiempo de espera agotado). Inténtalo de nuevo.`,
      );
    }

    const session: ActiveSession = {
      id,
      guild,
      channelId: channel.id,
      channelName: channel.name,
      dir,
      startedAtMs: Date.now(),
      startedBy: params.startedBy,
      title: params.title ?? null,
      connection,
      participants: new Map([[params.startedBy.id, params.startedBy.tag]]),
      seq: 0,
      openBursts: new Map(),
      maxTimer: null,
      emptyTimer: null,
      onSpeakStart: () => {},
      closed: false,
      captureHealth: new CaptureHealth(CAPTURE_FAILURE_ALARM_AFTER),
    };
    session.onSpeakStart = (userId) => this.onSpeakStart(session, userId);
    connection.receiver.speaking.on('start', session.onSpeakStart);

    session.maxTimer = setTimeout(() => {
      log.warn({ sessionId: id }, 'minutas.max_duration_reached');
      this.closeAndReport(guild.id, 'duración máxima alcanzada');
    }, config.MINUTAS_MAX_SESSION_MINUTES * 60_000);
    session.maxTimer.unref();

    this.active.set(guild.id, session);
    this.writeManifest(session);

    const row: MinutasSessionRow = {
      id,
      guild_id: guild.id,
      channel_id: channel.id,
      channel_name: channel.name,
      title: params.title ?? null,
      started_by: params.startedBy.id,
      started_by_tag: params.startedBy.tag,
      started_at: session.startedAtMs,
      ended_at: null,
      status: 'active',
      transcribe_after: null,
      end_reason: null,
      minio_prefix: null,
      summary_message_id: null,
      participants_json: '[]',
      stats_json: null,
      error: null,
    };
    this.deps.store.createSession(row);

    // The recording notice belongs in the voice channel's own chat — that's
    // where the people being recorded actually are. Best-effort: a stage the
    // bot can't type in must not block the recording.
    if (channel.isSendable()) {
      await channel
        .send(
          `🔴 **Estoy grabando esta sesión para la minuta**${params.title ? ` — _${params.title}_` : ''}. ` +
            'Cuando terminen, alguien de la moderación corre `/chopperbot-leave` y publico el resumen. ' +
            '(Si el canal se vacía o el evento termina, cierro sola.)',
        )
        .catch((err) => log.warn({ err, sessionId: id }, 'minutas.notice_failed'));
    }
    log.info(
      { sessionId: id, guild: guild.id, channel: channel.id, by: params.startedBy.tag },
      'minutas.session_started',
    );
    return row;
  }

  /**
   * Stop capturing and leave the channel. Fast (bounded by the burst-flush
   * timeout): the heavy transcribe/summarize/publish work happens after, in
   * the `onClosed` callback. Returns null when no session was active.
   */
  async end(guildId: string, reason: string): Promise<ClosedSession | null> {
    const session = this.active.get(guildId);
    if (!session) return null;
    this.active.delete(guildId);
    session.closed = true;
    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.emptyTimer) clearTimeout(session.emptyTimer);
    session.connection.receiver.speaking.off('start', session.onSpeakStart);
    // Destroying the connection ends every subscription, which flushes its
    // recorder; bound the wait so a stuck flush can't hold the command.
    try {
      session.connection.destroy();
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'minutas.connection_destroy_failed');
    }
    await Promise.race([
      Promise.allSettled([...session.openBursts.values()]),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    this.writeManifest(session);

    this.deps.store.updateSession(session.id, {
      status: 'processing',
      ended_at: Date.now(),
      end_reason: reason,
      participants_json: JSON.stringify([...session.participants.values()]),
    });
    const row = this.deps.store.getSession(session.id)!;
    log.info({ sessionId: session.id, reason }, 'minutas.session_closed');
    return { row, dir: session.dir, reason };
  }

  /** Close + hand to the finalizer. Shared by every end path. */
  async endAndReport(guildId: string, reason: string): Promise<ClosedSession | null> {
    const closed = await this.end(guildId, reason);
    if (closed) this.deps.onClosed(closed);
    return closed;
  }

  private closeAndReport(guildId: string, reason: string): void {
    void this.endAndReport(guildId, reason).catch((err) =>
      log.error({ err, guildId }, 'minutas.auto_end_failed'),
    );
  }

  private onSpeakStart(session: ActiveSession, userId: string): void {
    if (session.closed) return;
    if (session.openBursts.has(userId)) return;
    const opusStream = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    this.startBurst(session, userId, opusStream);
  }

  /**
   * Wire one Opus packet stream into a burst file: manifest line first (so a
   * crash keeps the burst's timeline position), then the async recorder.
   */
  private startBurst(
    session: ActiveSession,
    userId: string,
    opusStream: import('node:stream').Readable,
    startedAtMs: number = Date.now() - session.startedAtMs,
  ): void {
    const seq = ++session.seq;
    const done = this.resolveSpeaker(session, userId).then((speaker) => {
      const file = `${ARTIFACTS.audioDir}/${String(seq).padStart(3, '0')}-${sanitizeFileFragment(speaker)}.pcm`;
      const line: BurstManifestLine = { seq, userId, speaker, file, startedAtMs };
      try {
        appendFileSync(join(session.dir, ARTIFACTS.bursts), JSON.stringify(line) + '\n');
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'minutas.burst_manifest_failed');
      }
      return recordOpusStreamToPcm(opusStream, join(session.dir, file))
        .then((result) => {
          log.debug(
            {
              sessionId: session.id,
              file,
              durationMs: pcmDurationMs(result.bytes),
              packets: result.packets,
              decodeErrors: result.decodeErrors,
            },
            'minutas.burst_recorded',
          );
          this.noteBurstOutcome(session, !burstCapturedNothing(result), file);
          // Hand usable bursts to live transcription while the meeting runs.
          if (!session.closed && result.bytes >= MIN_BURST_BYTES) {
            try {
              this.deps.onBurstRecorded?.(session.dir, {
                seq,
                userId,
                speaker,
                file,
                startedAtMs,
                bytes: result.bytes,
              });
            } catch (err) {
              log.warn({ err, sessionId: session.id }, 'minutas.live_enqueue_failed');
            }
          }
        })
        .catch((err) => {
          log.warn({ err, sessionId: session.id, file }, 'minutas.burst_failed');
          this.noteBurstOutcome(session, false, file);
        });
    });

    // Free the slot as soon as the STREAM ends — a speaker who starts again
    // while ffmpeg is still flushing must open a fresh burst, not be dropped.
    const tracked = new Promise<void>((resolve) => {
      const release = () => {
        session.openBursts.delete(userId);
        void done.then(resolve, resolve);
      };
      opusStream.once('end', release);
      opusStream.once('close', release);
      opusStream.once('error', release);
    });
    session.openBursts.set(userId, tracked);
  }

  /**
   * E2E seam: record a burst from an externally-produced Opus packet stream —
   * the exact recorder path a live `receiver.subscribe` stream takes, minus
   * the Discord network boundary. Used by scripts/verify-minutas.ts to drive
   * real sessions with synthesized speech. Not used in production flows.
   */
  injectTestAudioStream(
    guildId: string,
    userId: string,
    speaker: string,
    opusStream: import('node:stream').Readable,
    startedAtMs?: number,
  ): boolean {
    const session = this.active.get(guildId);
    if (!session || session.closed) return false;
    session.participants.set(userId, speaker);
    this.startBurst(session, userId, opusStream, startedAtMs);
    return true;
  }

  /**
   * Record whether a burst actually produced audio and raise the alarm once a
   * run of them has not. Recording keeps going either way — a wrong alarm must
   * never be the thing that stops an assembly being minuted.
   */
  private noteBurstOutcome(session: ActiveSession, captured: boolean, file: string): void {
    if (!session.captureHealth.record(captured)) return;
    const consecutiveFailures = session.captureHealth.consecutiveFailures;
    log.error(
      { sessionId: session.id, channel: session.channelId, consecutiveFailures, lastFile: file },
      'minutas.capture_broken — consecutive bursts captured no audio',
    );
    try {
      this.deps.onCaptureFailure?.({
        sessionId: session.id,
        guildId: session.guild.id,
        channelId: session.channelId,
        channelName: session.channelName,
        consecutiveFailures,
        lastFile: file,
      });
    } catch (err) {
      log.error({ err, sessionId: session.id }, 'minutas.capture_alarm_failed');
    }
  }

  private async resolveSpeaker(session: ActiveSession, userId: string): Promise<string> {
    const cached = session.participants.get(userId);
    if (cached) return cached;
    let name = userId;
    const member = await session.guild.members.fetch(userId).catch(() => null);
    if (member) name = member.displayName || member.user.tag || userId;
    session.participants.set(userId, name);
    return name;
  }

  /** Append one voice-channel chat comment to the session's chat.jsonl. */
  captureChatMessage(message: Message): void {
    const session = [...this.active.values()].find((s) => s.channelId === message.channelId);
    if (!session || session.closed) return;
    if (message.author?.bot) return;
    const author =
      message.member?.displayName ?? message.author?.globalName ?? message.author?.tag ?? 'alguien';
    this.recordChatLine(session.guild.id, {
      userId: message.author.id,
      author,
      content: message.content ?? '',
    });
  }

  /**
   * Record one chat line into the guild's active session. Public (and used by
   * the e2e script) — the bot/wrong-channel filtering lives in the listener
   * above; this is the raw sink.
   */
  recordChatLine(
    guildId: string,
    line: { userId: string; author: string; content: string },
  ): boolean {
    const session = this.active.get(guildId);
    if (!session || session.closed) return false;
    session.participants.set(line.userId, line.author);
    try {
      appendFileSync(
        join(session.dir, ARTIFACTS.chat),
        JSON.stringify({ t: Date.now(), ...line }) + '\n',
      );
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'minutas.chat_capture_failed');
      return false;
    }
    return true;
  }

  /** voiceStateUpdate watcher: bot kicked/disconnected, or channel emptied. */
  handleVoiceStateUpdate(
    oldState: { channelId: string | null; channel: VoiceBasedChannel | null },
    newState: { id: string; channelId: string | null; channel: VoiceBasedChannel | null },
    botId: string,
  ): void {
    const session =
      [...this.active.values()].find(
        (s) => s.channelId === oldState.channelId || s.channelId === newState.channelId,
      ) ?? null;
    if (!session) return;

    if (newState.id === botId) {
      if (oldState.channelId === session.channelId && newState.channelId !== session.channelId) {
        this.closeAndReport(session.guild.id, 'me desconectaron del canal');
      }
      return;
    }

    const channel = newState.channelId === session.channelId ? newState.channel : oldState.channel;
    const humans = channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (humans === 0 && !session.emptyTimer) {
      session.emptyTimer = setTimeout(() => {
        session.emptyTimer = null;
        const ch = session.guild.channels.cache.get(session.channelId);
        const stillEmpty =
          !ch || !ch.isVoiceBased() || ch.members.filter((m) => !m.user.bot).size === 0;
        if (stillEmpty) this.closeAndReport(session.guild.id, 'el canal quedó vacío');
      }, EMPTY_CHANNEL_GRACE_MS);
      session.emptyTimer.unref();
    } else if (humans > 0 && session.emptyTimer) {
      clearTimeout(session.emptyTimer);
      session.emptyTimer = null;
    }
  }

  /** A scheduled event tied to the session's channel ended or was deleted. */
  handleScheduledEventEnd(event: Pick<GuildScheduledEvent, 'channelId'>): void {
    const session = [...this.active.values()].find((s) => s.channelId === event.channelId);
    if (!session) return;
    this.closeAndReport(session.guild.id, 'el evento programado terminó');
  }

  /** True when the event's state means "over". */
  static eventIsOver(status: GuildScheduledEventStatus): boolean {
    return (
      status === GuildScheduledEventStatus.Completed || status === GuildScheduledEventStatus.Canceled
    );
  }

  private writeManifest(session: ActiveSession): void {
    const manifest: SessionManifest = {
      id: session.id,
      guildId: session.guild.id,
      channelId: session.channelId,
      channelName: session.channelName,
      title: session.title,
      startedBy: session.startedBy.id,
      startedByTag: session.startedBy.tag,
      startedAt: session.startedAtMs,
      participants: Object.fromEntries(session.participants),
    };
    try {
      writeFileSync(join(session.dir, ARTIFACTS.sessionMeta), JSON.stringify(manifest, null, 2));
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'minutas.manifest_write_failed');
    }
  }

  /** Shutdown: drop connections so the bot leaves voice promptly; the session
   * rows stay 'active' and the next boot's sweep finalizes from disk. */
  disposeAll(): void {
    for (const session of this.active.values()) {
      session.closed = true;
      if (session.maxTimer) clearTimeout(session.maxTimer);
      if (session.emptyTimer) clearTimeout(session.emptyTimer);
      try {
        session.connection.destroy();
      } catch {
        /* already gone */
      }
    }
    this.active.clear();
  }
}
