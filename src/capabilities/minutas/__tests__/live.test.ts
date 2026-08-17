import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LiveTranscriber,
  appendLedger,
  mapBatchSegments,
  planBatches,
  readLedger,
  transcribeBatch,
  type LedgerEntry,
  type PendingBurst,
} from '../live.js';
import { concatenatePcmFiles } from '../audio.js';
import {
  ARTIFACTS,
  BATCH_GAP_MS,
  LIVE_FLUSH_MAX_BURSTS,
  PCM_BYTES_PER_SECOND,
} from '../constants.js';
import type { Transcriber, TranscriptSegment } from '../transcriber.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function burst(over: Partial<PendingBurst> & { seq: number }): PendingBurst {
  return {
    userId: 'u1',
    speaker: 'Ana',
    file: `audio/${String(over.seq).padStart(3, '0')}-x.pcm`,
    startedAtMs: over.seq * 10_000,
    bytes: PCM_BYTES_PER_SECOND * 2, // 2 s
    ...over,
  };
}

describe('planBatches', () => {
  it('groups per speaker — batches never mix voices', () => {
    const batches = planBatches([
      burst({ seq: 1, speaker: 'Ana' }),
      burst({ seq: 2, speaker: 'Beto', userId: 'u2' }),
      burst({ seq: 3, speaker: 'Ana' }),
    ]);
    expect(batches).toHaveLength(2);
    const ana = batches.find((b) => b.speaker === 'Ana')!;
    expect(ana.bursts.map((b) => b.seq)).toEqual([1, 3]);
    expect(ana.name).toBe('batch-001-Ana');
    expect(batches.find((b) => b.speaker === 'Beto')!.name).toBe('batch-002-Beto');
  });

  it('splits a speaker into more batches when the audio cap is exceeded', () => {
    const big = [
      burst({ seq: 1, bytes: PCM_BYTES_PER_SECOND * 40 }),
      burst({ seq: 2, bytes: PCM_BYTES_PER_SECOND * 40 }),
      burst({ seq: 3, bytes: PCM_BYTES_PER_SECOND * 40 }),
    ];
    const batches = planBatches(big, 60); // cap: 60 s
    expect(batches.map((b) => b.bursts.length)).toEqual([1, 1, 1]);
    expect(new Set(batches.map((b) => b.name)).size).toBe(3); // unique artifact names
  });
});

describe('mapBatchSegments', () => {
  const slots = [
    { burst: burst({ seq: 1, startedAtMs: 60_000 }), offsetMs: 0, durationMs: 2000 },
    { burst: burst({ seq: 2, startedAtMs: 90_000 }), offsetMs: 3000, durationMs: 2000 }, // 1 s gap
  ];

  it('attributes segments to the burst containing their midpoint, re-based', () => {
    const entries = mapBatchSegments(
      [
        { startMs: 100, endMs: 1900, text: 'primera intervención' },
        { startMs: 3100, endMs: 4800, text: 'segunda intervención' },
      ],
      slots,
    );
    expect(entries[0]!.segments).toEqual([{ startMs: 100, endMs: 1900, text: 'primera intervención' }]);
    expect(entries[0]!.startedAtMs).toBe(60_000);
    expect(entries[1]!.segments).toEqual([{ startMs: 100, endMs: 1800, text: 'segunda intervención' }]);
  });

  it('drops segments whose midpoint falls in a silence gap (concat hallucination)', () => {
    const entries = mapBatchSegments([{ startMs: 2100, endMs: 2900, text: 'Subtítulos por la comunidad' }], slots);
    expect(entries[0]!.segments).toEqual([]);
    expect(entries[1]!.segments).toEqual([]);
  });

  it('clamps a segment that bleeds across a join to its owning burst', () => {
    const entries = mapBatchSegments([{ startMs: 1500, endMs: 3500, text: 'cruza la unión' }], slots);
    // midpoint 2500 → the gap: dropped. Midpoint just inside burst 1:
    const entries2 = mapBatchSegments([{ startMs: 500, endMs: 2600, text: 'cruza la unión' }], slots);
    expect(entries[0]!.segments.length + entries[1]!.segments.length).toBe(0);
    expect(entries2[0]!.segments).toEqual([{ startMs: 500, endMs: 2000, text: 'cruza la unión' }]);
  });

  it('every burst gets an entry even with zero segments — silence must ledger as done', () => {
    const entries = mapBatchSegments([], slots);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.segments.length === 0)).toBe(true);
  });
});

