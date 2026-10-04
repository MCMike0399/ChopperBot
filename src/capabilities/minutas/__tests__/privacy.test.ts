import { test, expect, vi } from "vitest";
const askMock = vi.hoisted(() => vi.fn());
vi.mock("../../../llm/client.js", () => ({ ask: askMock }));
import {
   publicMinutes,
   renderMinutesPost,
   renderMinutesSummaryPost,
   generateMinutes,
} from "../minutes.js";

const meta = {
   title: "Caso de Persona ficticia A",
   channelName: "Sala de prueba",
   dateLabel: "4 octubre",
   durationLabel: "1h",
   participants: ["Persona ficticia A", "Persona ficticia B"],
};
test("conduct identities cannot reach the public summary, header or attachment", () => {
   const draft =
      "[00:00] Persona ficticia A: Revisemos la denuncia contra Persona ficticia B.";
   const body =
      "## Resumen\nPersona ficticia B acosó a Persona ficticia A.\n## Compromisos\nPersona ficticia B se disculpará.";
   const result = publicMinutes(draft, body, meta);
   expect(result.redacted).toBe(true);
   for (const output of [
      renderMinutesPost(result.body, result.meta),
      renderMinutesSummaryPost(result.body, result.meta, "minuta-prueba.md"),
   ]) {
      expect(output).not.toContain("Persona ficticia A");
      expect(output).not.toContain("Persona ficticia B");
      expect(output).toContain("archivo interno");
   }
});
test("ordinary study minutes remain useful and an assembly-sized draft fits one pass", () => {
   const body =
      "## Resumen\nSe estudió un texto.\n## Compromisos\nPersona ficticia A buscará referencias.";
   expect(publicMinutes("Debate sobre un texto", body, meta).body).toBe(body);
});

test("an assembly-sized synthetic transcript uses one full-context pass", async () => {
   askMock.mockReset();
   askMock.mockResolvedValue("## Resumen\nSe estudió un texto.");
   const draft =
      "[00:00] Persona ficticia: Comentario sobre un texto.\n".repeat(6000);
   await generateMinutes(draft, { ...meta, title: "Encuentro de lectura" });
   expect(askMock).toHaveBeenCalledTimes(1);
   expect(askMock.mock.calls[0][0].messages[0].content).toContain(draft);
   expect(askMock.mock.calls[0][0].effort).toBe("low");
});
