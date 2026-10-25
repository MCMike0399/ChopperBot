import { log } from "../../log.js";
import type { Transcriber, TranscriptSegment } from "./transcriber.js";

interface FailoverOptions {
   cooldownMs?: number;
   now?: () => number;
   onTransition?: (backend: "local_fallback" | "remote") => Promise<void>;
}

/** One queue owns both engines: a lost remote response never races a local
 * write to the same transcript or starts an unbounded pile of Pi processes. */
export class FailoverTranscriber implements Transcriber {
   private queue: Promise<unknown> = Promise.resolve();
   private retryAt: number | null = null;

   constructor(
      private readonly remote: Transcriber,
      private readonly local: Transcriber,
      private readonly options: FailoverOptions = {},
   ) {}

   isAvailable(): boolean {
      return this.remote.isAvailable() || this.local.isAvailable();
   }

   status(): {
      backend: "remote" | "local_fallback";
      localAvailable: boolean;
      remoteRetryAt: number | null;
   } {
      return {
         backend: this.retryAt === null ? "remote" : "local_fallback",
         localAvailable: this.local.isAvailable(),
         remoteRetryAt: this.retryAt,
      };
   }

   transcribe(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const run = this.queue.then(() => this.run(wavPath, outBase, opts));
      this.queue = run.catch(() => {});
      return run;
   }

   private async run(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const now = this.options.now ?? Date.now;
      if (this.retryAt === null || now() >= this.retryAt) {
         try {
            const segments = await this.remote.transcribe(
               wavPath,
               outBase,
               opts,
            );
            if (this.retryAt !== null) {
               this.retryAt = null;
               log.info("minutas.transcription_remote_recovered");
               void this.notify("remote");
            }
            return segments;
         } catch (err) {
            const firstFailure = this.retryAt === null;
            this.retryAt = now() + (this.options.cooldownMs ?? 5 * 60_000);
            log.warn(
               {
                  err,
                  retryAt: this.retryAt,
                  localAvailable: this.local.isAvailable(),
               },
               "minutas.transcription_local_fallback",
            );
            if (firstFailure) void this.notify("local_fallback");
            if (!this.local.isAvailable())
               throw new Error(
                  "Remote transcription failed and local whisper is unavailable",
                  { cause: err },
               );
         }
      }
      if (!this.local.isAvailable())
         throw new Error(
            "Local whisper fallback is unavailable; audio retained for recovery",
         );
      return this.local.transcribe(wavPath, outBase, opts);
   }

   private async notify(backend: "local_fallback" | "remote"): Promise<void> {
      try {
         await this.options.onTransition?.(backend);
      } catch (err) {
         log.warn({ err }, "minutas.transcription_transition_alert_failed");
      }
   }
}
