import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
   mkdirSync,
   mkdtempSync,
   rmSync,
   writeFileSync,
   existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentBuilder } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { WorkshopStore, WORKSHOP_MIGRATIONS } from "../store.js";
import { SessionWorkspace } from "../workspace.js";
import { sandboxAvailable } from "../sandbox.js";
import {
   autoDeliverForgotten,
   deliverQueuedFiles,
   type DeliverChannel,
   type DeliverPort,
} from "../deliver.js";

/**
 * The delivery seam: artifact check → attach → manifest row (+ MinIO). These
 * tests drive it through its public entry points with real files on disk and a
 * real SQLite manifest, and assert what a MEMBER would see: how many messages,
 * which attachments, and which files the ledger now considers delivered.
 */

const CHANNEL = "1550000000000000001";

let root: string;
let workspace: SessionWorkspace;
let store: WorkshopStore;
let mem: SqliteMemoryStore;
let sent: Array<{ content?: string; files?: AttachmentBuilder[] }>;

/** Fake channel: records every send, never talks to Discord. */
function fakeChannel(record: typeof sent): DeliverChannel {
   return {
      isSendable: () => true,
      send: async (payload: {
         content?: string;
         files?: AttachmentBuilder[];
      }) => {
         record.push(payload);
         return { id: `msg-${record.length}` };
      },
   };
}

function port(overrides: Partial<DeliverPort> = {}): DeliverPort {
   return {
      channelId: CHANNEL,
      channel: fakeChannel(sent),
      workspace,
      store,
      storage: null,
      venvDir: null,
      now: () => 1_700_000_000_000,
      ...overrides,
   };
}

beforeEach(async () => {
   const base = mkdtempSync(join(tmpdir(), "workshop-deliver-"));
   root = join(base, "session");
   mkdirSync(root, { recursive: true });
   workspace = new SessionWorkspace(root);
   mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "workshop").migrate(
      "workshop",
      WORKSHOP_MIGRATIONS,
   );
   store = new WorkshopStore(mem.db());
   sent = [];
});