describe('ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minutas-ledger-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips entries and survives a torn tail line', () => {
    const entry: LedgerEntry = {
      file: 'audio/001-Ana.pcm',
      userId: 'u1',
      speaker: 'Ana',
      startedAtMs: 5000,
      segments: [{ startMs: 0, endMs: 900, text: 'hola asamblea' }],
    };
    appendLedger(dir, [entry]);
    // Simulate a crash mid-append: garbage half-line at the tail.
    writeFileSync(join(dir, ARTIFACTS.liveLedger), '{"file":"audio/002-B', { flag: 'a' });
    const ledger = readLedger(dir);
    expect(ledger.size).toBe(1);
    expect(ledger.get('audio/001-Ana.pcm')).toEqual(entry);
  });

  it('an absent ledger reads as empty', () => {
    const empty = mkdtempSync(join(tmpdir(), 'minutas-ledger-empty-'));
    try {
      expect(readLedger(empty).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('concatenatePcmFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minutas-concat-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('byte-concatenates with sample-aligned silence gaps and exact offsets', async () => {
    const a = join(dir, 'a.pcm');
    const b = join(dir, 'b.pcm');
    writeFileSync(a, Buffer.alloc(PCM_BYTES_PER_SECOND, 1)); // 1 s of non-zero
    writeFileSync(b, Buffer.alloc(PCM_BYTES_PER_SECOND * 2, 2)); // 2 s
    const out = join(dir, 'out.pcm');
    const slots = await concatenatePcmFiles([a, b], out, BATCH_GAP_MS);
    expect(slots).toEqual([
      { path: a, offsetMs: 0, durationMs: 1000 },
      { path: b, offsetMs: 2000, durationMs: 2000 }, // 1 s audio + 1 s gap
    ]);
    const bytes = readFileSync(out);
    expect(bytes.length).toBe(PCM_BYTES_PER_SECOND * 4);
    expect(bytes[0]).toBe(1);
    expect(bytes[PCM_BYTES_PER_SECOND + 100]).toBe(0); // the gap is silence
    expect(bytes[PCM_BYTES_PER_SECOND * 2 + 100]).toBe(2);
  });
});

class RecordingTranscriber implements Transcriber {
  calls: string[] = [];
  segments: TranscriptSegment[] = [];
  failNext = false;
  isAvailable(): boolean {
    return true;
  }
  async transcribe(wavPath: string, outBase: string): Promise<TranscriptSegment[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('whisper exploded');
    }
    this.calls.push(basename(wavPath));
    await writeFile(`${outBase}.json`, JSON.stringify({ transcription: [] }));
    return this.segments;
  }
}

describe.skipIf(!hasFfmpeg)('transcribeBatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minutas-batch-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('concat → wav → whisper → mapped ledger entries; concat pcm cleaned up', async () => {
    mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
    mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
    writeFileSync(join(dir, 'audio/001-Ana.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 2));
    writeFileSync(join(dir, 'audio/003-Ana.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND));
    const t = new RecordingTranscriber();
    // One segment per burst, expressed in concat-file time (gap = 1 s).
    t.segments = [
      { startMs: 200, endMs: 1800, text: 'abro la sesión' },
      { startMs: 3100, endMs: 3900, text: 'y cierro el punto' },
    ];
    const bursts = [
      burst({ seq: 1, file: 'audio/001-Ana.pcm', startedAtMs: 0, bytes: PCM_BYTES_PER_SECOND * 2 }),
      burst({ seq: 3, file: 'audio/003-Ana.pcm', startedAtMs: 30_000, bytes: PCM_BYTES_PER_SECOND }),
    ];

    const entries = await transcribeBatch(t, dir, { name: 'batch-001-Ana', speaker: 'Ana', bursts });

    expect(t.calls).toEqual(['batch-001-Ana.wav']); // ONE whisper call for two bursts
    expect(entries[0]!.segments).toEqual([{ startMs: 200, endMs: 1800, text: 'abro la sesión' }]);
    expect(entries[1]!.segments).toEqual([{ startMs: 100, endMs: 900, text: 'y cierro el punto' }]);
    expect(readLedger(dir).size).toBe(2);
    expect(existsSync(join(dir, 'audio/batch-001-Ana.pcm'))).toBe(false); // temp removed
    expect(existsSync(join(dir, 'audio/batch-001-Ana.wav'))).toBe(true); // archive kept
  });
});

describe.skipIf(!hasFfmpeg)('LiveTranscriber', () => {
  it('holds below the threshold, flushes at it, and ledgers the batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minutas-livewk-'));
    try {
      mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
      mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
      const t = new RecordingTranscriber();
      const live = new LiveTranscriber(t);
      // LIVE_FLUSH_MAX_BURSTS short bursts trip the count threshold.
      for (let seq = 1; seq <= LIVE_FLUSH_MAX_BURSTS; seq++) {
        const file = `audio/${String(seq).padStart(3, '0')}-Ana.pcm`;
        writeFileSync(join(dir, file), Buffer.alloc(PCM_BYTES_PER_SECOND));
        live.enqueue(dir, burst({ seq, file, bytes: PCM_BYTES_PER_SECOND }));
        if (seq < LIVE_FLUSH_MAX_BURSTS) expect(t.calls).toHaveLength(0);
      }
      await new Promise((r) => setTimeout(r, 400)); // flush is fire-and-forget
      expect(t.calls).toEqual(['batch-001-Ana.wav']);
      expect(readLedger(dir).size).toBe(LIVE_FLUSH_MAX_BURSTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed flush leaves bursts unledgered for finalize — nothing lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minutas-livewk-fail-'));
    try {
      mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
      mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
      const t = new RecordingTranscriber();
      t.failNext = true;
      const live = new LiveTranscriber(t);
      for (let seq = 1; seq <= LIVE_FLUSH_MAX_BURSTS; seq++) {
        const file = `audio/${String(seq).padStart(3, '0')}-Ana.pcm`;
        writeFileSync(join(dir, file), Buffer.alloc(PCM_BYTES_PER_SECOND));
        live.enqueue(dir, burst({ seq, file, bytes: PCM_BYTES_PER_SECOND }));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(readLedger(dir).size).toBe(0); // finalize will pick them all up
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
