import { test, expect, vi } from "vitest";
import { SqliteMemoryStore } from "../../../memory/store.js";
import { CalendarStore, CALENDAR_MIGRATIONS } from "../store.js";
import { sendBroadcastExactlyOnce } from "../broadcast-channels.js";

test("different draft tokens for the same occurrence/destination reserve one delivery across source instances", async () => {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   await memory.migrate("calendar", CALENDAR_MIGRATIONS);
   const a = new CalendarStore(memory.db()), b = new CalendarStore(memory.db());
   expect(a.reserveBroadcast(12, 1000, "channel", "first-token", 100)).toMatchObject({ reserved: true });
   a.finishBroadcast(12, 1000, "channel", "first-token", "message");
   expect(b.reserveBroadcast(12, 1000, "channel", "different-token", 1000)).toMatchObject({ reserved: false, messageId: "message" });
   expect(b.reserveBroadcast(12, 1000, "another-channel", "token", 1000)).toMatchObject({ reserved: true });
   expect(b.reserveBroadcast(12, 2000, "channel", "token", 1000)).toMatchObject({ reserved: true });
   expect(b.reserveBroadcast(12, 1000, "channel", "later-token", 601000)).toMatchObject({ reserved: true });
   memory.close();
});
test("unconfirmed delivery is reserved and never reported as proof of failure/replayed immediately", async () => {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   await memory.migrate("calendar", CALENDAR_MIGRATIONS);
   const store = new CalendarStore(memory.db());
   store.reserveBroadcast(12, 1000, "channel", "token", 100);
   expect(store.reserveBroadcast(12, 1000, "channel", "new-token", 200)).toMatchObject({ reserved: false, messageId: null, outcome: "unconfirmed" });
   memory.close();
});
test.each([false, true])("repair/adopt our own new duplicate copies after REST accepted send (lost response=%s)", async (lost) => {
   const bot = "200000000000000001", old = "200000000000000002", first = "200000000000000003", second = "200000000000000004";
   const deleteOld = vi.fn(), deleteDuplicate = vi.fn(async () => {});
   const copies = new Map([
      [old, { id: old, content: "fictitious announcement", author: { id: bot }, delete: deleteOld }],
      [first, { id: first, content: "fictitious announcement", author: { id: bot } }],
      [second, { id: second, content: "fictitious announcement", author: { id: bot }, delete: deleteDuplicate }],
   ]);
   const fetch = vi.fn().mockResolvedValueOnce(new Map([[old, copies.get(old)]])).mockResolvedValueOnce(copies);
   const channel = { messages: { fetch }, send: vi.fn(async () => { if (lost) throw new Error("timeout"); return { id: second }; }) };
   expect(await sendBroadcastExactlyOnce(channel, bot, { content: "fictitious announcement", allowedMentions: { parse: [], roles: [] }, nonce: "stable", enforceNonce: true })).toEqual({ id: first });
   expect(deleteDuplicate).toHaveBeenCalledTimes(1);
   expect(deleteOld).not.toHaveBeenCalled();
});
test("a pre-send failure releases the reservation so a fixed channel can retry at once", async () => {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   await memory.migrate("calendar", CALENDAR_MIGRATIONS);
   const store = new CalendarStore(memory.db());
   expect(store.reserveBroadcast(12, 1000, "channel", "first", 100)).toMatchObject({ reserved: true });
   // e.g. channel_not_sendable before any POST: nothing can have been sent.
   store.releaseBroadcast(12, 1000, "channel", "first");
   expect(store.reserveBroadcast(12, 1000, "channel", "retry", 200)).toMatchObject({ reserved: true });
   // A posted delivery is never released, and a stale token can't release it.
   store.finishBroadcast(12, 1000, "channel", "retry", "message");
   store.releaseBroadcast(12, 1000, "channel", "retry");
   store.releaseBroadcast(12, 1000, "channel", "first");
   expect(store.reserveBroadcast(12, 1000, "channel", "third", 300)).toMatchObject({ reserved: false, messageId: "message" });
   memory.close();
});
