import { appendFileSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { log } from '../../log.js';
import {
  ARTIFACTS,
  BATCH_GAP_MS,
  LIVE_FLUSH_AUDIO_SEC,
  LIVE_FLUSH_MAX_BURSTS,
  MAX_BATCH_AUDIO_SEC,
  PCM_BYTES_PER_SECOND,
} from './constants.js';
import { concatenatePcmFiles, pcmToWav, sanitizeFileFragment } from './audio.js';
import type { TranscriptSegment, Transcriber } from './transcriber.js';

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
 * arithmetic on the concatenation offsets; segments whose midpoint falls in a
 * silence gap between bursts are dropped (that is where whisper hallucinates).
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
  const bySpeaker = new Map<string, PendingBurst[]>();
  for (const b of [...pending].sort((a, z) => a.seq - z.seq)) {
    const list = bySpeaker.get(b.speaker) ?? [];
    list.push(b);
    bySpeaker.set(b.speaker, list);
  }
  const batches: Batch[] = [];
  for (const [speaker, bursts] of bySpeaker) {
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
  return `batch-${String(first.seq).padStart(3, '0')}-${sanitizeFileFragment(first.speaker)}`;
}

/**
 * Map whisper segments from a concatenated file back onto the bursts that
 * composed it. Attribution by segment midpoint; midpoints inside a gap (no
 * burst owns them) are dropped as concat artifacts. EVERY burst gets a ledger
 * entry, segments or not — a silent burst must still be marked done, or
 * finalize would re-transcribe it forever.
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
  for (const seg of segments) {
    const mid = (seg.startMs + seg.endMs) / 2;
    const i = slots.findIndex((s) => mid >= s.offsetMs && mid < s.offsetMs + s.durationMs);
    if (i === -1) continue; // midpoint in a silence gap → concat artifact
    const slot = slots[i]!;
    entries[i]!.segments.push({
      startMs: Math.max(0, seg.startMs - slot.offsetMs),
      endMs: Math.min(slot.durationMs, seg.endMs - slot.offsetMs),
      text: seg.text,
    });
  }
  return entries;
}

// ── Ledger ────────────────────────────────────────────────────────────────────

/** Bursts already transcribed (live or by an earlier finalize attempt). */
export function readLedger(dir: string): Map<string, LedgerEntry> {
  const out = new Map<string, LedgerEntry>();
  try {
    const raw = readFileSync(join(dir, ARTIFACTS.liveLedger), 'utf8');
    for (const line of raw.split('\n')) {
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
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
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
  const segments = await transcriber.transcribe(wavPath, join(dir, ARTIFACTS.whisperDir, batch.name));
  const entries = mapBatchSegments(
    segments,
    slots.map((s, i) => ({ burst: batch.bursts[i]!, offsetMs: s.offsetMs, durationMs: s.durationMs })),
  );
  appendLedger(dir, entries);
  return entries;
}

// ── The live worker ───────────────────────────────────────────────────────────

/**
 * Accumulates finished bursts per session+speaker while the meeting runs and
 * flushes them through `transcribeBatch` once a speaker has enough pending
 * audio. Failures are logged and NOT retried here — an unledgered burst is
 * finalize's to pick up, so nothing is ever lost, only deferred.
 */
export class LiveTranscriber {
  private readonly pending = new Map<string, Map<string, PendingBurst[]>>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly transcriber: Transcriber) {}

  enqueue(dir: string, burst: PendingBurst): void {
    if (!this.transcriber.isAvailable()) return;
    const speakers = this.pending.get(dir) ?? new Map<string, PendingBurst[]>();
    this.pending.set(dir, speakers);
    const list = speakers.get(burst.speaker) ?? [];
    list.push(burst);
    speakers.set(burst.speaker, list);
    const audioSec = list.reduce((s, b) => s + b.bytes / PCM_BYTES_PER_SECOND, 0);
    if (audioSec >= LIVE_FLUSH_AUDIO_SEC || list.length >= LIVE_FLUSH_MAX_BURSTS) {
      void this.flush(dir, burst.speaker);
    }
  }

  /** Session over: drop its pending state (finalize owns the leftovers). */
  forget(dir: string): void {
    this.pending.delete(dir);
  }

  private async flush(dir: string, speaker: string): Promise<void> {
    const key = `${dir} ${speaker}`;
    if (this.inFlight.has(key)) return;
    const list = this.pending.get(dir)?.get(speaker);
    if (!list || list.length === 0) return;
    this.pending.get(dir)!.set(speaker, []);
    this.inFlight.add(key);
    try {
      for (const batch of planBatches(list)) {
        const entries = await transcribeBatch(this.transcriber, dir, batch);
        log.info(
          {
            dir: basename(dir),
            batch: batch.name,
            bursts: batch.bursts.length,
            segments: entries.reduce((s, e) => s + e.segments.length, 0),
          },
          'minutas.live_batch_transcribed',
        );
      }
    } catch (err) {
      // Not retried live: the bursts are absent from the ledger, so finalize
      // will transcribe them. Losing the live head start, never the audio.
      log.warn({ err, dir: basename(dir), speaker }, 'minutas.live_batch_failed');
    } finally {
      this.inFlight.delete(key);
    }
  }
}
