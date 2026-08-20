/**
 * Who may change the GLOBAL watch list.
 *
 * The account list is server-wide: adding one makes the bot republish that
 * account's posts into every bound community channel. Until 2026-08-13 the
 * mutating tools had no authorization at all — anyone who could @-mention the
 * bot in a bound channel could add their own Instagram account and have the bot
 * push whatever they posted (with the bot's Administrator standing behind it).
 */
import { describe, test, expect } from "vitest";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import {
   InstagramMonitorStore,
   INSTAGRAM_MONITOR_MIGRATIONS,
} from "../store.js";
import { InstagramMonitorToolSource } from "../source.js";

const MUTATING = [
   "monitor_add_account",
   "monitor_remove_account",
   "monitor_pause_account",
   "monitor_force_poll",
];
const READ_ONLY = [
   "monitor_list_accounts",
   "monitor_recent_pushed",
   "monitor_test_classify",
];

async function newSource(isMod: boolean) {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "instagram_monitor").migrate(
      "instagram_monitor",
      INSTAGRAM_MONITOR_MIGRATIONS,
   );
   const store = new InstagramMonitorStore(mem.db());
   const source = new InstagramMonitorToolSource({
      store,
      channelId: "CHAN_1",
      userId: "USER_1",
      nowMs: Date.parse("2026-08-13T18:00:00.000Z"),
      isMod,
   });
   return { source, store, mem };
}

describe("InstagramMonitorToolSource — watch-list authorization", () => {
   test("a moderator gets the full tool set", async () => {
      const { source, mem } = await newSource(true);
      const names = source.tools().map((t) => t.name);
      for (const n of [...MUTATING, ...READ_ONLY]) expect(names).toContain(n);
      mem.close();
   });

   test("a non-mod is never HANDED the mutating tools (they leave the payload)", async () => {
      const { source, mem } = await newSource(false);
      const names = source.tools().map((t) => t.name);
      for (const n of MUTATING) expect(names).not.toContain(n);
      // Reading stays open — "¿qué publicaste hoy?" is a fair question in the channel.
      for (const n of READ_ONLY) expect(names).toContain(n);
      mem.close();
   });

   test("handle() refuses a mutating tool for a non-mod even if it is dispatched anyway", async () => {
      const { source, store, mem } = await newSource(false);
      for (const tool of MUTATING) {
         const res = await source.handle(tool, {
            username: "cuenta_atacante",
            paused: true,
         });
         expect(res.status).toBe("error");
         expect((res.payload as { error: string }).error).toMatch(
            /moderación/i,
         );
      }
      expect(store.listAccounts()).toHaveLength(0); // nothing reached the DB
      mem.close();
   });

   test("a moderator can still add an account (the gate is not a wall)", async () => {
      const { source, store, mem } = await newSource(true);
      const res = await source.handle("monitor_add_account", {
         username: "@RevolucionZ",
      });
      expect(res.status).toBe("success");
      expect(store.listAccounts().map((a) => a.username)).toEqual([
         "revolucionz",
      ]);
      mem.close();
   });
});
