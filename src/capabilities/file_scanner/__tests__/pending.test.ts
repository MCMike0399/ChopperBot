import { describe, test, expect, vi } from "vitest";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { FileScannerStore, FILE_SCANNER_MIGRATIONS } from "../store.js";
import { PendingReconciler, nextPendingCheck } from "../pending.js";
import { renderLine } from "../format.js";
import type { FileScanner } from "../scanner.js";
import type { Client, Message } from "discord.js";

const NOW = 1_000_000;

const CLEAN = { malicious: 0, suspicious: 0, harmless: 70, undetected: 5 };
const BAD = { malicious: 40, suspicious: 1, harmless: 10, undetected: 5 };

async function newStore() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "file_scanner").migrate(
      "file_scanner",
      FILE_SCANNER_MIGRATIONS,
   );
   return { store: new FileScannerStore(mem.db()), mem };
}

/** Minimal Discord surface the reconciler touches (card + source message). */
function fakeDiscord(opts: {
   cardContent: string;
   sourceDeletable?: boolean;
   cardMissing?: boolean;
}) {
   const edits: string[] = [];
   const sent: string[] = [];
   const deletes = vi.fn();

   const card = {
      content: opts.cardContent,
      edit: async (content: string) => {
         edits.push(content);
         return card;
      },
   };
   const source = {
      id: "src-1",
      channelId: "chan-1",
      guildId: "guild-1",
      inGuild: () => true,
      guild: { members: { me: { id: "bot" } } },
      channel: { permissionsFor: () => ({ has: () => true }) },
      author: { id: "user-1" },
      delete: async () => {
         deletes();
         if (opts.sourceDeletable === false) throw new Error("no permission");
         return source;
      },
   };
   const channel = {
      messages: {
         fetch: async (id: string) => {
            if (opts.cardMissing) throw new Error("Unknown Message");
            expect(id).toBe("card-1");
            return card as unknown as Message;
         },
      },
      send: async (content: string) => {
         sent.push(content);
      },
   };
   const client = {
      channels: {
         fetch: async (id: string) => {
            if (id === "chan-1") {
               return {
                  ...channel,
                  messages: {
                     fetch: async (mid: string) => {
                        expect(mid).toBe("src-1");
                        return source as unknown as Message;
                     },
                  },
               };
            }
            return channel;
         },
      },
   };
   return { client: client as unknown as Client, edits, sent, deletes, card };
}

async function harness(opts: {
   lookup: () => Promise<{
      malicious: number;
      suspicious: number;
      harmless: number;
      undetected: number;
      total: number;
   } | null>;
   pending: Partial<Parameters<FileScannerStore["upsertPending"]>[0]> & {
      sha256: string;
      cardContent: string;
      cardMissing?: boolean;
      sourceDeletable?: boolean;
   };
   maxAttempts?: number;
   deleteMalicious?: boolean;
}) {
   const { store, mem } = await newStore();
   store.upsertPending({
      fileName: "f.exe",
      uploader: "user-1",
      cardChannelId: "card-chan",
      cardMessageId: "card-1",
      sourceChannelId: "chan-1",
      sourceMessageId: "src-1",
      nowMs: NOW,
      nextCheckAt: NOW,
      ...opts.pending,
   });
   const scanner = {
      recheckByHash: vi.fn(async (sha256: string) => {
         const stats = await opts.lookup();
         if (!stats) return null;
         return {
            kind: "verdict" as const,
            verdict:
               stats.malicious >= 2
                  ? ("malicious" as const)
                  : ("clean" as const),
            stats,
            sha256,
            source: "hash" as const,
         };
      }),
   };
   const discord = fakeDiscord({
      cardContent: opts.pending.cardContent,
      sourceDeletable: opts.pending.sourceDeletable,
      cardMissing: opts.pending.cardMissing,
   });
   const reconciler = new PendingReconciler({
      scanner: scanner as unknown as FileScanner,
      store,
      client: discord.client,
      deleteMalicious: opts.deleteMalicious ?? true,
      maxAttempts: opts.maxAttempts ?? 10,
      now: () => NOW,
   });
   return { store, reconciler, discord, mem, scanner };
}

