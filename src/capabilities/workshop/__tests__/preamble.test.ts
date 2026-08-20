import { describe, test, expect } from "vitest";
import {
   renderWorkshopPrompt,
   type WorkshopPromptContext,
} from "../preamble.js";
import type { WorkspaceFile } from "../workspace.js";

function ctx(
   overrides: Partial<WorkshopPromptContext> = {},
): WorkshopPromptContext {
   return {
      now: new Date("2026-08-09T12:00:00Z"),
      userTag: "testuser",
      userId: "123456789012345678",
      channelName: "taller-testuser",
      files: [],
      sandboxAvailable: true,
      venvAvailable: true,
      savedUploads: [],
      ...overrides,
   };
}

const file = (path: string, bytes = 100): WorkspaceFile => ({
   path,
   bytes,
   modifiedAt: 0,
});

describe("renderWorkshopPrompt", () => {
   test("workspace listing marks each file with its delivery status", () => {
      const prompt = renderWorkshopPrompt(
         ctx({
            files: [
               file("enviado.docx"),
               file("pendiente.pdf"),
               file("uploads/apuntes.pdf"),
               file("extracto.txt"),
            ],
            deliveredPaths: new Set(["enviado.docx", "uploads/apuntes.pdf"]),
         }),
      );
      expect(prompt).toContain(
         "enviado.docx (100 B) — ✅ ya entregado al usuario",
      );
      expect(prompt).toContain("pendiente.pdf (100 B) — ⚠️ NO entregado");
      expect(prompt).toContain(
         "uploads/apuntes.pdf (100 B) — 📥 subido por el usuario",
      );
      // Intermediates stay plain — no false alarms.
      expect(prompt).toContain("- extracto.txt (100 B)\n");
   });

   test("assistant tone: warm but never mirrors insults or vulgar slang", () => {
      const prompt = renderWorkshopPrompt(ctx());
      expect(prompt).toContain("# Tono");
      expect(prompt).toContain("Nunca imites groserías");
      expect(prompt).toContain("respetuoso");
   });

   test("anti-hallucination rules: verify before claiming a delivery, resend on complaint", () => {
      const prompt = renderWorkshopPrompt(ctx());
      expect(prompt).toContain("nunca afirmes una entrega que no ocurrió");
      expect(prompt).toContain("workshop_list_files");
      expect(prompt).toContain("no le llegó");
   });

   test("no deliveredPaths → every generated file shows as not delivered", () => {
      const prompt = renderWorkshopPrompt(ctx({ files: [file("nuevo.docx")] }));
      expect(prompt).toContain("nuevo.docx (100 B) — ⚠️ NO entregado");
   });
});
