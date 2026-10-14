import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { promisify } from "node:util";
import { log } from "../../log.js";

const execFileAsync = promisify(execFile);

/**
 * Niceness for the whisper child. Transcribing an assembly pins every core it
 * is given for the better part of an hour; without this the Discord event loop
 * competes with it for CPU and the bot gets sluggish for everyone else. Lowering
 * priority costs nothing when the box is otherwise idle, which it usually is.
 */
const WHISPER_NICE = 10;

/** One utterance, offsets relative to the start of its own audio file. */
export interface TranscriptSegment {
   startMs: number;
   endMs: number;
   text: string;
}

export interface Transcriber {
   /** Whether the engine can run at all (binary + model present). */
   isAvailable(): boolean;
   /**
    * Transcribe a 16 kHz mono WAV; rejects on engine failure. `prompt` is
    * whisper's initial prompt — vocabulary and names to spell right.
    * `noContext` stops whisper conditioning on its own previous text
    * (`-mc 0`), the retry for a repetition loop.
    */
   transcribe(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]>;
}

interface WhisperCliOptions {
   bin: string;
   modelPath: string;
   language: string;
   /** Threads while a session is recording (cores stay free for capture). */
   threads: number;
   /** Threads once nothing is recording; defaults to `threads`. */
   idleThreads?: number;
   /** Whether any session is capturing audio right now. */
   isRecording?: () => boolean;
}

/**
 * Local speech-to-text via whisper.cpp (`scripts/setup-minutas-whisper.sh`).
 * Runs on the Pi — community audio never leaves the box and there is no
 * per-minute meter. Calls are serialized: one whisper process at a time, so a
 * long meeting's backlog can't OOM the Pi by transcribing in parallel.
 */
export class WhisperCliTranscriber implements Transcriber {
   private queue: Promise<unknown> = Promise.resolve();

   constructor(private readonly opts: WhisperCliOptions) {}

   isAvailable(): boolean {
      return existsSync(this.opts.bin) && existsSync(this.opts.modelPath);
   }

   transcribe(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const run = this.queue.then(() =>
         this.transcribeNow(wavPath, outBase, opts),
      );
      this.queue = run.catch(() => {});
      return run;
   }

   /**
    * Chosen when the process SPAWNS, not when the call was queued: batches
    * still waiting behind the serialized queue at `/chopperbot-leave` run at
    * full width. Why (2026-10-13 live review): the 2-thread setting exists to
    * keep cores free alongside a live recording, yet the whole leave → post
    * wait (16 min on 2026-10-06, ~15 of it whisper) also ran at 2 threads
    * with nothing else recording.
    */
   threadsNow(): number {
      return this.opts.isRecording?.() === false
         ? (this.opts.idleThreads ?? this.opts.threads)
         : this.opts.threads;
   }

   private async transcribeNow(
      wavPath: string,
      outBase: string,
      opts?: { prompt?: string; noContext?: boolean },
   ): Promise<TranscriptSegment[]> {
      const prompt = opts?.prompt;
      const started = Date.now();
      const threads = this.threadsNow();
      const running = execFileAsync(
         this.opts.bin,
         [
            "-m",
            this.opts.modelPath,
            "-f",
            wavPath,
            "-l",
            this.opts.language,
            "-oj",
            "-of",
            outBase,
            "-t",
            String(threads),
            "-np",
            ...(opts?.noContext ? ["-mc", "0"] : []),
            ...(prompt ? ["--prompt", prompt] : []),
         ],
         // A 2 h monologue on the small model is ~1.5 h of Pi CPU worst case —
         // generous ceiling; execFile's default 1 MB stdout cap is fine with -np.
         { timeout: 3 * 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
      );
      const pid = running.child?.pid;
      if (pid !== undefined) {
         // Best-effort: lowering our own child's priority needs no privileges, but
         // a failure here must not cost us the transcription.
         try {
            setPriority(pid, WHISPER_NICE);
         } catch (err) {
            log.debug({ err: String(err), pid }, "minutas.whisper_nice_failed");
         }
      }
      await running;
      const raw = JSON.parse(await readFile(`${outBase}.json`, "utf8")) as {
         transcription?: Array<{
            offsets?: { from?: number; to?: number };
            text?: string;
         }>;
      };
      const segments: TranscriptSegment[] = (raw.transcription ?? [])
         .map((t) => ({
            startMs: Math.max(0, Math.round(t.offsets?.from ?? 0)),
            endMs: Math.max(0, Math.round(t.offsets?.to ?? 0)),
            text: (t.text ?? "").trim(),
         }))
         .filter((s) => s.text.length > 0);
      log.info(
         {
            wavPath,
            segments: segments.length,
            threads,
            ...(opts?.noContext ? { noContext: true } : {}),
            tookMs: Date.now() - started,
         },
         "minutas.transcribed",
      );
      return segments;
   }
}
