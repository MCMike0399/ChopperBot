import { appendFileSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "../../log.js";
import {
   ARTIFACTS,
   BATCH_GAP_MS,
   LIVE_FLUSH_AUDIO_SEC,
   LIVE_FLUSH_MAX_BURSTS,
   LIVE_FLUSH_MAX_WAIT_MS,
   MAX_BATCH_AUDIO_SEC,
   PCM_BYTES_PER_SECOND,
   WHISPER_PROMPT_MAX_CHARS,
   WHISPER_VOCABULARY,
} from "./constants.js";
import {
   concatenatePcmFiles,
   pcmToWav,
   sanitizeFileFragment,
} from "./audio.js";
import type { TranscriptSegment, Transcriber } from "./transcriber.js";

/**
 * Live transcription with burst concatenation.
 *
 * Why: whisper costs a measured ~8.5 s of fixed overhead PER INVOCATION (it
 * pads everything to a 30 s window) plus 0.82 × the audio. The 2026-08-16
 * assembly paid that overhead 155 times — 29% of a 74-minute wait. Batching a
 * speaker's bursts into one invocation amortizes the overhead away, and doing
 * it WHILE the meeting runs means the post-meeting work is only the last
 * un-flushed remainder: the minute lands minutes after the session, not an
 * hour.
 *
 * Attribution safety: batches are strictly per speaker. Discord's exact
 * speaker separation is never re-derived from audio — a segment can only ever
 * land on a burst of the voice it came from. Mapping back to the timeline is
 * arithmetic on the concatenation offsets; a segment goes to the burst it
 * overlaps most (see {@link mapBatchSegments} for why "midpoint in a gap →
 * drop" was retired).
 *
 * Crash safety: every transcribed batch appends its bursts to the ledger
 * (`transcripts-live.jsonl`) BEFORE anyone consumes the result. Finalize reads
 * the ledger and only transcribes bursts missing from it, so a crash at any
 * point costs at most one batch of re-work.
 */

/** One burst awaiting transcription (manifest line + its measured bytes). */
export interface PendingBurst {
   seq: number;
   userId: string;
   speaker: string;
   /** Dir-relative path, e.g. `audio/012-Ana.pcm` (as in bursts.jsonl). */
   file: string;
   startedAtMs: number;
   bytes: number;
}

/** One ledger line: a burst whose transcription is done (segments may be []). */
export interface LedgerEntry {
   file: string;
   userId: string;
   speaker: string;
   startedAtMs: number;
   segments: TranscriptSegment[];
}

export interface Batch {
   /** Artifact base name, e.g. `batch-012-Ana` (first seq + speaker). */
   name: string;
   speaker: string;
   bursts: PendingBurst[];
}

/** Group pending bursts per speaker, splitting when a batch exceeds the cap. */
export function planBatches(
   pending: PendingBurst[],
   maxBatchAudioSec = MAX_BATCH_AUDIO_SEC,
): Batch[] {
   const byUser = new Map<string, PendingBurst[]>();
   for (const b of [...pending].sort((a, z) => a.seq - z.seq)) {
      const list = byUser.get(b.userId) ?? [];
      list.push(b);
      byUser.set(b.userId, list);
   }
   const batches: Batch[] = [];
   for (const bursts of byUser.values()) {
      const speaker = bursts[0]!.speaker;
      let current: PendingBurst[] = [];
      let audioSec = 0;
      const cut = () => {
         if (current.length === 0) return;
         batches.push({ name: batchName(current), speaker, bursts: current });
         current = [];
         audioSec = 0;
      };
      for (const b of bursts) {
         const sec = b.bytes / PCM_BYTES_PER_SECOND;
         if (current.length > 0 && audioSec + sec > maxBatchAudioSec) cut();
         current.push(b);
         audioSec += sec;
      }
      cut();
   }
   return batches;
}

function batchName(bursts: PendingBurst[]): string {
   const first = bursts[0]!;
   return `batch-${String(first.seq).padStart(3, "0")}-${sanitizeFileFragment(first.speaker)}`;
}

/**
 * Whisper's stock hallucinations on silence / padding — never speech in an
 * assembly. Matched against the WHOLE segment text, so a real sentence that
 * happens to contain "gracias" is never dropped.
 */
const HALLUCINATION_RE = new RegExp(
   [
      String.raw`^[\[(][^\])]*[\])]$`, // [Música], (risas), [BLANK_AUDIO]
      String.raw`subt[ií]tulos? (realizados|por|hechos)`,
      String.raw`amara\.org`,
      String.raw`canal de subt[ií]tulos`,
      String.raw`^¡?suscr[ií]bete[.!]*$`,
      String.raw`gracias por ver (el|este) v[ií]deo`,
      String.raw`(nos vemos en el|hasta el) pr[oó]ximo v[ií]deo`,
   ].join("|"),
   "i",
);

export function isWhisperHallucination(text: string): boolean {
   return HALLUCINATION_RE.test(text.trim());
}

/**
 * Map whisper segments from a concatenated file back onto the bursts that
 * composed it. EVERY burst gets a ledger entry, segments or not — a silent
 * burst must still be marked done, or finalize would re-transcribe it forever.
 *
 * Each segment goes to the burst it **overlaps most**; one that overlaps none
 * (inside a join gap, or past the file end — whisper's timestamps overshoot)
 * goes to the nearest burst. Only known hallucinations are dropped.
 *
 * Why not "midpoint in a gap → drop" any more (2026-09-23 audit): across 7
 * real sessions that rule dropped 187 of 6,472 segments, ~110 of them ten
 * words or longer and only ~9 actual hallucinations — among them «Y
 * abstención.» (a vote option), «la segunda semana de octubre…» (a proposed
 * date) and a whole 29 s opening statement. They straddled a burst end, which
 * whisper does all the time, most of all once it has an initial prompt and
 * emits longer segments. Misattribution is impossible either way — a batch is
 * one speaker — so the only thing a lenient mapping can cost is a few hundred
 * ms of timeline fuzz.
 */
export function mapBatchSegments(
   segments: TranscriptSegment[],
   slots: Array<{ burst: PendingBurst; offsetMs: number; durationMs: number }>,
): LedgerEntry[] {
   const entries = slots.map(({ burst }) => ({
      file: burst.file,
      userId: burst.userId,
      speaker: burst.speaker,
      startedAtMs: burst.startedAtMs,
      segments: [] as TranscriptSegment[],
   }));
   if (slots.length === 0) return entries;
   for (const seg of segments) {
      if (isWhisperHallucination(seg.text)) continue;
      let best = -1;
      let bestOverlap = 0;
      for (let i = 0; i < slots.length; i++) {
         const s = slots[i]!;
         const overlap =
            Math.min(seg.endMs, s.offsetMs + s.durationMs) -
            Math.max(seg.startMs, s.offsetMs);
         if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = i;
         }
      }
      if (best === -1) {
         // No overlap at all: the nearest burst by distance to the segment.
         let bestDist = Infinity;
         for (let i = 0; i < slots.length; i++) {
            const s = slots[i]!;
            const dist = Math.max(
               s.offsetMs - seg.endMs,
               seg.startMs - (s.offsetMs + s.durationMs),
               0,
            );
            if (dist < bestDist) {
               bestDist = dist;
               best = i;
            }
         }
      }
      const slot = slots[best]!;
      const startMs = Math.min(
         slot.durationMs,
         Math.max(0, seg.startMs - slot.offsetMs),
      );
      entries[best]!.segments.push({
         startMs,
         endMs: Math.max(
            startMs,
            Math.min(slot.durationMs, seg.endMs - slot.offsetMs),
         ),
         text: seg.text,
      });
   }
   return entries;
}

