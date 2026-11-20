import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
   existsSync,
   mkdirSync,
   mkdtempSync,
   rmSync,
   writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { WorkshopStore, WORKSHOP_MIGRATIONS } from "../store.js";
import { workspaceDirFor } from "../workspace.js";
import { WorkshopWatcher } from "../watcher.js";
import type { TurnQueue } from "../../../discord/turn-queue.js";

/**
 * The hourly GC is the only code allowed to DELETE a member's files, and it has
 * two jobs that used to fight each other: archived deliverables go (they live on
 * Discord/MinIO), while a session's work copies must never be delivered — and
 * must not accumulate forever either. These tests pin both.
 */

const CHANNEL = "1550000000000000002";
let dataDir: string;
let store: WorkshopStore;
let mem: SqliteMemoryStore;
let sessionDir: string;
const NOW = 1_800_000_000_000;

function makeWatcher(now: number): WorkshopWatcher {
   return new WorkshopWatcher({
      client: {} as Client,
      store,
      turnQueue: {} as TurnQueue,
      dataDir,
      reactionEmoji: () => "🎓",
      maxSessionsPerUser: 2,
      pyTimeoutMs: 60_000,
      storage: null,
      now: () => now,
   });
}

beforeEach(async () => {
   dataDir = mkdtempSync(join(tmpdir(), "workshop-gc-"));
   mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "workshop").migrate(
      "workshop",
      WORKSHOP_MIGRATIONS,
   );
   store = new WorkshopStore(mem.db());
   sessionDir = workspaceDirFor(dataDir, CHANNEL);
   mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
   mem.close();
   rmSync(dataDir, { recursive: true, force: true });
});

describe("gcSweep", () => {
   test("drops archived deliverables and wipes the work dirs of an idle session", async () => {
      store.createSession({
         channelId: CHANNEL,
         guildId: "g1",
         userId: "u1",
         userTag: "miembro",
         nowMs: NOW - 12 * 60 * 60 * 1000,
      });
      writeFileSync(join(sessionDir, "entrega.xlsx"), "x");
      store.recordFile({
         channelId: CHANNEL,
         relPath: "entrega.xlsx",
         messageId: "m1",
         bytes: 1,
         nowMs: NOW,
      });
      mkdirSync(join(sessionDir, "recalc"), { recursive: true });
      writeFileSync(join(sessionDir, "recalc", "entrega.xlsx"), "copia");
      mkdirSync(join(sessionDir, ".scratch", "vista_previa"), {
         recursive: true,
      });
      writeFileSync(join(sessionDir, ".scratch", "vista_previa", "x.pdf"), "p");

      const result = await makeWatcher(NOW).gcSweep();

      // The archived deliverable is recoverable from Discord/MinIO → dropped.
      expect(existsSync(join(sessionDir, "entrega.xlsx"))).toBe(false);
      expect(result.filesDeleted).toBe(1);
      // Work copies are invisible to the file listing but must still go.
      expect(existsSync(join(sessionDir, "recalc"))).toBe(false);
      expect(existsSync(join(sessionDir, ".scratch"))).toBe(false);
      expect(result.dirsRemoved).toBe(2);
      // The ledger row survives: the file still lives on its carrier.
      expect(store.fileManifest(CHANNEL).map((f) => f.rel_path)).toEqual([
         "entrega.xlsx",
      ]);
   });

   test("leaves a session that was active recently completely alone", async () => {
      store.createSession({
         channelId: CHANNEL,
         guildId: "g1",
         userId: "u1",
         userTag: "miembro",
         nowMs: NOW,
      });
      writeFileSync(join(sessionDir, "borrador.xlsx"), "x");
      mkdirSync(join(sessionDir, "recalc"), { recursive: true });
      writeFileSync(join(sessionDir, "recalc", "borrador.xlsx"), "copia");

      const result = await makeWatcher(NOW).gcSweep();

      expect(result.filesDeleted).toBe(0);
      expect(result.dirsRemoved).toBe(0);
      expect(existsSync(join(sessionDir, "borrador.xlsx"))).toBe(true);
      expect(existsSync(join(sessionDir, "recalc", "borrador.xlsx"))).toBe(
         true,
      );
   });
});
