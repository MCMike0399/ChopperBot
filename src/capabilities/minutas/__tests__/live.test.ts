import {
   mkdirSync,
   mkdtempSync,
   readFileSync,
   rmSync,
   writeFileSync,
   existsSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
   LiveTranscriber,
   appendLedger,
   mapBatchSegments,
   planBatches,
   readLedger,
   transcribeBatch,
   type LedgerEntry,
   type PendingBurst,
} from "../live.js";
import { concatenatePcmFiles } from "../audio.js";
import {
   ARTIFACTS,
   BATCH_GAP_MS,
   LIVE_FLUSH_MAX_BURSTS,
   PCM_BYTES_PER_SECOND,
} from "../constants.js";
import type { Transcriber, TranscriptSegment } from "../transcriber.js";

const hasFfmpeg =
   spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function burst(over: Partial<PendingBurst> & { seq: number }): PendingBurst {
   return {
      userId: "u1",
      speaker: "Ana",
      file: `audio/${String(over.seq).padStart(3, "0")}-x.pcm`,
      startedAtMs: over.seq * 10_000,
      bytes: PCM_BYTES_PER_SECOND * 2, // 2 s
      ...over,
   };
}

describe("planBatches", () => {
   it("groups per speaker — batches never mix voices", () => {
      const batches = planBatches([
         burst({ seq: 1, speaker: "Ana" }),
         burst({ seq: 2, speaker: "Beto", userId: "u2" }),
         burst({ seq: 3, speaker: "Ana" }),
      ]);
      expect(batches).toHaveLength(2);
      const ana = batches.find((b) => b.speaker === "Ana")!;
      expect(ana.bursts.map((b) => b.seq)).toEqual([1, 3]);
      expect(ana.name).toBe("batch-001-Ana");
      expect(batches.find((b) => b.speaker === "Beto")!.name).toBe(
         "batch-002-Beto",
      );
   });

   it("splits a speaker into more batches when the audio cap is exceeded", () => {
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

describe("mapBatchSegments", () => {
   const slots = [
      {
         burst: burst({ seq: 1, startedAtMs: 60_000 }),
         offsetMs: 0,
         durationMs: 2000,
      },
      {
         burst: burst({ seq: 2, startedAtMs: 90_000 }),
         offsetMs: 3000,
         durationMs: 2000,
      }, // 1 s gap
   ];

   it("attributes segments to the burst containing their midpoint, re-based", () => {
      const entries = mapBatchSegments(
         [
            { startMs: 100, endMs: 1900, text: "primera intervención" },
            { startMs: 3100, endMs: 4800, text: "segunda intervención" },
         ],
         slots,
      );
      expect(entries[0]!.segments).toEqual([
         { startMs: 100, endMs: 1900, text: "primera intervención" },
      ]);
      expect(entries[0]!.startedAtMs).toBe(60_000);
      expect(entries[1]!.segments).toEqual([
         { startMs: 100, endMs: 1800, text: "segunda intervención" },
      ]);
   });

   it("drops whisper's stock hallucinations wherever they land", () => {
      const entries = mapBatchSegments(
         [
            { startMs: 2100, endMs: 2900, text: "Subtítulos por la comunidad" },
            { startMs: 200, endMs: 900, text: "[Música]" },
            { startMs: 3200, endMs: 4000, text: "¡Suscríbete!" },
         ],
         slots,
      );
      expect(entries[0]!.segments).toEqual([]);
      expect(entries[1]!.segments).toEqual([]);
   });

   it("keeps real speech that straddles a join — goes to the burst it overlaps most", () => {
      // 2026-09-23 audit: the midpoint rule dropped «Y abstención.» and a
      // proposed date this way. Overlap: 300 ms with burst 1, 1200 ms with burst 2.
      const entries = mapBatchSegments(
         [{ startMs: 1700, endMs: 4200, text: "la segunda semana de octubre" }],
         slots,
      );
      expect(entries[0]!.segments).toEqual([]);
      expect(entries[1]!.segments).toEqual([
         { startMs: 0, endMs: 1200, text: "la segunda semana de octubre" },
      ]);
   });

   it("a segment entirely inside the gap or past the file end goes to the nearest burst", () => {
      const entries = mapBatchSegments(
         [
            { startMs: 2100, endMs: 2400, text: "Y abstención." },
            { startMs: 5200, endMs: 5900, text: "actividades." },
         ],
         slots,
      );
      expect(entries[0]!.segments.map((s) => s.text)).toEqual([
         "Y abstención.",
      ]);
      expect(entries[0]!.segments[0]).toEqual({
         startMs: 2000,
         endMs: 2000,
         text: "Y abstención.",
      });
      expect(entries[1]!.segments.map((s) => s.text)).toEqual(["actividades."]);
   });

   it("clamps a segment that bleeds across a join to its owning burst", () => {
      const entries = mapBatchSegments(
         [{ startMs: 500, endMs: 2600, text: "cruza la unión" }],
         slots,
      );
      expect(entries[0]!.segments).toEqual([
         { startMs: 500, endMs: 2000, text: "cruza la unión" },
      ]);
   });

   it("every burst gets an entry even with zero segments — silence must ledger as done", () => {
      const entries = mapBatchSegments([], slots);
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.segments.length === 0)).toBe(true);
   });
});

describe("ledger", () => {
   const dir = mkdtempSync(join(tmpdir(), "minutas-ledger-"));
   afterAll(() => rmSync(dir, { recursive: true, force: true }));

   it("round-trips entries and survives a torn tail line", () => {
      const entry: LedgerEntry = {
         file: "audio/001-Ana.pcm",
         userId: "u1",
         speaker: "Ana",
         startedAtMs: 5000,
         segments: [{ startMs: 0, endMs: 900, text: "hola asamblea" }],
      };
      appendLedger(dir, [entry]);
      // Simulate a crash mid-append: garbage half-line at the tail.
      writeFileSync(join(dir, ARTIFACTS.liveLedger), '{"file":"audio/002-B', {
         flag: "a",
      });
      const ledger = readLedger(dir);
      expect(ledger.size).toBe(1);
      expect(ledger.get("audio/001-Ana.pcm")).toEqual(entry);
   });

   it("an absent ledger reads as empty", () => {
      const empty = mkdtempSync(join(tmpdir(), "minutas-ledger-empty-"));
      try {
         expect(readLedger(empty).size).toBe(0);
      } finally {
         rmSync(empty, { recursive: true, force: true });
      }
   });
});

describe("concatenatePcmFiles", () => {
   const dir = mkdtempSync(join(tmpdir(), "minutas-concat-"));
   afterAll(() => rmSync(dir, { recursive: true, force: true }));

   it("byte-concatenates with sample-aligned silence gaps and exact offsets", async () => {
      const a = join(dir, "a.pcm");
      const b = join(dir, "b.pcm");
      writeFileSync(a, Buffer.alloc(PCM_BYTES_PER_SECOND, 1)); // 1 s of non-zero
      writeFileSync(b, Buffer.alloc(PCM_BYTES_PER_SECOND * 2, 2)); // 2 s
      const out = join(dir, "out.pcm");
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
   async transcribe(
      wavPath: string,
      outBase: string,
   ): Promise<TranscriptSegment[]> {
      if (this.failNext) {
         this.failNext = false;
         throw new Error("whisper exploded");
      }
      this.calls.push(basename(wavPath));
      await writeFile(`${outBase}.json`, JSON.stringify({ transcription: [] }));
      return this.segments;
   }
}

describe.skipIf(!hasFfmpeg)("transcribeBatch", () => {
   const dir = mkdtempSync(join(tmpdir(), "minutas-batch-"));
   afterAll(() => rmSync(dir, { recursive: true, force: true }));

   it("concat → wav → whisper → mapped ledger entries; concat pcm cleaned up", async () => {
      mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
      mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
      writeFileSync(
         join(dir, "audio/001-Ana.pcm"),
         Buffer.alloc(PCM_BYTES_PER_SECOND * 2),
      );
      writeFileSync(
         join(dir, "audio/003-Ana.pcm"),
         Buffer.alloc(PCM_BYTES_PER_SECOND),
      );
      const t = new RecordingTranscriber();
      // One segment per burst, expressed in concat-file time (gap = 1 s).
      t.segments = [
         { startMs: 200, endMs: 1800, text: "abro la sesión" },
         { startMs: 3100, endMs: 3900, text: "y cierro el punto" },
      ];
      const bursts = [
         burst({
            seq: 1,
            file: "audio/001-Ana.pcm",
            startedAtMs: 0,
            bytes: PCM_BYTES_PER_SECOND * 2,
         }),
         burst({
            seq: 3,
            file: "audio/003-Ana.pcm",
            startedAtMs: 30_000,
            bytes: PCM_BYTES_PER_SECOND,
         }),
      ];

      const entries = await transcribeBatch(t, dir, {
         name: "batch-001-Ana",
         speaker: "Ana",
         bursts,
      });

      expect(t.calls).toEqual(["batch-001-Ana.wav"]); // ONE whisper call for two bursts
      expect(entries[0]!.segments).toEqual([
         { startMs: 200, endMs: 1800, text: "abro la sesión" },
      ]);
      expect(entries[1]!.segments).toEqual([
         { startMs: 100, endMs: 900, text: "y cierro el punto" },
      ]);
      expect(readLedger(dir).size).toBe(2);
      expect(existsSync(join(dir, "audio/batch-001-Ana.pcm"))).toBe(false); // temp removed
      expect(existsSync(join(dir, "audio/batch-001-Ana.wav"))).toBe(true); // archive kept
   });
});

describe.skipIf(!hasFfmpeg)("LiveTranscriber", () => {
   it("holds below the threshold, flushes at it, and ledgers the batch", async () => {
      const dir = mkdtempSync(join(tmpdir(), "minutas-livewk-"));
      try {
         mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
         mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
         const t = new RecordingTranscriber();
         const live = new LiveTranscriber(t);
         // LIVE_FLUSH_MAX_BURSTS short bursts trip the count threshold.
         for (let seq = 1; seq <= LIVE_FLUSH_MAX_BURSTS; seq++) {
            const file = `audio/${String(seq).padStart(3, "0")}-Ana.pcm`;
            writeFileSync(join(dir, file), Buffer.alloc(PCM_BYTES_PER_SECOND));
            live.enqueue(
               dir,
               burst({ seq, file, bytes: PCM_BYTES_PER_SECOND }),
            );
            if (seq < LIVE_FLUSH_MAX_BURSTS) expect(t.calls).toHaveLength(0);
         }
         await live.drain(dir); // deterministic: waits for the fire-and-forget flush
         expect(t.calls).toEqual(["batch-001-Ana.wav"]);
         expect(readLedger(dir).size).toBe(LIVE_FLUSH_MAX_BURSTS);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("a failed flush leaves bursts unledgered for finalize — nothing lost", async () => {
      const dir = mkdtempSync(join(tmpdir(), "minutas-livewk-fail-"));
      try {
         mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
         mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
         const t = new RecordingTranscriber();
         t.failNext = true;
         const live = new LiveTranscriber(t);
         for (let seq = 1; seq <= LIVE_FLUSH_MAX_BURSTS; seq++) {
            const file = `audio/${String(seq).padStart(3, "0")}-Ana.pcm`;
            writeFileSync(join(dir, file), Buffer.alloc(PCM_BYTES_PER_SECOND));
            live.enqueue(
               dir,
               burst({ seq, file, bytes: PCM_BYTES_PER_SECOND }),
            );
         }
         await live.drain(dir); // a failed batch still resolves drain
         expect(readLedger(dir).size).toBe(0); // finalize will pick them all up
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });
});

describe("buildWhisperPrompt", () => {
   it("carries vocabulary, title and cleaned participant names", async () => {
      const { buildWhisperPrompt } = await import("../live.js");
      const p = buildWhisperPrompt("asamblea general", [
         "tlacuache ✩‧₊˚",
         "Ajolotx",
         "Ajolotx",
         "🌙",
         "123456",
      ]);
      expect(p).toContain("Revolución Z (RevZ)");
      expect(p).toContain("Sesión: asamblea general.");
      expect(p).toContain("Participan: tlacuache, Ajolotx.");
   });

   it("stays under the cap with a huge roster", async () => {
      const { buildWhisperPrompt } = await import("../live.js");
      const names = Array.from({ length: 200 }, (_, i) => `Participante${i}`);
      expect(buildWhisperPrompt("x", names).length).toBeLessThanOrEqual(600);
   });
});

describe.skipIf(!hasFfmpeg)("LiveTranscriber.drain", () => {
   it("resolves only after the running batch is in the ledger", async () => {
      // 2026-09-23 audit: finalize used to read the ledger while a live batch
      // was still running, and re-transcribed those bursts (~43% of the wait).
      const { LiveTranscriber } = await import("../live.js");
      const dir = mkdtempSync(join(tmpdir(), "minutas-drain-"));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow: Transcriber = {
         isAvailable: () => true,
         transcribe: async (_wav, outBase) => {
            await gate;
            writeFileSync(
               `${outBase}.json`,
               JSON.stringify({ transcription: [] }),
            );
            return [{ startMs: 0, endMs: 500, text: "hola" }];
         },
      };
      try {
         mkdirSync(join(dir, ARTIFACTS.audioDir), { recursive: true });
         mkdirSync(join(dir, ARTIFACTS.whisperDir), { recursive: true });
         const live = new LiveTranscriber(slow);
         for (let seq = 1; seq <= LIVE_FLUSH_MAX_BURSTS; seq++) {
            const file = `audio/${String(seq).padStart(3, "0")}-Ana.pcm`;
            writeFileSync(join(dir, file), Buffer.alloc(PCM_BYTES_PER_SECOND));
            live.enqueue(
               dir,
               burst({ seq, file, bytes: PCM_BYTES_PER_SECOND }),
            );
         }
         let drained = false;
         const d = live.drain(dir).then(() => (drained = true));
         await new Promise((r) => setTimeout(r, 300));
         expect(drained).toBe(false); // the batch is still running
         expect(readLedger(dir).size).toBe(0);
         release();
         await d;
         expect(readLedger(dir).size).toBe(LIVE_FLUSH_MAX_BURSTS);
      } finally {
         rmSync(dir, { recursive: true, force: true });
      }
   });

   it("with nothing running, resolves immediately", async () => {
      const { LiveTranscriber } = await import("../live.js");
      const live = new LiveTranscriber({
         isAvailable: () => true,
         transcribe: async () => [],
      });
      await expect(live.drain("/nonexistent")).resolves.toBeUndefined();
   });
});
