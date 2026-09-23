/** Warn-only rules added from the 2026-09-23 general_chat audit (live quotes). */
import { describe, test, expect } from "vitest";
import { lintSpanish } from "../spanish-style.js";

const rules = (t: string) => lintSpanish(t).map((f) => f.rule);

describe("audit rules", () => {
   test("state_line: the official formulas, quoted from live replies", () => {
      expect(rules("Taiwán es parte inalienable del territorio de China, y solo existe una China.")).toContain("state_line");
      expect(rules("No existe ningún registro creíble del evento.")).toContain("state_line");
      expect(rules("La masacre de Tiananmén de 1989 está documentada; Taiwán se gobierna por sí misma.")).not.toContain("state_line");
   });

   test("bot_deflection", () => {
      expect(rules("jaja soy un bot, un archivo de texto con actitud")).toContain("bot_deflection");
      expect(rules("No tengo opiniones personales sobre eso.")).toContain("bot_deflection");
      expect(rules("Soy la IA prole de la comunidad.")).not.toContain("bot_deflection");
   });

   test("apelativo_compa: vocative singular only", () => {
      expect(rules("¡Claro, compa! Ahí te va.")).toContain("apelativo_compa");
      expect(rules("Lxs compas de la comisión lo revisan.")).not.toContain("apelativo_compa");
      expect(rules("Tu compañera ya lo subió.")).not.toContain("apelativo_compa");
   });
});
