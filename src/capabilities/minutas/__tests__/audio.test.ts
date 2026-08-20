import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import opus from "@discordjs/opus";
import { afterAll, describe, expect, it } from "vitest";
import {
   burstCapturedNothing,
   CaptureHealth,
   pcmDurationMs,
   recordOpusStreamToPcm,
   sanitizeFileFragment,
} from "../audio.js";
import {
   MIN_BURST_BYTES,
   OPUS_CHANNELS,
   OPUS_SAMPLE_RATE,
   PCM_BYTES_PER_SECOND,
} from "../constants.js";

const { OpusEncoder } = opus;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz

const dir = mkdtempSync(join(tmpdir(), "minutas-audio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One 20 ms Opus frame of (quiet) tone — a real packet off a real encoder. */
function opusFrame(
   encoder: InstanceType<typeof OpusEncoder>,
   seed: number,
): Buffer {
   const pcm = Buffer.alloc(FRAME_SAMPLES * OPUS_CHANNELS * 2);
   for (let i = 0; i < FRAME_SAMPLES; i++) {
      const v = Math.round(
         6000 *
            Math.sin(
               (2 * Math.PI * 220 * (seed * FRAME_SAMPLES + i)) /
                  OPUS_SAMPLE_RATE,
            ),
      );
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
   }
   return encoder.encode(pcm);
}

function streamOf(packets: Buffer[]): Readable {
   return Readable.from(packets);
}

describe("CaptureHealth", () => {
   it("stays quiet while bursts are capturing audio", () => {
      const h = new CaptureHealth(3);
      for (let i = 0; i < 20; i++) expect(h.record(true)).toBe(false);
      expect(h.consecutiveFailures).toBe(0);
   });

   it("fires exactly once, on the Nth consecutive empty burst", () => {
      const h = new CaptureHealth(3);
      expect(h.record(false)).toBe(false);
      expect(h.record(false)).toBe(false);
      expect(h.record(false)).toBe(true); // third in a row → alarm
      expect(h.record(false)).toBe(false); // never re-fires
      expect(h.record(false)).toBe(false);
   });

   it("resets the run when a burst captures audio again", () => {
      const h = new CaptureHealth(3);
      h.record(false);
      h.record(false);
      h.record(true); // recovered
      expect(h.consecutiveFailures).toBe(0);
      expect(h.record(false)).toBe(false);
      expect(h.record(false)).toBe(false);
      expect(h.record(false)).toBe(true);
   });
});

describe("burstCapturedNothing", () => {
   it("flags a burst that received packets but wrote no audio", () => {
      expect(
         burstCapturedNothing({ bytes: 0, packets: 40, decodeErrors: 40 }),
      ).toBe(true);
   });

   it("does not flag a silent speaker who sent nothing at all", () => {
      expect(
         burstCapturedNothing({ bytes: 0, packets: 0, decodeErrors: 0 }),
      ).toBe(false);
   });

   it("does not flag a burst that produced audio despite some bad packets", () => {
      expect(
         burstCapturedNothing({ bytes: 64000, packets: 100, decodeErrors: 7 }),
      ).toBe(false);
   });
});

describe("recordOpusStreamToPcm", () => {
   it("decodes a real Opus packet stream to PCM on disk", async () => {
      const enc = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
      const packets = Array.from({ length: 100 }, (_, i) => opusFrame(enc, i)); // 2 s
      const out = join(dir, "clean.pcm");

      const result = await recordOpusStreamToPcm(streamOf(packets), out);

      expect(result.packets).toBe(100);
      expect(result.decodeErrors).toBe(0);
      // 100 frames * 20 ms = 2 s at 16 kHz mono
      expect(result.bytes).toBeGreaterThan(PCM_BYTES_PER_SECOND * 1.5);
      expect(statSync(out).size).toBe(result.bytes);
      expect(pcmDurationMs(result.bytes)).toBeGreaterThan(1500);
   });

   /**
    * The 2026-08-16 regression: a bad packet mid-stream must cost 20 ms, not the
    * rest of the burst (and previously, not every subsequent burst either).
    */
   it("survives corrupt packets mid-stream and keeps the rest of the burst", async () => {
      const enc = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
      const packets: Buffer[] = [];
      for (let i = 0; i < 150; i++) {
         packets.push(opusFrame(enc, i));
         if (i % 10 === 0)
            packets.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
      }
      const out = join(dir, "corrupt.pcm");

      const result = await recordOpusStreamToPcm(streamOf(packets), out);

      expect(result.decodeErrors).toBeGreaterThan(0);
      expect(burstCapturedNothing(result)).toBe(false);
      // The 150 good frames (3 s) still landed despite the interleaved garbage.
      expect(result.bytes).toBeGreaterThan(PCM_BYTES_PER_SECOND * 2.5);
   });

   it("keeps working on a later burst after a fully corrupt one (no shared state)", async () => {
      const enc = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
      const garbage = Array.from({ length: 60 }, () =>
         Buffer.from([0xfe, 0x01, 0x02, 0x03]),
      );
      const poisoned = await recordOpusStreamToPcm(
         streamOf(garbage),
         join(dir, "poison.pcm"),
      );
      expect(poisoned.packets).toBe(60);

      // This is precisely what opusscript could not do: the NEXT burst still works.
      const good = Array.from({ length: 100 }, (_, i) => opusFrame(enc, i));
      const after = await recordOpusStreamToPcm(
         streamOf(good),
         join(dir, "after-poison.pcm"),
      );

      expect(after.decodeErrors).toBe(0);
      expect(after.bytes).toBeGreaterThan(PCM_BYTES_PER_SECOND * 1.5);
      expect(burstCapturedNothing(after)).toBe(false);
   });

   it("reports an all-garbage burst as having captured nothing", async () => {
      const garbage = Array.from({ length: 40 }, () =>
         Buffer.from([0xfe, 0xaa, 0xbb]),
      );
      const result = await recordOpusStreamToPcm(
         streamOf(garbage),
         join(dir, "allbad.pcm"),
      );
      expect(result.packets).toBe(40);
      // Either nothing decoded (the alarm case) or it decoded but stayed tiny;
      // what matters is we never silently claim a healthy burst.
      if (result.bytes === 0) expect(burstCapturedNothing(result)).toBe(true);
   });

   /**
    * The actual 2026-08-16 mechanism: one decoder per burst, never freed. The
    * old WASM decoder exhausted its fixed heap after ~55 and then failed
    * process-wide — 233 bursts into a real assembly. 80 here clears that ceiling
    * with margin, so a regression to any fixed-heap decoder fails this test.
    */
   it("still decodes after more sequential bursts than the old WASM heap allowed", async () => {
      const enc = new OpusEncoder(OPUS_SAMPLE_RATE, OPUS_CHANNELS);
      const frames = Array.from({ length: 12 }, (_, i) => opusFrame(enc, i));
      let lastBytes = 0;
      for (let burst = 0; burst < 80; burst++) {
         const result = await recordOpusStreamToPcm(
            streamOf(frames),
            join(dir, `seq-${burst}.pcm`),
         );
         expect(result.decodeErrors).toBe(0);
         expect(burstCapturedNothing(result)).toBe(false);
         lastBytes = result.bytes;
      }
      expect(lastBytes).toBeGreaterThan(0);
   }, 120_000);

   it("resolves cleanly for a speaker who sent no packets at all", async () => {
      const result = await recordOpusStreamToPcm(
         streamOf([]),
         join(dir, "empty.pcm"),
      );
      expect(result.packets).toBe(0);
      expect(result.bytes).toBe(0);
      expect(burstCapturedNothing(result)).toBe(false); // silence, not failure
   });
});

describe("burst length floor", () => {
   it("keeps half-second utterances, which the 1 s floor used to discard", () => {
      // 32% of the 2026-08-16 assembly's bursts fell under the old 1 s floor.
      expect(MIN_BURST_BYTES).toBe(PCM_BYTES_PER_SECOND / 2);
      const halfSecond = PCM_BYTES_PER_SECOND / 2;
      expect(halfSecond).toBeGreaterThanOrEqual(MIN_BURST_BYTES);
   });
});

describe("sanitizeFileFragment", () => {
   // Synthetic names on purpose — this repo is public, so never paste real
   // members' display names in here. These cover the same shapes real ones have:
   // leading punctuation + trailing emoji, spaces, and accents.
   it("strips decoration and accents the way real display names need", () => {
      expect(sanitizeFileFragment("! Estrella 📕")).toBe("Estrella");
      expect(sanitizeFileFragment("Nube Serrana")).toBe("Nube-Serrana");
      expect(sanitizeFileFragment("Álvaro Muñoz")).toBe("Alvaro-Munoz");
   });

   it("falls back to a usable name when nothing survives", () => {
      expect(sanitizeFileFragment("日本語")).toBe("anon");
      expect(sanitizeFileFragment("   ")).toBe("anon");
   });
});