describe("PendingReconciler", () => {
   test("still analyzing → reschedules with backoff, card untouched", async () => {
      const sha = "a".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { store, reconciler, discord, mem } = await harness({
         lookup: async () => null,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
         },
      });

      expect(await reconciler.sweep()).toBe(1);

      const row = store.getPending(sha);
      expect(row?.attempts).toBe(1);
      expect(row?.next_check_at).toBe(nextPendingCheck(1, NOW));
      expect(discord.edits).toHaveLength(0);
      mem.close();
   });

   test("late clean verdict edits the original card in place", async () => {
      const sha = "b".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { store, reconciler, discord, mem } = await harness({
         lookup: async () => CLEAN,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
         },
      });

      await reconciler.sweep();

      expect(discord.edits).toHaveLength(1);
      expect(discord.edits[0]).toContain("✅");
      expect(discord.edits[0]).toContain("limpio");
      expect(discord.edits[0]).not.toContain("aún lo está analizando");
      expect(discord.edits[0]).not.toContain("@here");
      expect(store.getPending(sha)).toBeUndefined();
      expect(discord.deletes).not.toHaveBeenCalled();
      mem.close();
   });

   test("late malicious verdict deletes the upload and says so", async () => {
      const sha = "c".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { store, reconciler, discord, mem } = await harness({
         lookup: async () => BAD,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
         },
      });

      await reconciler.sweep();

      expect(discord.deletes).toHaveBeenCalledTimes(1);
      expect(discord.edits).toHaveLength(1);
      expect(discord.edits[0]).toContain("🛑");
      expect(discord.edits[0]).toContain("Borré el mensaje con el archivo");
      expect(discord.edits[0]).toContain("@here");
      expect(store.getPending(sha)).toBeUndefined();
      mem.close();
   });

   test("a failed delete still reports the malicious verdict", async () => {
      const sha = "d".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { reconciler, discord, mem } = await harness({
         lookup: async () => BAD,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
            sourceDeletable: false,
         },
      });

      await reconciler.sweep();

      expect(discord.edits[0]).toContain("🛑");
      expect(discord.edits[0]).not.toContain("Borré el mensaje");
      mem.close();
   });

   test("deleteMalicious=false never deletes (warn-only)", async () => {
      const sha = "e".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { reconciler, discord, mem } = await harness({
         lookup: async () => BAD,
         deleteMalicious: false,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
         },
      });

      await reconciler.sweep();

      expect(discord.deletes).not.toHaveBeenCalled();
      expect(discord.edits[0]).toContain("🛑");
      mem.close();
   });

   test("expiry stops the wait and the card stops claiming it's analyzing", async () => {
      const sha = "f".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { store, reconciler, discord, mem } = await harness({
         lookup: async () => null,
         maxAttempts: 1,
         pending: {
            sha256: sha,
            cardContent: `🔎 **Análisis de seguridad (VirusTotal)**\n${pendingLine}`,
         },
      });

      await reconciler.sweep();

      expect(store.getPending(sha)).toBeUndefined();
      expect(discord.edits[0]).toContain("no logré confirmar el veredicto");
      expect(discord.edits[0]).not.toContain("aún lo está analizando");
      mem.close();
   });

   test("a deleted card still yields a posted verdict", async () => {
      const sha = "1".repeat(64);
      const pendingLine = renderLine({
         fileName: "f.exe",
         status: { kind: "pending", sha256: sha },
      });
      const { reconciler, discord, mem } = await harness({
         lookup: async () => CLEAN,
         pending: {
            sha256: sha,
            cardContent: pendingLine,
            cardMissing: true,
         },
      });

      await reconciler.sweep();

      expect(discord.edits).toHaveLength(0);
      expect(discord.sent).toHaveLength(1);
      expect(discord.sent[0]).toContain("✅");
      mem.close();
   });

   test("nextPendingCheck backs off and caps", () => {
      expect(nextPendingCheck(0, 0)).toBe(60_000);
      expect(nextPendingCheck(1, 0)).toBe(120_000);
      expect(nextPendingCheck(99, 0)).toBe(600_000);
   });
});
