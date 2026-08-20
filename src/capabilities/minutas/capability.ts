import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
   Events,
   type Client,
   type GuildScheduledEvent,
   type Message,
} from "discord.js";
import { config } from "../../config.js";
import { log } from "../../log.js";
import { composeToolSources } from "../../tools/source.js";
import { sendAdminAlert } from "../../discord/admin-alert.js";
import { createObjectStorage } from "../../storage/index.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import type {
   Capability,
   CapabilityInitDeps,
   CapabilityStartDeps,
   CapabilityTurnBundle,
} from "../capability.js";
import { MINUTAS_CAPABILITY_ID } from "./constants.js";
import {
   MINUTAS_MIGRATIONS,
   MinutasStore,
   type MinutasSessionRow,
} from "./store.js";
import { measureSessionDir } from "./scheduler.js";
import { LiveTranscriber } from "./live.js";
import {
   MinutasSessions,
   UserVisibleError,
   type CaptureFailure,
   type ClosedSession,
} from "./session.js";
import { WhisperCliTranscriber } from "./transcriber.js";
import { finalizeSession, type FinalizeDeps } from "./pipeline.js";
import {
   buildMinutasInteractionHandler,
   registerMinutasSlashCommands,
} from "./commands.js";

export const MINUTAS_PROMPT = `Eres ChopperBot. En este servidor también grabas minutas de las sesiones de voz: la moderación usa /chopperbot-join dentro de un canal de voz para que grabes la conversación (por hablante) y /chopperbot-leave para cerrarla; tú transcribes y publicas la minuta en el canal de minutas. Este canal de texto no usa esa función: si te preguntan, explícala brevemente y sigue la conversación.`;

/**
 * Minutas — voice/stage meeting recorder → local transcription → LLM minutes.
 * Passive, NOT channel-routed (like file_scanner/event_intake/workshop): it
 * owns slash commands `/chopperbot-join`/`/chopperbot-leave`, per-speaker
 * audio capture, and the voice-channel chat capture while a session runs.
 *
 * Authorization: only the calendar's approver roles (the shared mod list) may
 * run the commands — enforced in the interaction handler, not the prompt.
 *
 * Drafts are session dirs under data/minutas/sessions/<id>/ uploaded to MinIO
 * at minutas/<guild>/<date>/<id>/ on finalize; a crash mid-session is swept
 * into finalization by the next boot.
 */
export class MinutasCapability implements Capability {
   readonly id = MINUTAS_CAPABILITY_ID;
   readonly description =
      "Graba sesiones de voz/stage (/chopperbot-join, solo moderación), distingue hablantes, transcribe local (whisper.cpp) y publica la minuta con IA en el canal de minutas. Pasiva: no ocupa canal.";

   private store: MinutasStore | null = null;
   private db: Database.Database | null = null;
   private storage: ObjectStorage | null = null;
   private transcriber: WhisperCliTranscriber | null = null;
   private sessions: MinutasSessions | null = null;
   private sessionsDir = "";
   private client: Client | null = null;
   private detachListeners: Array<() => void> = [];
   private live: LiveTranscriber | null = null;

   async init({ memory, projectRoot }: CapabilityInitDeps): Promise<void> {
      await memory.migrate(this.id, MINUTAS_MIGRATIONS);
      this.db = memory.db();
      this.store = new MinutasStore(this.db);
      this.store.seedOutputChannelId(config.MINUTAS_OUTPUT_CHANNEL_ID);
      this.storage = createObjectStorage();
      this.transcriber = new WhisperCliTranscriber({
         bin: resolve(projectRoot, config.MINUTAS_WHISPER_BIN),
         modelPath: resolve(projectRoot, config.MINUTAS_WHISPER_MODEL_PATH),
         language: config.MINUTAS_WHISPER_LANGUAGE,
         threads: config.MINUTAS_WHISPER_THREADS,
      });
      this.sessionsDir = resolve(
         projectRoot,
         config.CHOPPERBOT_DATA_DIR,
         "minutas",
         "sessions",
      );
      mkdirSync(this.sessionsDir, { recursive: true });
      this.live = new LiveTranscriber(this.transcriber);
      this.sessions = new MinutasSessions({
         store: this.store,
         sessionsDir: this.sessionsDir,
         onClosed: (closed) => void this.handleClosed(closed),
         onCaptureFailure: (failure) => void this.reportCaptureFailure(failure),
         // Live transcription: finished bursts batch per speaker and go through
         // whisper WHILE the meeting runs, so finalize only owns the tail end.
         onBurstRecorded: (dir, burst) => this.live?.enqueue(dir, burst),
      });
      log.info(
         {
            capability: this.id,
            outputChannel: this.store.getOutputChannelId(),
            transcriber: this.transcriber.isAvailable(),
            storage: this.storage?.backend ?? "disabled",
         },
         "MinutasCapability initialized",
      );
   }

