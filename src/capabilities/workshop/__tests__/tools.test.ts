import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
   WorkshopToolSource,
   capOutput,
   type SessionActions,
} from "../tools.js";
import { SessionWorkspace } from "../workspace.js";

let root: string;
let workspace: SessionWorkspace;
let sent: Array<{ relPath: string; caption: string | null }>;
let cleared: boolean;
let closed: boolean;
let contextClearedNow: boolean;
let renamed: string | null;

function newSource(delivered: string[] = []) {
   sent = [];
   cleared = false;
   closed = false;
   contextClearedNow = false;
   renamed = null;
   const actions: SessionActions = {
      queueSendFile: (relPath, caption) => sent.push({ relPath, caption }),
      queueClear: () => (cleared = true),
      queueClose: () => (closed = true),
      clearContextNow: () => (contextClearedNow = true),
      renameChannel: async (name) => {
         renamed = name;
         return { ok: true, name: `taller-${name}` };
      },
   };
   return new WorkshopToolSource({
      workspace,
      actions,
      venvDir: null,
      maxTimeoutMs: 60_000,
      deliveredPaths: () => new Set(delivered),
   });
}

beforeEach(() => {
   root = mkdtempSync(join(tmpdir(), "workshop-tools-"));
   workspace = new SessionWorkspace(root);
   workspace.ensure();
});
afterEach(() => {
   rmSync(root, { recursive: true, force: true });
});

describe("workshop file tools", () => {
   test("write → list → read round-trip", async () => {
      const src = newSource();
      const w = await src.handle("workshop_write_file", {
         path: "ensayo.md",
         content: "# Hola",
      });
      expect(w.status).toBe("success");

      const l = await src.handle("workshop_list_files", {});
      expect(l.status).toBe("success");
      expect(
         (l.payload as { files: Array<{ path: string }> }).files.map(
            (f) => f.path,
         ),
      ).toEqual(["ensayo.md"]);

      const r = await src.handle("workshop_read_file", { path: "ensayo.md" });
      expect(r.status).toBe("success");
      expect((r.payload as { content: string }).content).toBe("# Hola");
   });

   test("read of a missing file and traversal paths are clean errors", async () => {
      const src = newSource();
      const missing = await src.handle("workshop_read_file", {
         path: "nope.txt",
      });
      expect(missing.status).toBe("error");
      const escape = await src.handle("workshop_read_file", {
         path: "../../etc/passwd",
      });
      expect(escape.status).toBe("error");
      const escapeWrite = await src.handle("workshop_write_file", {
         path: "../evil.txt",
         content: "x",
      });
      expect(escapeWrite.status).toBe("error");
   });

   test("send_file queues an existing file and rejects a missing/oversized one", async () => {
      const src = newSource();
      workspace.writeText("reporte.txt", "listo");
      const ok = await src.handle("workshop_send_file", {
         path: "reporte.txt",
         caption: "aquí está",
      });
      expect(ok.status).toBe("success");
      expect(sent).toEqual([{ relPath: "reporte.txt", caption: "aquí está" }]);

      const missing = await src.handle("workshop_send_file", {
         path: "nada.txt",
      });
      expect(missing.status).toBe("error");
      expect(sent).toHaveLength(1);
   });

   test("list_files carries the delivery ledger (uploads always delivered)", async () => {
      const src = newSource(["enviado.docx"]);
      workspace.writeText("enviado.docx", "ya");
      workspace.writeText("pendiente.pdf", "aún no");
      workspace.writeText("uploads/apuntes.pdf", "del usuario");

      const res = await src.handle("workshop_list_files", {});
      expect(res.status).toBe("success");
      const payload = res.payload as {
         files: Array<{ path: string; tipo: string; entregado: boolean }>;
         pendientes_de_entrega: string[];
         note?: string;
      };
      const byPath = Object.fromEntries(payload.files.map((f) => [f.path, f]));
      expect(byPath["enviado.docx"]).toMatchObject({
         tipo: "generado",
         entregado: true,
      });
      expect(byPath["pendiente.pdf"]).toMatchObject({
         tipo: "generado",
         entregado: false,
      });
      expect(byPath["uploads/apuntes.pdf"]).toMatchObject({
         tipo: "subida_del_usuario",
         entregado: true,
      });
      expect(payload.pendientes_de_entrega).toEqual(["pendiente.pdf"]);
      expect(payload.note).toContain("workshop_send_file");
   });
});

describe("workshop session tools", () => {
   test("clear_session clears context now and queues the purge", async () => {
      const src = newSource();
      const res = await src.handle("workshop_clear_session", {});
      expect(res.status).toBe("success");
      expect(contextClearedNow).toBe(true);
      expect(cleared).toBe(true);
      expect(closed).toBe(false);
   });

   test("close_session requires confirm=true", async () => {
      const src = newSource();
      const noConfirm = await src.handle("workshop_close_session", {});
      expect(noConfirm.status).toBe("error");
      expect(closed).toBe(false);

      const confirmed = await src.handle("workshop_close_session", {
         confirm: true,
      });
      expect(confirmed.status).toBe("success");
      expect(closed).toBe(true);
   });

   test("rename_session delegates to the action", async () => {
      const src = newSource();
      const res = await src.handle("workshop_rename_session", {
         name: "tesis",
      });
      expect(res.status).toBe("success");
      expect(renamed).toBe("tesis");
   });
});

describe("capOutput", () => {
   test("short output passes through; long output keeps head and tail", () => {
      expect(capOutput("hola", 100)).toBe("hola");
      const long = "A".repeat(5000) + "ERROR-AT-END";
      const capped = capOutput(long, 1000);
      expect(capped.length).toBeLessThan(1100);
      expect(capped).toContain("[salida recortada]");
      expect(capped).toContain("ERROR-AT-END");
   });
});
