import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { config } from "../../../config.js";
import { NamespacedMemory, SqliteMemoryStore } from "../../../memory/store.js";
import { ConfigMinutasAdminSource } from "../../configuration/minutas-admin-source.js";
import { MinutasCapability } from "../capability.js";
import { RemoteTranscriber } from "../remote-transcriber.js";
import { WhisperCliTranscriber } from "../transcriber.js";

vi.mock("../../../storage/index.js", () => ({
   createObjectStorage: () => null,
}));

it("production capability wires automatic fallback, caps Pi threads, and exposes state to the console", async () => {
   const saved = { ...config };
   const root = await mkdtemp(join(tmpdir(), "minutas-wiring-"));
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   const cap = new MinutasCapability();
   try {
      config.MINUTAS_REMOTE_URL =
         "http://127.0.0.1:18510/workloads/v1/transcription/run";
      config.MINUTAS_REMOTE_TOKEN_FILE = "unused-token";
      config.MINUTAS_WHISPER_THREADS = 8;
      config.MINUTAS_WHISPER_IDLE_THREADS = 8;
      const remote = vi
         .spyOn(RemoteTranscriber.prototype, "transcribe")
         .mockRejectedValue(new Error("DiveMac unavailable"));
      vi.spyOn(WhisperCliTranscriber.prototype, "isAvailable").mockReturnValue(
         true,
      );
      const local = vi
         .spyOn(WhisperCliTranscriber.prototype, "transcribe")
         .mockImplementation(async function (this: WhisperCliTranscriber) {
            expect(this.threadsNow()).toBe(2);
            return [{ startMs: 0, endMs: 10, text: "Pi" }];
         });
      await cap.init({
         memory: new NamespacedMemory(mem, "minutas"),
         projectRoot: root,
      });
      // Observe the actual transcriber created by init, without starting Discord.
      const engine = (cap as unknown as { transcriber: WhisperCliTranscriber })
         .transcriber;
      await expect(engine.transcribe("a.wav", "a")).resolves.toHaveLength(1);
      await expect(engine.transcribe("b.wav", "b")).resolves.toHaveLength(1);
      expect(remote).toHaveBeenCalledTimes(1);
      expect(local).toHaveBeenCalledTimes(2);
      const source = new ConfigMinutasAdminSource({
         db: mem.db(),
         callerUserId: "mod",
         guildId: null,
         minutas: {
            endActiveSession: async () => "",
            activeSession: () => null,
            transcriberAvailable: () =>
               cap.adminStatus(null).transcriberAvailable,
            transcriptionStatus: () => cap.adminStatus(null).transcription,
         },
      });
      const status = await source.handle("config_minutas", {
         action: "status",
      });
      expect(status.payload).toMatchObject({
         transcriber_available: true,
         transcription: {
            backend: "local_fallback",
            localAvailable: true,
            remoteRetryAt: expect.any(Number),
         },
      });
   } finally {
      await cap.dispose();
      mem.close();
      Object.assign(config, saved);
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
   }
});
