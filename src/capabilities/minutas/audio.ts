import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import opus from '@discordjs/opus';
import { log } from '../../log.js';
import {
  DECODER_REBUILD_AFTER_ERRORS,
  OPUS_CHANNELS,
  OPUS_SAMPLE_RATE,
  PCM_BYTES_PER_SECOND,
} from './constants.js';

const { OpusEncoder } = opus;
const FFMPEG = 'ffmpeg';

/** What one burst's recording produced — the caller uses this to notice a
 * decoder that has stopped producing audio (see `packets > 0 && bytes === 0`). */
export interface BurstRecording {
  /** Bytes of 16 kHz mono PCM written to disk. */
  bytes: number;
  /** Opus packets received from Discord. */
  packets: number;
  /** Packets libopus refused; each costs 20 ms of audio, not the burst. */
  decodeErrors: number;
}

/**
 * Decode one speaker's Discord Opus packet stream into raw PCM on disk.
 *
 * Decoding is done packet-by-packet through the NATIVE libopus binding
 * (`@discordjs/opus`) rather than piped through a Transform, so a packet that
 * fails costs 20 ms of audio and nothing else.
 *
 * Why not prism-media: on this deployment it resolved to `opusscript`, a
 * pure-WASM decoder that allocates inside a FIXED WASM linear memory and must
 * be released with `.delete()`. prism only does that from `_destroy()`, which
 * the old `pipe()`-based code never reliably triggered, so every burst leaked
 * one decoder. Measured: the heap is exhausted after ~55 un-freed decoders,
 * after which `memory access out of bounds` is thrown by every allocation
 * *process-wide* — including brand-new decoders. That is what silently killed
 * capture 233 bursts into the 2026-08-16 assembly and could not recover without
 * a restart. Native libopus allocates on the ordinary process heap and is freed
 * by GC, so there is no small fixed ceiling to hit.
 *
 * ffmpeg downmixes/resamples 48 kHz stereo to the 16 kHz mono s16le whisper.cpp
 * wants. The output is headerless PCM (not WAV) on purpose: a bot crash
 * mid-burst leaves a fully-usable file, while a WAV would carry a
 * never-finalized header. `pcmToWav()` wraps it at finalize time.
 *
 * Resolves when the opus stream ends and ffmpeg has flushed; rejects only when
 * ffmpeg itself failed.
 */
export function recordOpusStreamToPcm(
  opusStream: Readable,
  outPcmPath: string,
): Promise<BurstRecording> {
  return new Promise((resolve, reject) => {
    let decoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(OPUS_SAMPLE_RATE), '-ac', String(OPUS_CHANNELS), '-i', 'pipe:0',
      '-af', 'aresample=16000', '-ac', '1',
      '-f', 's16le', '-y', outPcmPath,
    ]);

    let stderr = '';
    let packets = 0;
    let decodeErrors = 0;
    let consecutiveErrors = 0;
    let settled = false;

    ff.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    // ffmpeg exiting first turns further writes into EPIPE; that is reported by
    // the close handler, so swallow the write-side error rather than crashing.
    ff.stdin.on('error', () => {});
    ff.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      if (decodeErrors > 0) {
        log.warn(
          { outPcmPath, packets, decodeErrors },
          'minutas.opus_decode_errors — packets dropped from this burst',
        );
      }
      try {
        resolve({ bytes: statSync(outPcmPath).size, packets, decodeErrors });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    opusStream.on('data', (packet: Buffer) => {
      packets += 1;
      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet);
        consecutiveErrors = 0;
      } catch (err) {
        decodeErrors += 1;
        consecutiveErrors += 1;
        // A run of failures means this decoder instance is wedged, not that the
        // packets are bad. Replace it and keep the burst alive.
        if (consecutiveErrors === DECODER_REBUILD_AFTER_ERRORS) {
          try {
            decoder = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
            log.warn({ outPcmPath, decodeErrors }, 'minutas.opus_decoder_rebuilt');
          } catch (rebuildErr) {
            log.error(
              { err: String(rebuildErr), outPcmPath },
              'minutas.opus_decoder_rebuild_failed',
            );
          }
        }
        return;
      }
      if (ff.stdin.destroyed || ff.stdin.writableEnded) return;
      if (!ff.stdin.write(pcm)) {
        opusStream.pause();
        ff.stdin.once('drain', () => opusStream.resume());
      }
    });

    const endInput = (): void => {
      if (!ff.stdin.destroyed && !ff.stdin.writableEnded) ff.stdin.end();
    };
    opusStream.on('end', endInput);
    opusStream.on('close', endInput);
    opusStream.on('error', (err) => {
      log.warn({ err: String(err), outPcmPath }, 'minutas.opus_stream_error');
      endInput();
    });
  });
}