/**
 * The initial prompt for a session's whisper runs: community vocabulary, the
 * session title, and the participants' names with decoration stripped
 * ("tlacuache ✩‧₊˚" → "tlacuache"), so whisper spells them the way the community
 * does. Read from `session.json`; a missing/unreadable manifest just means the
 * vocabulary alone.
 */
export function buildWhisperPrompt(
   title: string | null,
   names: readonly string[],
): string {
   const clean = [
      ...new Set(
         names
            .map((n) =>
               n
                  .replace(/[^\p{L}\p{N} _.'-]/gu, " ")
                  .replace(/\s+/g, " ")
                  .trim(),
            )
            .filter((n) => n.length >= 2 && !/^\d+$/.test(n)),
      ),
   ];
   const parts = [WHISPER_VOCABULARY];
   if (title?.trim()) parts.push(`Sesión: ${title.trim()}.`);
   if (clean.length > 0) parts.push(`Participan: ${clean.join(", ")}.`);
   const prompt = parts.join(" ");
   return prompt.length > WHISPER_PROMPT_MAX_CHARS
      ? prompt.slice(0, WHISPER_PROMPT_MAX_CHARS).replace(/,[^,]*$/, ".")
      : prompt;
}

function whisperPromptFor(dir: string): string {
   try {
      const manifest = JSON.parse(
         readFileSync(join(dir, ARTIFACTS.sessionMeta), "utf8"),
      ) as { title?: string | null; participants?: Record<string, string> };
      return buildWhisperPrompt(
         manifest.title ?? null,
         Object.values(manifest.participants ?? {}),
      );
   } catch {
      return buildWhisperPrompt(null, []);
   }
}

// ── Ledger ────────────────────────────────────────────────────────────────────

/** Bursts already transcribed (live or by an earlier finalize attempt). */
export function readLedger(dir: string): Map<string, LedgerEntry> {
   const out = new Map<string, LedgerEntry>();
   try {
      const raw = readFileSync(join(dir, ARTIFACTS.liveLedger), "utf8");
      for (const line of raw.split("\n")) {
         if (!line.trim()) continue;
         try {
            const e = JSON.parse(line) as LedgerEntry;
            out.set(e.file, e);
         } catch {
            /* torn tail line from a crash — the burst just gets re-transcribed */
         }
      }
   } catch {
      /* no ledger yet */
   }
   return out;
}

export function appendLedger(dir: string, entries: LedgerEntry[]): void {
   if (entries.length === 0) return;
   appendFileSync(
      join(dir, ARTIFACTS.liveLedger),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
   );
}

// ── Batch execution ───────────────────────────────────────────────────────────

/**
 * Concatenate → WAV → whisper → map → ledger, for one per-speaker batch.
 * Artifacts land in the session dir under the batch name (the WAV + whisper
 * raw JSON archive to MinIO with everything else; the concat PCM is deleted —
 * the per-burst PCMs remain the recording of record until finalize cleanup).
 */
export async function transcribeBatch(
   transcriber: Transcriber,
   dir: string,
   batch: Batch,
): Promise<LedgerEntry[]> {
   const concatPcm = join(dir, ARTIFACTS.audioDir, `${batch.name}.pcm`);
   const slots = await concatenatePcmFiles(
      batch.bursts.map((b) => join(dir, b.file)),
      concatPcm,
      BATCH_GAP_MS,
   );
   const wavPath = join(dir, ARTIFACTS.audioDir, `${batch.name}.wav`);
   await pcmToWav(concatPcm, wavPath);
   await unlink(concatPcm).catch(() => {});
   const segments = await transcriber.transcribe(
      wavPath,
      join(dir, ARTIFACTS.whisperDir, batch.name),
      { prompt: whisperPromptFor(dir) },
   );
   const entries = mapBatchSegments(
      segments,
      slots.map((s, i) => ({
         burst: batch.bursts[i]!,
         offsetMs: s.offsetMs,
         durationMs: s.durationMs,
      })),
   );
   appendLedger(dir, entries);
   return entries;
}

// ── The live worker ───────────────────────────────────────────────────────────

/**
 * Accumulates finished bursts per session+speaker while the meeting runs and
 * flushes them through `transcribeBatch` once a speaker has enough pending
 * audio or has waited two minutes. Completion rechecks ready work without
 * another speech turn. Failures are logged and NOT retried here — an unledgered burst is
 * finalize's to pick up, so nothing is ever lost, only deferred.
 */
interface PendingSpeaker {
   bursts: PendingBurst[];
   queuedAt: number;
   expired: boolean;
   timer: NodeJS.Timeout;
}

export class LiveTranscriber {
   private readonly pending = new Map<string, Map<string, PendingSpeaker>>();
   /** A user id identifies a voice; display names may be shared by two people. */
   private readonly inFlight = new Map<string, Promise<void>>();
   private readonly draining = new Set<string>();
   private stopped = false;

   constructor(
      private readonly transcriber: Transcriber,
      private readonly maxWaitMs = LIVE_FLUSH_MAX_WAIT_MS,
   ) {}

   enqueue(dir: string, burst: PendingBurst): void {
      if (
         this.stopped ||
         this.draining.has(dir) ||
         !this.transcriber.isAvailable()
      )
         return;
      const speakers =
         this.pending.get(dir) ?? new Map<string, PendingSpeaker>();
      this.pending.set(dir, speakers);
      let pending = speakers.get(burst.userId);
      if (!pending) {
         const timer = setTimeout(() => {
            const waiting = this.pending.get(dir)?.get(burst.userId);
            if (waiting) waiting.expired = true;
            this.maybeFlush(dir, burst.userId);
         }, this.maxWaitMs);
         timer.unref();
         pending = { bursts: [], queuedAt: Date.now(), expired: false, timer };
         speakers.set(burst.userId, pending);
      }
      pending.bursts.push(burst);
      this.maybeFlush(dir, burst.userId);
   }

   status(dir: string): {
      pendingBursts: number;
      pendingAudioSec: number;
      inFlightBatches: number;
      oldestPendingMs: number;
   } {
      const speakers = [...(this.pending.get(dir)?.values() ?? [])];
      const bursts = speakers.flatMap((s) => s.bursts);
      return {
         pendingBursts: bursts.length,
         pendingAudioSec: Math.round(
            bursts.reduce((s, b) => s + b.bytes, 0) / PCM_BYTES_PER_SECOND,
         ),
         inFlightBatches: [...this.inFlight.keys()].filter((key) =>
            key.startsWith(`${dir}\u0000`),
         ).length,
         oldestPendingMs: speakers.length
            ? Math.max(
                 0,
                 Date.now() - Math.min(...speakers.map((s) => s.queuedAt)),
              )
            : 0,
      };
   }

   private maybeFlush(dir: string, userId: string): void {
      if (this.stopped || this.draining.has(dir)) return;
      const pending = this.pending.get(dir)?.get(userId);
      if (!pending?.bursts.length) return;
      const audioSec = pending.bursts.reduce(
         (s, b) => s + b.bytes / PCM_BYTES_PER_SECOND,
         0,
      );
      if (
         audioSec < LIVE_FLUSH_AUDIO_SEC &&
         pending.bursts.length < LIVE_FLUSH_MAX_BURSTS &&
         !pending.expired
      )
         return;
      const key = `${dir}\u0000${userId}`;
      if (this.inFlight.has(key)) return;
      const run = this.flush(dir, userId).finally(() => {
         this.inFlight.delete(key);
         // Finished audio can arrive while whisper is busy. Recheck without
         // requiring another speech turn (observed with 157 s waiting on Oct 6).
         this.maybeFlush(dir, userId);
      });
      this.inFlight.set(key, run);
   }

   /** Freeze new flushes before waiting; finalize owns every pending tail. */
   async drain(dir: string): Promise<void> {
      this.draining.add(dir);
      for (const pending of this.pending.get(dir)?.values() ?? [])
         clearTimeout(pending.timer);
      const running = [...this.inFlight.entries()]
         .filter(([key]) => key.startsWith(`${dir}\u0000`))
         .map(([, p]) => p);
      await Promise.allSettled(running);
      this.pending.delete(dir);
      this.draining.delete(dir);
   }

   dispose(): void {
      this.stopped = true;
      for (const speakers of this.pending.values())
         for (const pending of speakers.values()) clearTimeout(pending.timer);
      this.pending.clear();
   }

   private async flush(dir: string, userId: string): Promise<void> {
      const pending = this.pending.get(dir)?.get(userId);
      if (!pending?.bursts.length) return;
      clearTimeout(pending.timer);
      this.pending.get(dir)!.delete(userId);
      const list = pending.bursts;
      try {
         for (const batch of planBatches(list)) {
            const started = Date.now();
            const audioSec =
               batch.bursts.reduce(
                  (s, b) => s + b.bytes / PCM_BYTES_PER_SECOND,
                  0,
               ) +
               ((batch.bursts.length - 1) * BATCH_GAP_MS) / 1000;
            const entries = await transcribeBatch(this.transcriber, dir, batch);
            log.info(
               {
                  dir: basename(dir),
                  batch: batch.name,
                  bursts: batch.bursts.length,
                  segments: entries.reduce((s, e) => s + e.segments.length, 0),
                  audioSec: Math.round(audioSec),
                  tookMs: Date.now() - started,
                  pending: this.status(dir),
               },
               "minutas.live_batch_transcribed",
            );
         }
      } catch (err) {
         // Failed batches remain unledgered for finalize; never retry them live.
         log.warn(
            { err, dir: basename(dir), userId },
            "minutas.live_batch_failed",
         );
      }
   }
}
