import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { estimateWhisperSeconds, measureSessionDir } from "../scheduler.js";
import {
   ARTIFACTS,
   MIN_BURST_BYTES,
   PCM_BYTES_PER_SECOND,
   WHISPER_FIXED_SEC_PER_BURST,
   WHISPER_SEC_PER_AUDIO_SEC,
} from "../constants.js";

describe("estimateWhisperSeconds", () => {
   it("applies the measured cost model", () => {
      expect(estimateWhisperSeconds(0, 0)).toBe(0);
      expect(estimateWhisperSeconds(10, 100)).toBeCloseTo(
         10 * WHISPER_FIXED_SEC_PER_BURST + 100 * WHISPER_SEC_PER_AUDIO_SEC,
      );
      // The 2026-08-16 assembly: 155 bursts, 3976 s of audio → ~76 min (observed ~74).
      expect(estimateWhisperSeconds(155, 3976) / 60).toBeCloseTo(76.3, 0);
   });
});

describe("measureSessionDir", () => {
   const dir = mkdtempSync(join(tmpdir(), "minutas-sched-"));
   afterAll(() => rmSync(dir, { recursive: true, force: true }));

   it("counts only bursts that meet the length floor", () => {
      const audio = join(dir, ARTIFACTS.audioDir);
      mkdirSync(audio, { recursive: true });
      writeFileSync(
         join(audio, "001-a.pcm"),
         Buffer.alloc(PCM_BYTES_PER_SECOND * 2),
      ); // 2 s
      writeFileSync(
         join(audio, "002-b.pcm"),
         Buffer.alloc(PCM_BYTES_PER_SECOND * 3),
      ); // 3 s
      writeFileSync(
         join(audio, "003-c.pcm"),
         Buffer.alloc(MIN_BURST_BYTES - 1),
      ); // below floor
      writeFileSync(join(audio, "notes.txt"), "ignored");
      const m = measureSessionDir(dir);
      expect(m.bursts).toBe(2);
      expect(m.audioSeconds).toBeCloseTo(5);
   });

   it("excludes live-transcribed bursts and batch artifacts from the estimate", () => {
      const d2 = mkdtempSync(join(tmpdir(), "minutas-sched-ledger-"));
      try {
         const audio = join(d2, ARTIFACTS.audioDir);
         mkdirSync(audio, { recursive: true });
         writeFileSync(
            join(audio, "001-a.pcm"),
            Buffer.alloc(PCM_BYTES_PER_SECOND * 2),
         );
         writeFileSync(
            join(audio, "002-b.pcm"),
            Buffer.alloc(PCM_BYTES_PER_SECOND * 3),
         );
         writeFileSync(
            join(audio, "batch-001-a.pcm"),
            Buffer.alloc(PCM_BYTES_PER_SECOND * 5),
         ); // transient
         // 001 already covered by the live ledger → only 002 remains to estimate.
         writeFileSync(
            join(d2, ARTIFACTS.liveLedger),
            JSON.stringify({
               file: "audio/001-a.pcm",
               userId: "u",
               speaker: "a",
               startedAtMs: 0,
               segments: [],
            }) + "\n",
         );
         const m = measureSessionDir(d2);
         expect(m.bursts).toBe(1);
         expect(m.audioSeconds).toBeCloseTo(3);
      } finally {
         rmSync(d2, { recursive: true, force: true });
      }
   });

   it("an absent audio dir measures as zero (crash before first burst)", () => {
      const empty = mkdtempSync(join(tmpdir(), "minutas-sched-empty-"));
      try {
         expect(measureSessionDir(empty)).toEqual({
            bursts: 0,
            audioSeconds: 0,
         });
      } finally {
         rmSync(empty, { recursive: true, force: true });
      }
   });
});
