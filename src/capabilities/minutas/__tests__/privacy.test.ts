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
   const result = publicMinutes(body, meta);
   expect(result.body).toBe(body);
   expect(result.redacted).toBe(false);
   expect(result.meta.participants).toEqual(meta.participants);
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

test("a reporter's political/public-news paragraph remains public", () => {
   const body =
      "## Temas tratados\n- Persona ficticia A relató la represión policial y denunció detenciones en una marcha.\n- Persona ficticia B relató un feminicidio público en una universidad, con señalamientos previos de acoso y fallas del protocolo institucional.";
   expect(publicMinutes(body, meta).body).toBe(body);
   expect(publicMinutes(body, meta).redacted).toBe(false);
});

test.each([
   "No se trataron asuntos de convivencia sobre personas concretas.",
   "Sin asuntos de convivencia.",
   "No hubo incidentes.",
])(
   "an empty internal section does not hide the participant roster: %s",
   (placeholder) => {
      const body = "## Resumen\nSe revisó la agenda.";
      const result = publicMinutes(
         `${body}\n\n## Convivencia (interna)\n${placeholder}`,
         meta,
      );
      expect(result.body).toBe(body);
      expect(result.internal).toBeNull();
      expect(result.redacted).toBe(false);
      expect(result.meta.participants).toEqual(meta.participants);
   },
);

test.each([
   "Persona ficticia A denunció a Persona ficticia B por acoso.",
   "Se recibió una denuncia contra Persona ficticia A.",
   "Se acordó banear a Persona ficticia B.",
   "Persona ficticia A relató un insulto de Persona ficticia B.",
   "Persona ficticia A explicó que Persona ficticia B acosó a alguien.",
   "Persona ficticia A sufrió acoso.",
   "Persona ficticia A explicó que sufrió acoso.",
])("misplaced named member incidents stay private: %s", (line) => {
   const result = publicMinutes(`## Resumen\n${line}`, meta);
   expect(result.redacted).toBe(true);
   expect(result.body).not.toContain("Persona ficticia");
   expect(result.internal).toContain(line);
});

test("decorated names and nickname aliases remain protected", () => {
   const result = publicMinutes(
      "## Resumen\nLuna acosó a Sol.\nRayo insultó a Luna.",
      { ...meta, participants: ["Luna ✩", "Sol (Rayo)"] },
   );
   expect(result.redacted).toBe(true);
   expect(result.body).not.toContain("Luna");
   expect(result.body).not.toContain("Rayo");
});

test("an internal case title using a nickname does not publish", () => {
   const result = publicMinutes(
      "## Resumen\nSe revisó la agenda.\n## Convivencia (interna)\n- Rayo acosó a Luna.",
      { ...meta, title: "Caso Rayo", participants: ["Luna ✩", "Sol (Rayo)"] },
   );
   expect(result.meta.title).toBe("Reunión");
});
