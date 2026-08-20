import { describe, test, expect } from "vitest";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import {
   MINUTAS_MIGRATIONS,
   MinutasStore,
   type MinutasSessionRow,
} from "../store.js";

async function newStore() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "minutas").migrate(
      "minutas",
      MINUTAS_MIGRATIONS,
   );
   return { store: new MinutasStore(mem.db()), mem };
}

function row(over: Partial<MinutasSessionRow> = {}): MinutasSessionRow {
   return {
      id: "s1",
      guild_id: "g1",
      channel_id: "c1",
      channel_name: "Ágora",
      title: null,
      started_by: "u1",
      started_by_tag: "ana#0001",
      started_at: 1_000_000,
      ended_at: null,
      status: "active",
      transcribe_after: null,
      end_reason: null,
      minio_prefix: null,
      summary_message_id: null,
      participants_json: "[]",
      stats_json: null,
      error: null,
      ...over,
   };
}

describe("MinutasStore settings", () => {
   test("seed writes only when unset; operator value survives re-seed", async () => {
      const { store, mem } = await newStore();
      expect(store.getOutputChannelId()).toBeNull();
      store.seedOutputChannelId("111");
      expect(store.getOutputChannelId()).toBe("111");
      store.setOutputChannelId("222");
      store.seedOutputChannelId("111"); // a restart re-seed must NOT clobber
      expect(store.getOutputChannelId()).toBe("222");
      mem.close();
   });
});

describe("MinutasStore sessions", () => {
   test("create + active lookup + lifecycle updates", async () => {
      const { store, mem } = await newStore();
      store.createSession(row());
      expect(store.getActiveSessionForGuild("g1")?.id).toBe("s1");
      expect(store.getActiveSessionForGuild("g2")).toBeNull();

      store.updateSession("s1", {
         status: "processing",
         ended_at: 1_060_000,
         end_reason: "comando",
      });
      expect(store.getActiveSessionForGuild("g1")).toBeNull();
      expect(store.listUnfinishedSessions().map((s) => s.id)).toEqual(["s1"]);

      store.updateSession("s1", {
         status: "done",
         summary_message_id: "m1",
         minio_prefix: "minutas/g1/2026-08-16/s1/",
      });
      const done = store.getSession("s1")!;
      expect(done.status).toBe("done");
      expect(done.summary_message_id).toBe("m1");
      expect(done.end_reason).toBe("comando");
      expect(store.listUnfinishedSessions()).toEqual([]);
      mem.close();
   });

   test("failed sessions carry the error and leave the unfinished sweep", async () => {
      const { store, mem } = await newStore();
      store.createSession(row());
      store.updateSession("s1", { status: "processing" });
      store.updateSession("s1", { status: "failed", error: "boom" });
      expect(store.listUnfinishedSessions()).toEqual([]);
      expect(store.getSession("s1")!.error).toBe("boom");
      mem.close();
   });

   test("listRecentSessions orders newest first and honors the limit", async () => {
      const { store, mem } = await newStore();
      for (let i = 1; i <= 7; i++) {
         store.createSession(
            row({ id: `s${i}`, started_at: i * 1000, status: "done" }),
         );
      }
      const recent = store.listRecentSessions(3);
      expect(recent.map((s) => s.id)).toEqual(["s7", "s6", "s5"]);
      mem.close();
   });
});