/** Wrap a raw 16 kHz mono s16le PCM file in a WAV header (for whisper-cli). */
export function pcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcmPath,
      '-f', 'wav', '-y', wavPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    ff.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`)),
    );
  });
}

/** Duration of a 16 kHz mono s16le PCM file, from its byte size. */
export function pcmDurationMs(bytes: number): number {
  return Math.round((bytes / PCM_BYTES_PER_SECOND) * 1000);
}

/** Where each input landed inside a concatenated PCM file. */
export interface PcmConcatSlot {
  /** Absolute path of the source PCM file. */
  path: string;
  /** Offset of this file's audio inside the output, in ms. */
  offsetMs: number;
  /** Duration of this file's audio, in ms. */
  durationMs: number;
}

/**
 * Concatenate raw 16 kHz mono s16le PCM files into one, with `gapMs` of
 * silence between them (headerless PCM concatenation is plain byte
 * concatenation — no ffmpeg involved). Returns where each input sits in the
 * output so transcription segments can be mapped back to their source burst.
 */
export async function concatenatePcmFiles(
  paths: string[],
  outPath: string,
  gapMs: number,
): Promise<PcmConcatSlot[]> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const gapBytes = Math.round((gapMs / 1000) * PCM_BYTES_PER_SECOND) & ~1; // sample-aligned
  const gap = Buffer.alloc(gapBytes);
  const slots: PcmConcatSlot[] = [];
  const parts: Buffer[] = [];
  let offsetBytes = 0;
  for (let i = 0; i < paths.length; i++) {
    if (i > 0) {
      parts.push(gap);
      offsetBytes += gapBytes;
    }
    const bytes = await readFile(paths[i]!);
    slots.push({
      path: paths[i]!,
      offsetMs: pcmDurationMs(offsetBytes),
      durationMs: pcmDurationMs(bytes.length),
    });
    parts.push(bytes);
    offsetBytes += bytes.length;
  }
  await writeFile(outPath, Buffer.concat(parts));
  return slots;
}

/**
 * True when a finished burst received audio but wrote none — the signature of
 * a decoder that has stopped working, as opposed to a speaker who said nothing.
 */
export function burstCapturedNothing(result: BurstRecording): boolean {
  return result.packets > 0 && result.bytes === 0;
}

/**
 * Counts consecutive bursts that captured nothing, and says when to shout.
 * Extracted from the session so the guard can be tested without a live voice
 * connection — it is the thing standing between a wedged decoder and an
 * assembly that silently goes unrecorded.
 */
export class CaptureHealth {
  private consecutive = 0;
  private alarmed = false;

  constructor(private readonly threshold: number) {}

  /** Record one burst outcome; true exactly once, when the alarm should fire. */
  record(captured: boolean): boolean {
    if (captured) {
      this.consecutive = 0;
      return false;
    }
    this.consecutive += 1;
    if (this.consecutive < this.threshold || this.alarmed) return false;
    this.alarmed = true;
    return true;
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }
}

/** Filesystem-safe fragment for per-speaker artifact names. */
export function sanitizeFileFragment(s: string): string {
  const clean = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return clean || 'anon';
}
