import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import { log } from '../../log.js';

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
  /** Transcribe a 16 kHz mono WAV; rejects on engine failure. */
  transcribe(wavPath: string, outBase: string): Promise<TranscriptSegment[]>;
}

interface WhisperCliOptions {
  bin: string;
  modelPath: string;
  language: string;
  threads: number;
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

  transcribe(wavPath: string, outBase: string): Promise<TranscriptSegment[]> {
    const run = this.queue.then(() => this.transcribeNow(wavPath, outBase));
    this.queue = run.catch(() => {});
    return run;
  }

  private async transcribeNow(wavPath: string, outBase: string): Promise<TranscriptSegment[]> {
    const started = Date.now();
    const running = execFileAsync(
      this.opts.bin,
      [
        '-m', this.opts.modelPath,
        '-f', wavPath,
        '-l', this.opts.language,
        '-oj',
        '-of', outBase,
        '-t', String(this.opts.threads),
        '-np',
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
        log.debug({ err: String(err), pid }, 'minutas.whisper_nice_failed');
      }
    }
    await running;
    const raw = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as {
      transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
    };
    const segments: TranscriptSegment[] = (raw.transcription ?? [])
      .map((t) => ({
        startMs: Math.max(0, Math.round(t.offsets?.from ?? 0)),
        endMs: Math.max(0, Math.round(t.offsets?.to ?? 0)),
        text: (t.text ?? '').trim(),
      }))
      .filter((s) => s.text.length > 0);
    log.info(
      { wavPath, segments: segments.length, tookMs: Date.now() - started },
      'minutas.transcribed',
    );
    return segments;
  }
}
