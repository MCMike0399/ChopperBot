/**
 * Whisper thread width (2026-10-13 live review): 2 threads while a session is
 * recording, full width once nothing is — decided when each process spawns,
 * so batches queued at `/chopperbot-leave` already get the wider setting.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
   chmodSync,
   mkdtempSync,
   readFileSync,
   rmSync,
   writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhisperCliTranscriber } from "../transcriber.js";

const dirs: string[] = [];
afterEach(() => {
   for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A whisper-cli stand-in: logs its `-t` value, writes a one-segment transcript. */
function fakeWhisper(): {
   bin: string;
   model: string;
   dir: string;
   threadsSeen: () => string[];
} {
   const dir = mkdtempSync(join(tmpdir(), "minutas-whisper-"));
   dirs.push(dir);
   const bin = join(dir, "whisper-cli");
   const log = join(dir, "threads.log");
   writeFileSync(
      bin,
      `#!/bin/sh
out=""; t=""
while [ $# -gt 0 ]; do
  case "$1" in -of) out="$2"; shift;; -t) t="$2"; shift;; -mc) t="$t mc$2"; shift;; esac
  shift
done
sleep 0.2
echo "$t" >> "${log}"
echo '{"transcription":[{"offsets":{"from":0,"to":1000},"text":" hola"}]}' > "$out.json"
`,
   );
   chmodSync(bin, 0o755);
   const model = join(dir, "model.bin");
   writeFileSync(model, "");
   return {
      bin,
      model,
      dir,
      threadsSeen: () => readFileSync(log, "utf8").trim().split("\n"),
   };
}

describe("WhisperCliTranscriber thread width", () => {
   test("recording → threads; idle → idleThreads; no hook → threads", () => {
      let recording = true;
      const t = new WhisperCliTranscriber({
         bin: "x",
         modelPath: "y",
         language: "es",
         threads: 2,
         idleThreads: 4,
         isRecording: () => recording,
      });
      expect(t.threadsNow()).toBe(2);
      recording = false;
      expect(t.threadsNow()).toBe(4);
      const plain = new WhisperCliTranscriber({
         bin: "x",
         modelPath: "y",
         language: "es",
         threads: 2,
      });
      expect(plain.threadsNow()).toBe(2);
   });

   test("a call queued during recording spawns at idle width after leave", async () => {
      const w = fakeWhisper();
      let recording = true;
      const t = new WhisperCliTranscriber({
         bin: w.bin,
         modelPath: w.model,
         language: "es",
         threads: 2,
         idleThreads: 4,
         isRecording: () => recording,
      });
      const first = t.transcribe(join(w.dir, "a.wav"), join(w.dir, "a"));
      const second = t.transcribe(join(w.dir, "b.wav"), join(w.dir, "b"));
      // Leave happens while the first process runs and the second is queued.
      await new Promise((r) => setTimeout(r, 50));
      recording = false;
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual([{ startMs: 0, endMs: 1000, text: "hola" }]);
      expect(b).toHaveLength(1);
      expect(w.threadsSeen()).toEqual(["2", "4"]);
   });

   test("noContext passes -mc 0 (the repetition-loop retry)", async () => {
      const w = fakeWhisper();
      const t = new WhisperCliTranscriber({
         bin: w.bin,
         modelPath: w.model,
         language: "es",
         threads: 2,
      });
      await t.transcribe(join(w.dir, "a.wav"), join(w.dir, "a"), {
         prompt: "RevZ",
      });
      await t.transcribe(join(w.dir, "b.wav"), join(w.dir, "b"), {
         prompt: "RevZ",
         noContext: true,
      });
      expect(w.threadsSeen()).toEqual(["2", "2 mc0"]);
   });
});
