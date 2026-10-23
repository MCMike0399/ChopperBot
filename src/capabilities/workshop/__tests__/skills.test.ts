import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKSHOP_SKILLS } from "../skills.js";
import { checkWorkshopFile } from "../artifact-check.js";
import { SessionWorkspace } from "../workspace.js";
import { runPython, sandboxAvailable } from "../sandbox.js";
import { WorkshopToolSource } from "../tools.js";

const venv = resolve("data/workshop/venv");
const live = sandboxAvailable() && existsSync(join(venv, "bin/python3"));
let root: string;
let ws: SessionWorkspace;
beforeEach(() => {
   root = mkdtempSync(join(tmpdir(), "workshop-skills-"));
   ws = new SessionWorkspace(root);
   ws.ensure();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!live)(
   "real sandbox artifact recipes and quality checks",
   () => {
      test.each(
         Object.keys(WORKSHOP_SKILLS) as Array<keyof typeof WORKSHOP_SKILLS>,
      )(
         "%s example generates a file its native reader can open",
         async (format) => {
            const code = /```python\n([\s\S]*?)\n```/.exec(
               WORKSHOP_SKILLS[format],
            )![1];
            const result = await runPython(code, {
               workspaceDir: root,
               venvDir: venv,
               timeoutMs: 30000,
            });
            expect(result.stderr, result.stderr).not.toContain("Traceback");
            expect(result.exitCode, result.stderr).toBe(0);
            const target = {
               docx: "guia.docx",
               xlsx: "presupuesto.xlsx",
               pptx: "presentacion.pptx",
               pdf: "guia.pdf",
               plots: "grafica.png",
            }[format];
            const checked = await checkWorkshopFile(ws, target, venv);
            expect(checked, JSON.stringify(checked)).toMatchObject({
               checked: true,
               ok: true,
               errors: [],
            });
            if (format === "xlsx")
               expect(checked.facts.formulas_without_cached_value).toBe(2);
            if (format === "pdf") expect(checked.facts.pages).toBe(1);
         },
         30000,
      );
      test("rejects a corrupt file in the actual send tool before queueing", async () => {
         ws.writeText("corrupt.docx", "this is not a Word document");
         let queued = false;
         const tools = new WorkshopToolSource({
            workspace: ws,
            venvDir: venv,
            maxTimeoutMs: 30000,
            deliveredPaths: () => new Set(),
            actions: {
               queueSendFile: () => {
                  queued = true;
               },
               queueClear: () => {},
               queueClose: () => {},
               clearContextNow: () => {},
               renameChannel: async () => ({ ok: true }),
            },
         });
         const result = await tools.handle("workshop_send_file", {
            path: "corrupt.docx",
         });
         expect(result.status).toBe("error");
         expect(queued).toBe(false);
      });
      test("detects broken spreadsheet references and off-slide content", async () => {
         const code =
            "from openpyxl import Workbook\nw=Workbook();w.active['A1']='=#REF!';w.save('broken.xlsx')\nfrom pptx import Presentation\nfrom pptx.util import Inches\np=Presentation();s=p.slides.add_slide(p.slide_layouts[6]);s.shapes.add_textbox(Inches(20),0,Inches(2),Inches(1)).text='Outside';p.save('bad.pptx')";
         expect(
            (
               await runPython(code, {
                  workspaceDir: root,
                  venvDir: venv,
                  timeoutMs: 30000,
               })
            ).exitCode,
         ).toBe(0);
         expect((await checkWorkshopFile(ws, "broken.xlsx", venv)).ok).toBe(
            false,
         );
         expect(
            (await checkWorkshopFile(ws, "bad.pptx", venv)).warnings.join(" "),
         ).toContain("fuera de la diapositiva");
      }, 30000);
   },
);

describe("review limits", () => {
   test("unsupported formats and missing venv report unverified, never claim passed checks", async () => {
      ws.writeText("notes.txt", "hi");
      expect(await checkWorkshopFile(ws, "notes.txt", null)).toMatchObject({
         checked: false,
         ok: true,
      });
      ws.writeText("file.pdf", "placeholder");
      expect(await checkWorkshopFile(ws, "file.pdf", null)).toMatchObject({
         checked: false,
         ok: true,
      });
      await expect(
         checkWorkshopFile(ws, "../../secret.pdf", venv),
      ).rejects.toThrow();
   });
});
