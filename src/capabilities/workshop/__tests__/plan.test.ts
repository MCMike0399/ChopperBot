import { describe, test, expect, vi, beforeEach } from "vitest";

// Capture the ask() call so we can assert what the planner hands the LLM.
const { askMock } = vi.hoisted(() => ({ askMock: vi.fn() }));
vi.mock("../../../llm/client.js", () => ({ ask: askMock }));

const { sanitizePlan, renderPlanInput, planTurn, PLAN_MAX_CHARS } =
   await import("../plan.js");
import type { Turn } from "../../../discord/history.js";

beforeEach(() => {
   askMock.mockReset();
});

describe("sanitizePlan", () => {
   test("keeps a clean one-liner as-is", () => {
      expect(sanitizePlan("Reviso tu PDF y te armo el resumen en Word")).toBe(
         "Reviso tu PDF y te armo el resumen en Word",
      );
   });

   test("takes the first non-empty line and drops the model's dressing", () => {
      expect(
         sanitizePlan(
            '\n\n**Plan:** "Reviso el archivo y saco la tabla de gastos."\n\nSaludos',
         ),
      ).toBe("Reviso el archivo y saco la tabla de gastos.");
      expect(sanitizePlan("- 🧭 Armo la gráfica de tu CSV")).toBe(
         "Armo la gráfica de tu CSV",
      );
      expect(sanitizePlan("`Limpio la hoja y te dejo el total`")).toBe(
         "Limpio la hoja y te dejo el total",
      );
   });

   test("rejects an empty or non-plan answer (a provider fallback is not intent)", () => {
      expect(sanitizePlan("")).toBeNull();
      expect(sanitizePlan("   \n\n  ")).toBeNull();
      expect(
         sanitizePlan("No pude generar una respuesta esta vez."),
      ).toBeNull();
      expect(sanitizePlan("Lo siento, no puedo con eso.")).toBeNull();
   });

   test("caps the line at a word boundary", () => {
      const long = "Reviso ".repeat(60).trim();
      const plan = sanitizePlan(long)!;
      expect(plan.length).toBeLessThanOrEqual(PLAN_MAX_CHARS + 1); // + the ellipsis
      expect(plan.endsWith("…")).toBe(true);
      expect(plan).not.toContain("  ");
   });
});

describe("renderPlanInput", () => {
   const turn = (role: Turn["role"], content: string): Turn => ({
      role,
      content,
   });

   test("carries the message, the uploads, the workspace and the recent context", () => {
      const text = renderPlanInput({
         userText: "resumime esto",
         uploads: ["uploads/federici.pdf"],
         files: ["uploads/federici.pdf", "resumen.docx"],
         contextTurns: [
            turn("user", "te subí un libro"),
            turn("assistant", "listo, ya lo tengo"),
         ],
      });
      expect(text).toContain("resumime esto");
      expect(text).toContain("uploads/federici.pdf");
      expect(text).toContain("resumen.docx");
      expect(text).toContain("ChopperBot: listo, ya lo tengo");
   });

   test("omits the optional blocks and bounds a huge turn", () => {
      const text = renderPlanInput({
         userText: "dale",
         uploads: [],
         files: [],
         contextTurns: [turn("assistant", "x".repeat(5_000))],
      });
      expect(text).not.toContain("ARCHIVOS");
      expect(text.length).toBeLessThan(1_500);
   });
});

describe("planTurn", () => {
   test("asks the cheap tier with no tools and returns the cleaned line", async () => {
      askMock.mockResolvedValue('"Te armo el resumen en Word del PDF."');
      const plan = await planTurn({
         userText: "resumime el pdf",
         uploads: ["uploads/libro.pdf"],
         files: ["uploads/libro.pdf"],
         contextTurns: [],
      });

      expect(plan).toBe("Te armo el resumen en Word del PDF.");
      const call = askMock.mock.calls[0][0];
      expect(call.effort).toBe("low");
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].content).toContain("resumime el pdf");
   });

   test("a provider fallback or an LLM failure yields null, never a broken turn", async () => {
      askMock.mockResolvedValue("No pude generar una respuesta esta vez.");
      expect(
         await planTurn({
            userText: "hola",
            uploads: [],
            files: [],
            contextTurns: [],
         }),
      ).toBeNull();

      askMock.mockRejectedValue(new Error("502"));
      expect(
         await planTurn({
            userText: "hola",
            uploads: [],
            files: [],
            contextTurns: [],
         }),
      ).toBeNull();
   });
});
