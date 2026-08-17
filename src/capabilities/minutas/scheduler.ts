import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACTS,
  MIN_BURST_BYTES,
  PCM_BYTES_PER_SECOND,
  WHISPER_FIXED_SEC_PER_BURST,
  WHISPER_SEC_PER_AUDIO_SEC,
} from './constants.js';
import { readLedger } from './live.js';

/**
 * When to transcribe a closed session.
 *
 * Transcribing a long assembly pins the Pi's cores for about as long as the
 * assembly itself (cost model in constants.ts). Doing that at 22:30 competes
 * with everything else the box serves; doing it at 01:00 competes with nothing
 * — the heavy window deliberately mirrors the IG monitor's quiet hours (01–08
 * CDMX), when the monitor stops polling and the community is asleep. Short
 * sessions still publish immediately: the deferral only kicks in when the
 * ESTIMATED whisper cost exceeds the configured ceiling.
 *
 * This is a persistent schedule, not an external message broker: the decision
 * is stored on the session row (`transcribe_after`), an in-process timer fires
 * it, and the boot sweep re-arms whatever a restart dropped. One process, a
 * handful of jobs — a broker would add an always-on service with no second
 * consumer.
 */

export interface HeavyWindowConfig {
  /** CDMX wall-clock hour the window opens (inclusive). */
  startHour: number;
  /** CDMX wall-clock hour it closes (exclusive). */
  endHour: number;
  /** Estimated whisper minutes at or under which we transcribe immediately. */
  immediateMaxWhisperMin: number;
}

export type TranscribeDecision =
  | { mode: 'now'; estimateSec: number }
  | { mode: 'scheduled'; atMs: number; estimateSec: number };

/** The measured cost model: fixed per-invocation overhead + linear in audio. */
export function estimateWhisperSeconds(bursts: number, audioSeconds: number): number {
  return WHISPER_FIXED_SEC_PER_BURST * bursts + WHISPER_SEC_PER_AUDIO_SEC * audioSeconds;
}

/**
 * What a closed session dir has LEFT to transcribe: bursts that meet the
 * length floor and are not already covered by the live-transcription ledger.
 * With live transcription keeping pace during the meeting, this is normally
 * just the last un-flushed remainder — so even a long assembly finalizes
 * immediately, and the nightly deferral only triggers for crash-recovered
 * sessions with a real backlog.
 */
export function measureSessionDir(dir: string): { bursts: number; audioSeconds: number } {
  const audioDir = join(dir, ARTIFACTS.audioDir);
  if (!existsSync(audioDir)) return { bursts: 0, audioSeconds: 0 };
  const ledger = readLedger(dir);
  let bursts = 0;
  let bytes = 0;
  for (const f of readdirSync(audioDir)) {
    if (!f.endsWith('.pcm')) continue;
    if (f.startsWith('batch-')) continue; // transient concat artifact, not a burst
    if (ledger.has(`${ARTIFACTS.audioDir}/${f}`)) continue; // already transcribed live
    let size = 0;
    try {
      size = statSync(join(audioDir, f)).size;
    } catch {
      continue;
    }
    if (size < MIN_BURST_BYTES) continue;
    bursts += 1;
    bytes += size;
  }
  return { bursts, audioSeconds: bytes / PCM_BYTES_PER_SECOND };
}

/** Minutes since midnight, CDMX wall clock (fixed UTC-6 — Mexico has no DST). */
export function cdmxMinuteOfDay(nowMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  // Intl renders midnight as "24" under hourCycle h24 quirks; normalize.
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** Whether a CDMX minute-of-day falls inside [startHour, endHour), wrap-safe. */
export function inHeavyWindow(minuteOfDay: number, startHour: number, endHour: number): boolean {
  const start = startHour * 60;
  const end = endHour * 60;
  if (start === end) return false; // zero-width window = feature off
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end; // wraps midnight
}

/** ms from `nowMs` until the next `startHour`:00 CDMX (0 if that is now). */
export function msUntilWindowStart(nowMs: number, startHour: number): number {
  const minute = cdmxMinuteOfDay(nowMs);
  const secondsIntoMinute = Math.floor(nowMs / 1000) % 60;
  const deltaMin = (startHour * 60 - minute + 24 * 60) % (24 * 60);
  if (deltaMin === 0) return 0;
  return deltaMin * 60_000 - secondsIntoMinute * 1000;
}

/**
 * The policy: cheap → now; already inside the window → now; otherwise → the
 * next window start. `immediateMaxWhisperMin: 0` defers everything that isn't
 * already in the window (there is no "never transcribe" state by design — a
 * session always gets a minuta eventually).
 */
export function decideTranscribeAt(
  nowMs: number,
  estimateSec: number,
  cfg: HeavyWindowConfig,
): TranscribeDecision {
  if (estimateSec <= cfg.immediateMaxWhisperMin * 60) return { mode: 'now', estimateSec };
  if (inHeavyWindow(cdmxMinuteOfDay(nowMs), cfg.startHour, cfg.endHour)) {
    return { mode: 'now', estimateSec };
  }
  return { mode: 'scheduled', atMs: nowMs + msUntilWindowStart(nowMs, cfg.startHour), estimateSec };
}

/** "HH:MM" in CDMX for user-facing "la publico a las …" messages. */
export function formatCdmxTime(atMs: number): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(atMs));
}
