import { describe, expect, it, vi } from "vitest";
import { FailoverTranscriber } from "../failover-transcriber.js";
import type { Transcriber } from "../transcriber.js";

const remoteSegments = [{ startMs: 0, endMs: 1000, text: "remoto" }];
const localSegments = [{ startMs: 0, endMs: 1000, text: "local" }];

function engines() {
   return {
      remote: {
         isAvailable: () => true,
         transcribe: vi.fn<Transcriber["transcribe"]>(
            async () => remoteSegments,
         ),
      },
      local: {
         isAvailable: vi.fn(() => true),
         transcribe: vi.fn<Transcriber["transcribe"]>(
            async () => localSegments,
         ),
      },
   };
}

describe("automatic transcription fallback", () => {
   it("prefers remote compute and forwards spelling and loop-retry options", async () => {
      const { remote, local } = engines();
      const t = new FailoverTranscriber(remote, local);
      const options = { prompt: "RevZ", noContext: true };
      expect(await t.transcribe("pi.wav", "pi-out", options)).toEqual(
         remoteSegments,
      );
      expect(remote.transcribe).toHaveBeenCalledWith(
         "pi.wav",
         "pi-out",
         options,
      );
      expect(local.transcribe).not.toHaveBeenCalled();
      expect(t.status().backend).toBe("remote");
   });

   it("falls back on the same audio, skips remote during cooldown, and recovers automatically", async () => {
      const { remote, local } = engines();
      remote.transcribe.mockRejectedValueOnce(new Error("unreachable"));
      const onTransition = vi.fn(async () => {});
      let now = 0;
      const t = new FailoverTranscriber(remote, local, {
         now: () => now,
         cooldownMs: 100,
         onTransition,
      });
      const options = { prompt: "RevZ", noContext: true };
      expect(await t.transcribe("pi.wav", "pi-out", options)).toEqual(
         localSegments,
      );
      expect(local.transcribe).toHaveBeenCalledWith(
         "pi.wav",
         "pi-out",
         options,
      );
      now = 99;
      await t.transcribe("next.wav", "next");
      expect(remote.transcribe).toHaveBeenCalledTimes(1);
      expect(t.status()).toEqual({
         backend: "local_fallback",
         remoteRetryAt: 100,
         localAvailable: true,
      });
      now = 100;
      expect(await t.transcribe("third.wav", "third")).toEqual(remoteSegments);
      expect(t.status()).toEqual({
         backend: "remote",
         remoteRetryAt: null,
         localAvailable: true,
      });
      expect(onTransition.mock.calls).toEqual([["local_fallback"], ["remote"]]);
   });

   it("extends the cooldown without duplicate outage alerts when a recovery probe fails", async () => {
      const { remote, local } = engines();
      remote.transcribe.mockRejectedValue(new Error("offline"));
      const onTransition = vi.fn(async () => {});
      let now = 0;
      const t = new FailoverTranscriber(remote, local, {
         now: () => now,
         cooldownMs: 100,
         onTransition,
      });
      await t.transcribe("a", "a");
      now = 100;
      await t.transcribe("b", "b");
      await t.transcribe("c", "c");
      expect(remote.transcribe).toHaveBeenCalledTimes(2);
      expect(local.transcribe).toHaveBeenCalledTimes(3);
      expect(onTransition).toHaveBeenCalledTimes(1);
      expect(t.status().remoteRetryAt).toBe(200);
   });

   it("serializes both engines, including calls queued before remote failure", async () => {
      const { remote, local } = engines();
      let rejectRemote!: (error: Error) => void;
      remote.transcribe.mockImplementationOnce(
         () =>
            new Promise((_, reject) => {
               rejectRemote = reject;
            }),
      );
      let finishLocal!: (value: typeof localSegments) => void;
      local.transcribe.mockImplementationOnce(
         () =>
            new Promise((resolve) => {
               finishLocal = resolve;
            }),
      );
      const t = new FailoverTranscriber(remote, local);
      const a = t.transcribe("a", "out-a");
      const b = t.transcribe("b", "out-b");
      await vi.waitFor(() =>
         expect(remote.transcribe).toHaveBeenCalledTimes(1),
      );
      rejectRemote(new Error("lost response"));
      await vi.waitFor(() => expect(local.transcribe).toHaveBeenCalledTimes(1));
      expect(remote.transcribe).toHaveBeenCalledTimes(1);
      finishLocal(localSegments);
      await Promise.all([a, b]);
      expect(local.transcribe.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
   });

   it("does not acknowledge missing local compute or a failed local run, and later work still succeeds", async () => {
      const { remote, local } = engines();
      remote.transcribe.mockRejectedValue(new Error("offline"));
      local.isAvailable.mockReturnValue(false);
      const t = new FailoverTranscriber(remote, local);
      await expect(t.transcribe("a", "a")).rejects.toThrow(
         "local whisper is unavailable",
      );
      expect(local.transcribe).not.toHaveBeenCalled();
      local.isAvailable.mockReturnValue(true);
      local.transcribe.mockRejectedValueOnce(new Error("whisper failed"));
      await expect(t.transcribe("b", "b")).rejects.toThrow("whisper failed");
      expect(await t.transcribe("c", "c")).toEqual(localSegments);
   });

   it("alerts cannot block or break transcription", async () => {
      const { remote, local } = engines();
      remote.transcribe.mockRejectedValue(new Error("offline"));
      const t = new FailoverTranscriber(remote, local, {
         onTransition: () => new Promise(() => {}),
      });
      expect(await t.transcribe("a", "a")).toEqual(localSegments);
      const rejected = new FailoverTranscriber(remote, local, {
         onTransition: async () => {
            throw new Error("Discord unavailable");
         },
      });
      expect(await rejected.transcribe("b", "b")).toEqual(localSegments);
   });
});