   async start({ client }: CapabilityStartDeps): Promise<void> {
      if (!this.store || !this.db || !this.sessions || !this.transcriber) {
         throw new Error("MinutasCapability.start() called before init()");
      }
      this.client = client;
      await registerMinutasSlashCommands(client);

      const onInteraction = buildMinutasInteractionHandler({
         store: this.store,
         db: this.db,
         sessions: this.sessions,
         requestLeaveProcessing: (guildId, reason) =>
            this.requestLeaveProcessing(guildId, reason),
      });
      client.on(Events.InteractionCreate, onInteraction);
      this.detachListeners.push(() =>
         client.off(Events.InteractionCreate, onInteraction),
      );

      const onMessage = (message: Message) => {
         try {
            this.sessions?.captureChatMessage(message);
         } catch (err) {
            log.error({ err }, "minutas.chat_listener_error");
         }
      };
      client.on(Events.MessageCreate, onMessage);
      this.detachListeners.push(() =>
         client.off(Events.MessageCreate, onMessage),
      );

      const onVoiceState = (
         oldState: Parameters<MinutasSessions["handleVoiceStateUpdate"]>[0],
         newState: Parameters<MinutasSessions["handleVoiceStateUpdate"]>[1],
      ) => {
         try {
            this.sessions?.handleVoiceStateUpdate(
               oldState,
               newState,
               client.user?.id ?? "",
            );
         } catch (err) {
            log.error({ err }, "minutas.voicestate_listener_error");
         }
      };
      client.on(Events.VoiceStateUpdate, onVoiceState);
      this.detachListeners.push(() =>
         client.off(Events.VoiceStateUpdate, onVoiceState),
      );

      const onEventUpdate = (oldEvent: unknown, nextEvent: unknown) => {
         try {
            const next = nextEvent as GuildScheduledEvent | null;
            if (
               next?.status != null &&
               MinutasSessions.eventIsOver(next.status)
            ) {
               this.sessions?.handleScheduledEventEnd(next);
            }
         } catch (err) {
            log.error({ err }, "minutas.event_listener_error");
         }
      };
      client.on(Events.GuildScheduledEventUpdate, onEventUpdate);
      this.detachListeners.push(() =>
         client.off(Events.GuildScheduledEventUpdate, onEventUpdate),
      );

      const onEventDelete = (raw: unknown) => {
         try {
            const event = raw as GuildScheduledEvent | null;
            if (event) this.sessions?.handleScheduledEventEnd(event);
         } catch (err) {
            log.error({ err }, "minutas.event_listener_error");
         }
      };
      client.on(Events.GuildScheduledEventDelete, onEventDelete);
      this.detachListeners.push(() =>
         client.off(Events.GuildScheduledEventDelete, onEventDelete),
      );

      if (!this.transcriber.isAvailable()) {
         log.warn(
            { capability: this.id },
            "minutas.transcriber_missing — sessions record fine but stay untranscribed; run scripts/setup-minutas-whisper.sh",
         );
      }

      // Crash sweep: a row still 'active'/'processing' at boot means the last
      // process died mid-session/mid-finalize. Live transcription already did
      // most of the whisper work, so leftover finalize is the last tail + LLM.
      const unfinished = this.store.listUnfinishedSessions();
      for (const stale of unfinished) {
         log.warn(
            { sessionId: stale.id, status: stale.status },
            "minutas.sweep_interrupted_session",
         );
         this.store.updateSession(stale.id, {
            status: "processing",
            ended_at: stale.ended_at ?? Date.now(),
            end_reason: stale.end_reason ?? "reinicio del bot",
         });
         const row = this.store.getSession(stale.id)!;
         this.beginFinalize({
            row,
            dir: join(this.sessionsDir, row.id),
            reason: row.end_reason ?? "reinicio del bot",
         });
      }
   }

   async buildTurn(): Promise<CapabilityTurnBundle> {
      return { system: MINUTAS_PROMPT, tools: composeToolSources([]) };
   }

   async dispose(): Promise<void> {
      for (const detach of this.detachListeners) detach();
      this.detachListeners = [];
      // Rows stay 'active'/'processing' on purpose so the next boot's sweep
      // finishes whatever this process didn't.
      this.sessions?.disposeAll();
   }

   // ── Command/admin surface ────────────────────────────────────────────────

   /** Live status for the config console's `config_minutas action:status`. */
   adminStatus(guildId: string | null): {
      outputChannelId: string | null;
      transcriberAvailable: boolean;
      storageBackend: string;
      active: {
         id: string;
         channelId: string;
         channelName: string;
         startedAtMs: number;
      } | null;
      recent: MinutasSessionRow[];
   } {
      return {
         outputChannelId: this.store?.getOutputChannelId() ?? null,
         transcriberAvailable: this.transcriber?.isAvailable() ?? false,
         storageBackend: this.storage?.backend ?? "disabled",
         active: guildId ? (this.sessions?.getActive(guildId) ?? null) : null,
         recent: this.store?.listRecentSessions(5) ?? [],
      };
   }