afterEach(() => {
   mem.close();
   rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("autoDeliverForgotten", () => {
   test("attaches this turn's forgotten deliverables in ONE message and records them", async () => {
      const before = new Map<string, number>();
      writeFileSync(join(root, "nota.csv"), "a,b\n1,2\n");
      writeFileSync(join(root, "figura.svg"), "<svg/>");
      const outcome = await autoDeliverForgotten(port(), {
         before,
         skip: new Set(),
         maxBytes: 9_500_000,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]?.files).toHaveLength(2);
      expect(sent[0]?.content).toContain("nota.csv");
      expect(sent[0]?.content).toContain("figura.svg");
      expect(outcome.sent.sort()).toEqual(["figura.svg", "nota.csv"]);
      expect(
         store
            .fileManifest(CHANNEL)
            .map((f) => f.rel_path)
            .sort(),
      ).toEqual(["figura.svg", "nota.csv"]);
   });

   test("never delivers a work copy kept in .scratch/ or recalc/", async () => {
      mkdirSync(join(root, "recalc"), { recursive: true });
      mkdirSync(join(root, ".scratch"), { recursive: true });
      // Same basename everywhere: only the workspace-root file is the deliverable.
      writeFileSync(join(root, "presupuesto.csv"), "real");
      writeFileSync(
         join(root, "recalc", "presupuesto.csv"),
         "copia recalculada",
      );
      writeFileSync(join(root, ".scratch", "presupuesto.csv"), "temporal");

      await autoDeliverForgotten(port(), {
         before: new Map(),
         skip: new Set(),
         maxBytes: 9_500_000,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]?.files).toHaveLength(1);
      expect(sent[0]?.content).toContain("presupuesto.csv");
      expect(store.fileManifest(CHANNEL).map((f) => f.rel_path)).toEqual([
         "presupuesto.csv",
      ]);
   });

   test("skips files already in the manifest (no duplicate delivery)", async () => {
      writeFileSync(join(root, "informe.csv"), "x");
      store.recordFile({
         channelId: CHANNEL,
         relPath: "informe.csv",
         messageId: "m-old",
         bytes: 1,
         nowMs: 1,
      });
      const outcome = await autoDeliverForgotten(port(), {
         before: new Map(),
         skip: new Set(["informe.csv"]),
         maxBytes: 9_500_000,
      });
      expect(sent).toHaveLength(0);
      expect(outcome.sent).toEqual([]);
   });

   test("leaves oversized files out instead of failing the whole batch", async () => {
      writeFileSync(join(root, "grande.csv"), "x".repeat(500));
      writeFileSync(join(root, "chico.csv"), "y");
      const outcome = await autoDeliverForgotten(port(), {
         before: new Map(),
         skip: new Set(),
         maxBytes: 100,
      });
      expect(outcome.sent).toEqual(["chico.csv"]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.files).toHaveLength(1);
   });

   test("splits past Discord's attachment cap, grouped per message", async () => {
      const names = Array.from({ length: 12 }, (_, i) => `f${i}.csv`);
      for (const n of names) writeFileSync(join(root, n), n);
      await autoDeliverForgotten(port(), {
         before: new Map(),
         skip: new Set(),
         maxBytes: 9_500_000,
      });
      expect(sent.map((m) => m.files?.length)).toEqual([10, 2]);
      expect(store.fileManifest(CHANNEL)).toHaveLength(12);
   });

   test("does nothing when the channel cannot receive messages", async () => {
      writeFileSync(join(root, "nota.csv"), "x");
      const outcome = await autoDeliverForgotten(
         port({
            channel: {
               isSendable: () => false,
               send: async () => ({ id: "x" }),
            },
         }),
         { before: new Map(), skip: new Set(), maxBytes: 9_500_000 },
      );
      expect(outcome.sent).toEqual([]);
      expect(store.fileManifest(CHANNEL)).toHaveLength(0);
   });

   const venv = join(process.cwd(), "data", "workshop", "venv");
   const realVenv =
      sandboxAvailable() && existsSync(join(venv, "bin", "python3"));

   test.skipIf(!realVenv)(
      "a file that fails the structural check is reported, not attached, and the rest still ships",
      async () => {
         // A .docx that is not a ZIP container: the real reader fails on it.
         writeFileSync(join(root, "roto.docx"), "esto no es un docx");
         writeFileSync(join(root, "bien.csv"), "a,b\n");
         const outcome = await autoDeliverForgotten(port({ venvDir: venv }), {
            before: new Map(),
            skip: new Set(),
            maxBytes: 9_500_000,
         });

         expect(outcome.sent).toEqual(["bien.csv"]);
         expect(outcome.blocked).toEqual(["roto.docx"]);
         const attachmentMessages = sent.filter(
            (m) => (m.files?.length ?? 0) > 0,
         );
         expect(attachmentMessages).toHaveLength(1);
         expect(attachmentMessages[0]?.files).toHaveLength(1);
         const notice = sent.find((m) => m.content?.includes("No adjunté"));
         expect(notice?.content).toContain("roto.docx");
         expect(store.fileManifest(CHANNEL).map((f) => f.rel_path)).toEqual([
            "bien.csv",
         ]);
      },
   );
});

describe("deliverQueuedFiles", () => {
   test("keeps each queued caption in its own message", async () => {
      writeFileSync(join(root, "a.csv"), "a");
      writeFileSync(join(root, "b.svg"), "<svg/>");
      const outcome = await deliverQueuedFiles(port(), [
         { relPath: "a.csv", caption: "la tabla de gastos" },
         { relPath: "b.svg", caption: "el logo vectorial" },
      ]);
      expect(outcome.sent).toEqual(["a.csv", "b.svg"]);
      expect(sent.map((m) => m.content)).toEqual([
         "la tabla de gastos",
         "el logo vectorial",
      ]);
      expect(sent.every((m) => m.files?.length === 1)).toBe(true);
      expect(store.fileManifest(CHANNEL)).toHaveLength(2);
   });

   test("an empty queue sends nothing", async () => {
      const outcome = await deliverQueuedFiles(port(), []);
      expect(outcome.sent).toEqual([]);
      expect(sent).toHaveLength(0);
   });
});
