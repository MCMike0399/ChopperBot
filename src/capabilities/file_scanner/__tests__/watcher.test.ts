import { describe, test, expect, vi, afterEach } from "vitest";
import type { Client, Message } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { FileScannerStore, FILE_SCANNER_MIGRATIONS } from "../store.js";
import { FileScanWatcher } from "../watcher.js";
import type { FileScanner, ScanOutcome } from "../scanner.js";

const NOW = 5_000_000;

async function newStore() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "file_scanner").migrate(
      "file_scanner",
      FILE_SCANNER_MIGRATIONS,
   );
   return { store: new FileScannerStore(mem.db()), mem };
}

function fakeUpload(opts: {
   outcome: ScanOutcome;
   cardOk?: boolean;
   canDelete?: boolean;
}) {
   const cardEdits: string[] = [];
   const deleted = vi.fn();
   const card = {
      id: "card-1",
      channelId: "chan-1",
      edit: async (content: string) => {
         cardEdits.push(content);
         return card;
      },
   };
   const message = {
      id: "msg-1",
      channelId: "chan-1",
      guildId: "guild-1",
      author: { id: "user-1" },
      inGuild: () => true,
      guild: { members: { me: { id: "bot" } } },
      channel: {
         isThread: () => false,
         parentId: null,
         permissionsFor: () => ({
            // Only ManageMessages (8192) is conditional; everything else is granted.
            has: (bit: bigint) =>
               bit === 8192n ? (opts.canDelete ?? true) : true,
         }),
         isSendable: () => true,
         send: async () => {
            if (opts.cardOk === false) throw new Error("cannot send");
            return card;
         },
      },
      attachments: {
         values: () => [
            {
               name: "bad.exe",
               size: 10,
               url: "http://x/bad.exe",
               contentType: null,
            },
         ],
      },
      react: async () => ({ users: { remove: async () => undefined } }),
      reply: async () => {
         if (opts.cardOk === false) throw new Error("cannot reply");
         return card;
      },
      delete: async () => {
         deleted();
         return message;
      },
   };
   return { message: message as unknown as Message, cardEdits, deleted };
}

afterEach(() => {
   vi.unstubAllGlobals();
});

async function run(opts: {
   outcome: ScanOutcome;
   cardOk?: boolean;
   canDelete?: boolean;
   deleteMalicious?: boolean;
}) {
   // downloadAttachment() goes through global fetch.
   vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
   );
   const { store, mem } = await newStore();
   const upload = fakeUpload(opts);
   const scanner = {
      scanBytes: vi.fn(async () => opts.outcome),
   };
   const watcher = new FileScanWatcher({
      scanner: scanner as unknown as FileScanner,
      store,
      client: { user: null } as unknown as Client,
      maxDownloadBytes: 50 * 1024 * 1024,
      maxUploadBytes: 32 * 1024 * 1024,
      maxFiles: 5,
      videoPolicyFor: () => "scan",
      deleteMalicious: opts.deleteMalicious ?? true,
      alert: async () => undefined,
      now: () => NOW,
   });
   await watcher.handleMessage(upload.message);
   return { store, mem, ...upload };
}

describe("FileScanWatcher malicious handling", () => {
   const MALICIOUS: ScanOutcome = {
      kind: "verdict",
      verdict: "malicious",
      stats: {
         malicious: 40,
         suspicious: 0,
         harmless: 10,
         undetected: 5,
         total: 55,
      },
      sha256: "bad".padEnd(64, "0"),
      source: "hash",
   };

   test("a confirmed malicious file gets its message deleted and the card says so", async () => {
      const { cardEdits, deleted, mem } = await run({ outcome: MALICIOUS });
      expect(deleted).toHaveBeenCalledTimes(1);
      const finalCard = cardEdits.at(-1) ?? "";
      expect(finalCard).toContain("🛑");
      expect(finalCard).toContain("Borré el mensaje con el archivo");
      expect(finalCard).toContain("@here");
      mem.close();
   });

   test("no delete without ManageMessages, and the card doesn't claim one", async () => {
      const { cardEdits, deleted, mem } = await run({
         outcome: MALICIOUS,
         canDelete: false,
      });
      expect(deleted).not.toHaveBeenCalled();
      expect(cardEdits.at(-1)).not.toContain("Borré el mensaje");
      mem.close();
   });

   test("clean files are never deleted", async () => {
      const { deleted, mem } = await run({
         outcome: {
            kind: "verdict",
            verdict: "clean",
            stats: {
               malicious: 0,
               suspicious: 0,
               harmless: 70,
               undetected: 5,
               total: 75,
            },
            sha256: "ok".padEnd(64, "0"),
            source: "hash",
         },
      });
      expect(deleted).not.toHaveBeenCalled();
      mem.close();
   });
});

describe("FileScanWatcher pending hand-off", () => {
   test("an unfinished analysis is persisted for the reconciler", async () => {
      const sha = "pend".padEnd(64, "0");
      const { store, mem } = await run({
         outcome: { kind: "pending", sha256: sha },
      });
      const row = store.getPending(sha);
      expect(row).toMatchObject({
         sha256: sha,
         file_name: "bad.exe",
         uploader: "user-1",
         card_channel_id: "chan-1",
         card_message_id: "card-1",
         source_channel_id: "chan-1",
         source_message_id: "msg-1",
         attempts: 0,
      });
      expect(row?.next_check_at).toBeGreaterThan(NOW);
      mem.close();
   });

   test("a card that failed to post still hands off (null card id)", async () => {
      const sha = "pend2".padEnd(64, "0");
      const { store, mem } = await run({
         outcome: { kind: "pending", sha256: sha },
         cardOk: false,
      });
      expect(store.getPending(sha)?.card_message_id).toBeNull();
      mem.close();
   });
});
