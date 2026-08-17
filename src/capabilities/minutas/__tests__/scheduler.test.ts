import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cdmxMinuteOfDay,
  decideTranscribeAt,
  estimateWhisperSeconds,
  formatCdmxTime,
  inHeavyWindow,
  measureSessionDir,
  msUntilWindowStart,
} from '../scheduler.js';
import {
  ARTIFACTS,
  MIN_BURST_BYTES,
  PCM_BYTES_PER_SECOND,
  WHISPER_FIXED_SEC_PER_BURST,
  WHISPER_SEC_PER_AUDIO_SEC,
} from '../constants.js';

/** ms-epoch for a CDMX wall-clock instant (fixed UTC-6, Mexico has no DST). */
function atCdmx(y: number, mo: number, d: number, h: number, mi = 0, s = 0): number {
  return Date.UTC(y, mo - 1, d, h + 6, mi, s);
}

const WINDOW = { startHour: 1, endHour: 8, immediateMaxWhisperMin: 15 };

describe('estimateWhisperSeconds', () => {
  it('applies the measured cost model', () => {
    expect(estimateWhisperSeconds(0, 0)).toBe(0);
    expect(estimateWhisperSeconds(10, 100)).toBeCloseTo(
      10 * WHISPER_FIXED_SEC_PER_BURST + 100 * WHISPER_SEC_PER_AUDIO_SEC,
    );
    // The 2026-08-16 assembly: 155 bursts, 3976 s of audio → ~76 min (observed ~74).
    expect(estimateWhisperSeconds(155, 3976) / 60).toBeCloseTo(76.3, 0);
  });
});

describe('cdmxMinuteOfDay / inHeavyWindow', () => {
  it('converts an epoch to CDMX wall-clock minutes', () => {
    expect(cdmxMinuteOfDay(atCdmx(2026, 8, 17, 22, 0))).toBe(22 * 60);
    expect(cdmxMinuteOfDay(atCdmx(2026, 8, 17, 0, 5))).toBe(5);
  });

  it('handles a plain window and one that wraps midnight', () => {
    expect(inHeavyWindow(2 * 60, 1, 8)).toBe(true);
    expect(inHeavyWindow(8 * 60, 1, 8)).toBe(false); // end is exclusive
    expect(inHeavyWindow(22 * 60, 1, 8)).toBe(false);
    expect(inHeavyWindow(23 * 60 + 30, 23, 6)).toBe(true); // wraps
    expect(inHeavyWindow(3 * 60, 23, 6)).toBe(true);
    expect(inHeavyWindow(12 * 60, 23, 6)).toBe(false);
    expect(inHeavyWindow(500, 4, 4)).toBe(false); // zero-width = off
  });
});

describe('msUntilWindowStart', () => {
  it('counts down to the next window start, second-accurate', () => {
    const at2200 = atCdmx(2026, 8, 17, 22, 0, 30);
    // 22:00:30 → 01:00 next day = 3 h − 30 s
    expect(msUntilWindowStart(at2200, 1)).toBe(3 * 3600_000 - 30_000);
    // 09:00 → next 01:00 is 16 h away
    expect(msUntilWindowStart(atCdmx(2026, 8, 17, 9, 0), 1)).toBe(16 * 3600_000);
  });
});

describe('decideTranscribeAt', () => {
  const evening = atCdmx(2026, 8, 17, 22, 30);

  it('short sessions transcribe immediately, day or night', () => {
    const d = decideTranscribeAt(evening, 10 * 60, WINDOW);
    expect(d.mode).toBe('now');
  });

  it('a heavy evening session defers to the next window start', () => {
    const d = decideTranscribeAt(evening, 74 * 60, WINDOW);
    expect(d.mode).toBe('scheduled');
    if (d.mode === 'scheduled') {
      expect(d.atMs).toBe(atCdmx(2026, 8, 18, 1, 0));
      expect(formatCdmxTime(d.atMs)).toBe('01:00');
    }
  });

  it('a heavy session already inside the window runs right away', () => {
    const night = atCdmx(2026, 8, 18, 2, 15);
    expect(decideTranscribeAt(night, 74 * 60, WINDOW).mode).toBe('now');
  });

  it('immediateMaxWhisperMin: 0 defers everything outside the window', () => {
    const d = decideTranscribeAt(evening, 30, { ...WINDOW, immediateMaxWhisperMin: 0 });
    expect(d.mode).toBe('scheduled');
  });
});

describe('measureSessionDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minutas-sched-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('counts only bursts that meet the length floor', () => {
    const audio = join(dir, ARTIFACTS.audioDir);
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, '001-a.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 2)); // 2 s
    writeFileSync(join(audio, '002-b.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 3)); // 3 s
    writeFileSync(join(audio, '003-c.pcm'), Buffer.alloc(MIN_BURST_BYTES - 1)); // below floor
    writeFileSync(join(audio, 'notes.txt'), 'ignored');
    const m = measureSessionDir(dir);
    expect(m.bursts).toBe(2);
    expect(m.audioSeconds).toBeCloseTo(5);
  });

  it('excludes live-transcribed bursts and batch artifacts from the estimate', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'minutas-sched-ledger-'));
    try {
      const audio = join(d2, ARTIFACTS.audioDir);
      mkdirSync(audio, { recursive: true });
      writeFileSync(join(audio, '001-a.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 2));
      writeFileSync(join(audio, '002-b.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 3));
      writeFileSync(join(audio, 'batch-001-a.pcm'), Buffer.alloc(PCM_BYTES_PER_SECOND * 5)); // transient
      // 001 already covered by the live ledger → only 002 remains to estimate.
      writeFileSync(
        join(d2, ARTIFACTS.liveLedger),
        JSON.stringify({ file: 'audio/001-a.pcm', userId: 'u', speaker: 'a', startedAtMs: 0, segments: [] }) + '\n',
      );
      const m = measureSessionDir(d2);
      expect(m.bursts).toBe(1);
      expect(m.audioSeconds).toBeCloseTo(3);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it('an absent audio dir measures as zero (crash before first burst)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'minutas-sched-empty-'));
    try {
      expect(measureSessionDir(empty)).toEqual({ bursts: 0, audioSeconds: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
