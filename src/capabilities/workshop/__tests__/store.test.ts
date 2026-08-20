import { describe, test, expect } from "vitest";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { WorkshopStore, WORKSHOP_MIGRATIONS } from "../store.js";

async function newStore() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "workshop").migrate(
      "workshop",
      WORKSHOP_MIGRATIONS,
   );
   return { store: new WorkshopStore(mem.db()), mem };
}

describe("WorkshopStore settings", () => {
   test("seed fills empty fields only; operator edits survive re-seed", async () => {
      const { store, mem } = await newStore();
      store.seedSettings({ welcomeChannelId: "111", categoryId: "222" });
      expect(store.getSettings().welcome_channel_id).toBe("111");
      expect(store.getSettings().category_id).toBe("222");

      store.setChannels("333", "444");
      store.seedSettings({ welcomeChannelId: "111", categoryId: "222" });
      expect(store.getSettings().welcome_channel_id).toBe("333");
      expect(store.getSettings().category_id).toBe("444");
      mem.close();
   });

   test("setChannels resets the welcome message id (it must be reposted)", async () => {
      const { store, mem } = await newStore();
      store.setWelcomeMessageId("m1");
      expect(store.getSettings().welcome_message_id).toBe("m1");
      store.setChannels("555", "666");
      expect(store.getSettings().welcome_message_id).toBeNull();
      mem.close();
   });

   test("default emoji is 🎓 and can be changed", async () => {
      const { store, mem } = await newStore();
      expect(store.getSettings().reaction_emoji).toBe("🎓");
      store.setReactionEmoji("🧠");
      expect(store.getSettings().reaction_emoji).toBe("🧠");
      mem.close();
   });
});

describe("WorkshopStore sessions", () => {
   const base = { guildId: "g1", userId: "u1", userTag: "user#1", nowMs: 1000 };

   test("create → active; close → closed; counts and lookups agree", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.createSession({ ...base, channelId: "c2", nowMs: 2000 });

      expect(store.activeSessionsFor("u1")).toHaveLength(2);
      expect(store.activeChannelIds().sort()).toEqual(["c1", "c2"]);
      expect(store.countSessions()).toEqual({ active: 2, closed: 0 });

      store.closeSession("c1", 3000);
      expect(store.getSession("c1")?.status).toBe("closed");
      expect(store.getSession("c1")?.closed_at).toBe(3000);
      expect(store.activeSessionsFor("u1")).toHaveLength(1);
      expect(store.activeChannelIds()).toEqual(["c2"]);
      expect(store.countSessions()).toEqual({ active: 1, closed: 1 });
      mem.close();
   });

   test("context clear and activity are per-session", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.clearContext("c1", 5000);
      store.touchActivity("c1", 6000);
      const s = store.getSession("c1")!;
      expect(s.context_cleared_at).toBe(5000);
      expect(s.last_activity_at).toBe(6000);
      mem.close();
   });

   test("panel message id round-trips", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.setPanelMessageId("c1", "panel-1");
      expect(store.getSession("c1")?.panel_message_id).toBe("panel-1");
      mem.close();
   });

   test("summary round-trips and a context clear wipes it (borrón total)", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.setSummary("c1", "Trabajando el capítulo 2 de Federici.", 5000);
      let s = store.getSession("c1")!;
      expect(s.summary).toContain("Federici");
      expect(s.summary_covers_until).toBe(5000);

      store.clearContext("c1", 6000);
      s = store.getSession("c1")!;
      expect(s.summary).toBeNull();
      expect(s.summary_covers_until).toBeNull();
      expect(s.context_cleared_at).toBe(6000);
      mem.close();
   });
});

describe("WorkshopStore file manifest (Discord as durable store)", () => {
   const base = { guildId: "g1", userId: "u1", userTag: "user#1", nowMs: 1000 };

   test("record → list → upsert → remove → delete-all", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.recordFile({
         channelId: "c1",
         relPath: "uploads/libro.pdf",
         messageId: "m1",
         bytes: 100,
         nowMs: 1,
      });
      store.recordFile({
         channelId: "c1",
         relPath: "ensayo.docx",
         messageId: "m2",
         bytes: 200,
         nowMs: 2,
      });
      expect(store.fileManifest("c1").map((f) => f.rel_path)).toEqual([
         "ensayo.docx",
         "uploads/libro.pdf",
      ]);

      // Re-sending the same file updates the carrying message (upsert).
      store.recordFile({
         channelId: "c1",
         relPath: "ensayo.docx",
         messageId: "m3",
         bytes: 250,
         nowMs: 3,
      });
      expect(
         store.fileManifest("c1").find((f) => f.rel_path === "ensayo.docx")
            ?.message_id,
      ).toBe("m3");

      store.removeFileRecord("c1", "uploads/libro.pdf");
      expect(store.fileManifest("c1")).toHaveLength(1);
      store.deleteFileRecords("c1");
      expect(store.fileManifest("c1")).toHaveLength(0);
      mem.close();
   });
});

describe("WorkshopStore file manifest storage_key (migration v3)", () => {
   const base = { guildId: "g1", userId: "u1", userTag: "user#1", nowMs: 1000 };

   test("setStorageKey round-trips; recordFile upserts preserve it", async () => {
      const { store, mem } = await newStore();
      store.createSession({ ...base, channelId: "c1" });
      store.recordFile({
         channelId: "c1",
         relPath: "a.txt",
         messageId: "m1",
         bytes: 10,
         nowMs: 1,
      });
      expect(store.fileManifest("c1")[0]!.storage_key).toBeNull();

      store.setStorageKey("c1", "a.txt", "workshop/c1/a.txt");
      expect(store.fileManifest("c1")[0]!.storage_key).toBe(
         "workshop/c1/a.txt",
      );

      // An archive re-point changes the Discord carrier, NOT the stored object.
      store.recordFile({
         channelId: "c1",
         relPath: "a.txt",
         messageId: "m2",
         bytes: 10,
         nowMs: 2,
      });
      const rec = store.fileManifest("c1")[0]!;
      expect(rec.message_id).toBe("m2");
      expect(rec.storage_key).toBe("workshop/c1/a.txt");

      store.setStorageKey("c1", "a.txt", null);
      expect(store.fileManifest("c1")[0]!.storage_key).toBeNull();
      mem.close();
   });

   test("a v2 database migrates to v3 with rows intact and NULL storage_key", async () => {
      const mem = new SqliteMemoryStore({ path: ":memory:" });
      // Apply only v1+v2 first (the pre-MinIO schema).
      await new NamespacedMemory(mem, "workshop").migrate(
         "workshop",
         WORKSHOP_MIGRATIONS.filter((m) => m.version <= 2),
      );
      const store = new WorkshopStore(mem.db());
      store.createSession({ ...base, channelId: "c1" });
      store.recordFile({
         channelId: "c1",
         relPath: "viejo.pdf",
         messageId: "m1",
         bytes: 5,
         nowMs: 1,
      });

      // Now the v3 migration lands.
      await new NamespacedMemory(mem, "workshop").migrate(
         "workshop",
         WORKSHOP_MIGRATIONS,
      );

      const rec = store.fileManifest("c1")[0]!;
      expect(rec.rel_path).toBe("viejo.pdf");
      expect(rec.storage_key).toBeNull();
      store.setStorageKey("c1", "viejo.pdf", "workshop/c1/viejo.pdf");
      expect(store.fileManifest("c1")[0]!.storage_key).toBe(
         "workshop/c1/viejo.pdf",
      );
      mem.close();
   });
});
