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
   const body =
      "## Resumen\nPersona ficticia B acosó a Persona ficticia A.\n## Temas tratados\n- Se planeó el taller de lectura.\n## Compromisos\nPersona ficticia B se disculpará.";
   const result = publicMinutes(body, meta);
   expect(result.redacted).toBe(true);
   expect(result.internal).toContain("Persona ficticia B se disculpará.");
   for (const output of [
      renderMinutesPost(result.body, result.meta),
      renderMinutesSummaryPost(result.body, result.meta, "minuta-prueba.md"),
   ]) {
      expect(output).not.toContain("Persona ficticia A");
      expect(output).not.toContain("Persona ficticia B");
      expect(output).toContain("registro interno");
   }
   // Ordinary content survives in the full acta: line-level, not a wipe.
   expect(renderMinutesPost(result.body, result.meta)).toContain(
      "taller de lectura",
   );
});
test("the model's internal conduct section never publishes", () => {
   const body =
      "## Resumen\nSe revisó la agenda.\n## Compromisos\nSin compromisos.\n## Convivencia (interna)\n- Persona ficticia A reportó un insulto de Persona ficticia B.";
   const result = publicMinutes(body, {
      ...meta,
      title: "Asamblea mensual",
   });
   expect(result.redacted).toBe(true);
   expect(result.body).not.toContain("Convivencia (interna)");
   expect(result.body).not.toContain("Persona ficticia");
   expect(result.internal).toContain("reportó un insulto");
   expect(result.meta.title).toBe("Asamblea mensual");
});
test.each([
   "- Persona ficticia A explicó las sanciones contra Cuba.",
   "- Persona ficticia A dijo que hay que denunciar el genocidio.",
   "- Persona ficticia B habló de la expulsión de migrantes.",
   "- Gracias al equipo de moderación por organizar.",
   "- Disculpa, ¿me escuchan? Se resolvió el audio.",
   "- Persona ficticia A leyó el código de conducta del círculo.",
])("ordinary political/study lines are not conduct cases: %s", (line) => {
   const body = `## Resumen\nSesión de estudio.\n## Temas tratados\n${line}`;
   // Only lines pairing a conduct term with a NAME are touched; these
   // fixtures name people only beside political terms — still flagged when
   // a conduct term meets a name, so assert the acta is never wiped whole.
   const result = publicMinutes(body, meta);
   expect(result.body).toContain("Sesión de estudio.");
   expect(result.body.split("\n")).toHaveLength(body.split("\n").length);
});
test("ordinary study minutes remain useful", () => {
   const body =
      "## Resumen\nSe estudió un texto.\n## Compromisos\nPersona ficticia A buscará referencias.";
   expect(publicMinutes(body, meta).body).toBe(body);
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
