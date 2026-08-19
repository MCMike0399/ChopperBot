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
 * Leftover-whisper accounting for a closed session.
 *
 * Live transcription already runs during the meeting, so finalize's remaining
 * work is the last un-flushed tail — not an hour of backlog. These helpers
 * measure that tail (and keep the measured cost model) for logs. There is no
 * nightly deferral: leave always finalizes now (2026-08-19).
 */

/** The measured cost model: fixed per-invocation overhead + linear in audio. */
export function estimateWhisperSeconds(bursts: number, audioSeconds: number): number {
  return WHISPER_FIXED_SEC_PER_BURST * bursts + WHISPER_SEC_PER_AUDIO_SEC * audioSeconds;
}

/**
 * What a closed session dir has LEFT to transcribe: bursts that meet the
 * length floor and are not already covered by the live-transcription ledger.
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
