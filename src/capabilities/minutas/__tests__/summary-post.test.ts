/**
 * The #minutas post is ONE message: header + Resumen + pointer to the attached
 * .md (user request 2026-09-23 — the full acta chunked into the channel was
 * flooding it). The full document is the attachment.
 */
import { describe, test, expect } from "vitest";
import { renderMinutesSummaryPost, type MinutesMeta } from "../minutes.js";

const meta = {
   title: "asamblea general 22 septiembre",
   channelName: "🎙️ Sala de Eventos 🎙️",
   dateLabel: "martes 22 de septiembre de 2026",
   durationLabel: "2 h 42 min",
   participants: ["Luna", "Yeti", "Darko"],
} as MinutesMeta;

const body = [
   "## Resumen",
   "Se revisó el avance de las comisiones. Se votó el nuevo horario del club de cine.",
   "",
   "## Temas tratados",
   "- Comisiones",
   "- Club de cine",
   "",
   "## Acuerdos y decisiones",
   "- El club de cine pasa a los jueves.",
   "- Se abre convocatoria para Agitprop.",
   "",
   "## Compromisos",
   "- Luna: publicar la convocatoria antes del viernes.",
].join("\n");

describe("renderMinutesSummaryPost", () => {
   test("keeps only the summary and counts what is in the file", () => {
      const post = renderMinutesSummaryPost(body, meta, "minuta-x.md");
      expect(post).toContain("# 📜 Minuta — asamblea general 22 septiembre");
      expect(post).toContain("Se votó el nuevo horario");
      expect(post).not.toContain("## Temas tratados");
      expect(post).not.toContain("publicar la convocatoria");
      expect(post).toContain("2 acuerdos y 1 compromiso");
      expect(post).toContain("minuta-x.md");
   });

   test("placeholder bullets are not counted", () => {
      const b = body.replace(
         "- Luna: publicar la convocatoria antes del viernes.",
         "- Ninguno registrado.",
      );
      expect(renderMinutesSummaryPost(b, meta, "m.md")).toContain(
         "0 compromisos",
      );
   });

   test("always fits one Discord message, cut on a sentence", () => {
      const long = `## Resumen\n${"Se discutió largamente la organización del tianguis. ".repeat(80)}\n## Temas tratados\n- x`;
      const post = renderMinutesSummaryPost(long, meta, "m.md");
      expect(post.length).toBeLessThanOrEqual(2000);
      expect(post).toMatch(/tianguis\. …/);
   });

   test("no Resumen heading → first paragraph, never empty", () => {
      const post = renderMinutesSummaryPost(
         "Se habló de todo un poco.\n\n## Acuerdos\n- a",
         meta,
         "m.md",
      );
      expect(post).toContain("Se habló de todo un poco.");
   });
});