   /** End + process the guild's active session; returns the user-facing ack. */
   async requestLeaveProcessing(
      guildId: string,
      reason: string,
   ): Promise<string> {
      if (!this.sessions || !this.store)
         throw new Error("MinutasCapability not initialized");
      const closed = await this.sessions.end(guildId, reason);
      if (!closed) {
         throw new UserVisibleError(
            "No hay ninguna grabación activa en este servidor.",
         );
      }
      this.beginFinalize(closed);
      const outputId = this.store.getOutputChannelId();
      const dest = outputId ? `<#${outputId}>` : "el canal de minutas";
      return (
         `✅ Cerré la grabación de **${closed.row.channel_name}**. ` +
         `Redacto la minuta y la publico en ${dest} en unos minutos.`
      );
   }

   /**
    * Stop live batching and finalize now. Live transcription already ran during
    * the meeting, so leftover whisper is the last un-flushed tail — not an hour
    * of backlog that used to wait until 01:00.
    */
   private beginFinalize(closed: ClosedSession): void {
      this.live?.forget(closed.dir);
      const leftover = measureSessionDir(closed.dir);
      log.info(
         {
            sessionId: closed.row.id,
            leftoverBursts: leftover.bursts,
            leftoverAudioSec: Math.round(leftover.audioSeconds),
         },
         "minutas.finalize_started",
      );
      void this.finalizeAndReport(closed);
   }

   /** Auto-end paths (channel emptied, event over, disconnect, max duration). */
   private handleClosed(closed: ClosedSession): void {
      this.beginFinalize(closed);
   }

   // ── Capture health ───────────────────────────────────────────────────────

   /**
    * Audio capture has evidently died mid-session. Tell the admins AND the room:
    * on 2026-08-16 the decoder wedged and the assembly kept going for minutes
    * believing it was being recorded. Whoever is in the channel is the only one
    * who can act (re-run the command, or take notes by hand).
    */
   private async reportCaptureFailure(failure: CaptureFailure): Promise<void> {
      if (!this.client) return;
      await sendAdminAlert(
         this.client,
         [
            "⚠️ **Minutas: dejé de capturar audio a mitad de sesión**",
            `Sesión \`${failure.sessionId}\` en ${failure.channelName}: ${failure.consecutiveFailures} ráfagas seguidas sin audio.`,
            "Lo grabado hasta ese punto está a salvo y se publicará igual; lo posterior se está perdiendo.",
            "Revisa `journalctl --user -u chopperbot | grep minutas.opus` y reinicia el bot para restablecer el decodificador.",
         ],
         "minutas.alert",
      );
      const channel = await this.client.channels
         .fetch(failure.channelId)
         .catch(() => null);
      if (channel?.isSendable()) {
         await channel
            .send(
               "⚠️ **Dejé de captar el audio de esta sesión.** Lo que grabé hasta ahora está a salvo y saldrá en la minuta, " +
                  "pero de aquí en adelante no estoy registrando voz. Avisen a quien administre el bot — y mejor tomen notas mientras tanto.",
            )
            .catch((err) =>
               log.warn(
                  { err, sessionId: failure.sessionId },
                  "minutas.capture_warning_failed",
               ),
            );
      }
   }

   // ── Finalize + report ────────────────────────────────────────────────────

   private finalizeDeps(): FinalizeDeps {
      if (!this.store || !this.transcriber || !this.client) {
         throw new Error("MinutasCapability not fully started");
      }
      return {
         store: this.store,
         storage: this.storage,
         transcriber: this.transcriber,
         sessionsDir: this.sessionsDir,
         client: this.client,
      };
   }

   private async finalizeAndReport(closed: ClosedSession): Promise<void> {
      const { row } = closed;
      try {
         const result = await finalizeSession(this.finalizeDeps(), row.id);
         const voiceChannel = this.client
            ? await this.client.channels.fetch(row.channel_id).catch(() => null)
            : null;
         if (!voiceChannel || !voiceChannel.isSendable()) return;
         if (result.empty) {
            await voiceChannel
               .send(
                  "Cerré la grabación: no capté audio ni comentarios del chat, así que no hay minuta que publicar.",
               )
               .catch(() => {});
         } else if (result.publishedUrl) {
            await voiceChannel
               .send(`📜 Minuta lista: ${result.publishedUrl}`)
               .catch(() => {});
         }
      } catch (err) {
         log.error({ err, sessionId: row.id }, "minutas.finalize_failed");
         this.store?.updateSession(row.id, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
         });
         if (this.client) {
            await sendAdminAlert(
               this.client,
               [
                  "⚠️ **Minutas: falló el cierre de una sesión**",
                  `Sesión \`${row.id}\` en ${row.channel_name ?? row.channel_id} (motivo: ${closed.reason}).`,
                  `Error: ${err instanceof Error ? err.message : String(err)}`,
                  "El borrador local se conserva en `data/minutas/sessions/`.",
               ],
               "minutas.alert",
            );
         }
      }
   }
}
