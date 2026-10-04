import { describe, test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Events, type Client } from "discord.js";
import {
   TranscriptCache,
   registerTranscriptCache,
   transcriptCacheFor,
} from "../transcript-cache.js";
import type {
   ConversationMessage,
   ConversationProvider,
} from "../conversation.js";
import { repairMemberMentions } from "../turn-context.js";

const NOW = Date.parse("2026-10-04T18:00:00Z"),
   BASE = 200000000000000000n;
const message = (n: number, text = "texto ficticio"): ConversationMessage => ({
   id: String(BASE + BigInt(n)),
   authorId: "200000000000000999",
   author: "Persona ficticia",
   bot: false,
   timestamp: NOW + n,
   text,
   replyTo: null,
   url: `https://discord.com/channels/1/2/${BASE + BigInt(n)}`,
});
const limits = {
   channelChars: 800000,
   globalChars: 1600000,
   channelMessages: 4000,
   globalMessages: 8000,
   channels: 5,
};
const options = {
   now: NOW + 10000,
   before: String(BASE + 10000n),
   maxChars: 600000,
   pages: 20,
   botId: null,
};
afterEach(() => vi.useRealTimers());
function provider(messages: ConversationMessage[]) {
   return {
      checkAccess: vi.fn(async () => {}),
      fetchPage: vi.fn(
         async (_channel: string, before: string | undefined, limit: number) =>
            messages
               .filter((m) => !before || BigInt(m.id) < BigInt(before))
               .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
               .slice(0, limit),
      ),
   };
}

describe("bounded transcript memory", () => {
   test("backfills days beyond 100 messages once; cached reads still refresh access", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache(limits),
         source = provider(
            Array.from({ length: 250 }, (_, i) =>
               message(i + 1, "x".repeat(1000)),
            ),
         );
      const first = await cache.read(source, "c", options);
      expect(first.messages).toHaveLength(250);
      expect(source.fetchPage).toHaveBeenCalledTimes(3);
      await cache.read(source, "c", options);
      expect(source.fetchPage).toHaveBeenCalledTimes(3);
      expect(source.checkAccess).toHaveBeenCalledTimes(4);
      source.checkAccess.mockRejectedValueOnce(new Error("revoked"));
      await expect(cache.read(source, "c", options)).rejects.toThrow("revoked");
   });
   test("concurrent backfill cannot resurrect a deletion or overwrite an edit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache(limits);
      let complete!: (messages: ConversationMessage[]) => void;
      const source: ConversationProvider = {
         checkAccess: async () => {},
         fetchPage: () =>
            new Promise((resolve) => {
               complete = resolve;
            }),
      };
      const pending = cache.read(source, "c", { ...options, pages: 1 });
      await Promise.resolve();
      await Promise.resolve();
      cache.update("c", message(2, "texto editado"));
      cache.delete("c", message(1).id);
      complete([message(1, "texto borrado"), message(2, "texto anterior")]);
      const result = await pending;
      expect(result.messages.map((m) => m.text)).toEqual(["texto editado"]);
   });
   test("an edit followed by deletion while its partial fetch resolves cannot reappear", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache(limits);
      cache.update("c", message(1));
      let complete!: (m: ConversationMessage) => void;
      cache.refreshPartial(
         "c",
         message(1).id,
         () =>
            new Promise((r) => {
               complete = r;
            }),
      );
      await Promise.resolve();
      cache.delete("c", message(1).id);
      complete(message(1, "resultado tardío"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(await cache.identities(provider([]), "c")).toEqual([]);
   });
   test("LRU and per-channel/global caps bound retained content", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache({
         ...limits,
         channelChars: 1000,
         globalChars: 1500,
         channels: 2,
         channelMessages: 2,
      });
      for (let c = 0; c < 5; c++)
         for (let i = 1; i <= 5; i++)
            cache.update(String(c), message(i, "x".repeat(200)));
      expect(cache.stats().channels).toBeLessThanOrEqual(2);
      expect(cache.stats().chars).toBeLessThanOrEqual(1500);
      expect(cache.stats().messages).toBeLessThanOrEqual(4);
      cache.clear();
      expect(cache.stats().chars).toBe(0);
   });
   test("prefix stays append-only between budget resets; edits still change the evidence", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache(limits),
         source = provider([message(1), message(2)]);
      const first = await cache.read(source, "c", options);
      cache.update("c", message(3));
      const second = await cache.read(source, "c", options);
      expect(second.messages.slice(0, 2)).toEqual(first.messages);
      cache.update("c", message(1, "editado"));
      expect((await cache.read(source, "c", options)).messages[0].text).toBe(
         "editado",
      );
   });
   test("disconnect/eviction invalidates an in-flight read rather than returning stale content", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const cache = new TranscriptCache(limits);
      let complete!: (rows: ConversationMessage[]) => void;
      const pending = cache.read(
         {
            checkAccess: async () => {},
            fetchPage: () =>
               new Promise((r) => {
                  complete = r;
               }),
         },
         "c",
         options,
      );
      await Promise.resolve();
      await Promise.resolve();
      cache.clear();
      complete([message(1)]);
      await expect(pending).rejects.toThrow("invalidated");
   });
});

test("raw nickname tokens become real mentions only for one readable identity", () => {
   const identities = [{ id: String(BASE), name: "Persona ficticia" }];
   expect(repairMemberMentions("hola <@Persona ficticia>", identities)).toBe(
      `hola <@${BASE}>`,
   );
   expect(repairMemberMentions("hola <@nombre desconocido>", identities)).toBe(
      "hola @nombre desconocido",
   );
   expect(
      repairMemberMentions("<@Persona ficticia>", [
         ...identities,
         { id: String(BASE + 1n), name: "Persona ficticia" },
      ]),
   ).toBe("@Persona ficticia");
});

test("a new gateway session (ShardReady) drops the cache; a resume keeps it", () => {
   const client = new EventEmitter() as unknown as Client;
   registerTranscriptCache(client);
   const cache = transcriptCacheFor(client);
   const clear = vi.spyOn(cache, "clear");
   (client as unknown as EventEmitter).emit(Events.ShardResume, 0, 0);
   expect(clear).not.toHaveBeenCalled();
   (client as unknown as EventEmitter).emit(Events.ShardReady, 0);
   expect(clear).toHaveBeenCalledTimes(1);
});
