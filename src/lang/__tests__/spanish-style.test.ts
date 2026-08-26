/**
 * The Spanish voice regression net. Two halves:
 *
 *  1. The real corpus (`corpus.ts`) — every Kimi-era reply the community was
 *     happy with must stay lint-clean, and every DeepSeek reply the user
 *     flagged on 2026-08-13 must stay caught, by the rule that explains it.
 *  2. Rule-by-rule units, including the near-misses that must NOT fire: the
 *     plural "-xs" inclusive forms the community actually uses, the concrete
 *     offer the calendar prompt asks for, "ustedes", code blocks and links.
 *
 * A false positive here is worse than a miss: this linter warns on every live
 * reply, so it has to stay quiet on correct Spanish.
 */
import { describe, test, expect } from "vitest";

import {
   lintSpanish,
   describeFindings,
   type SpanishStyleRuleId,
} from "../spanish-style.js";
import { KIMI_REPLIES, DEEPSEEK_REGRESSIONS } from "./corpus.js";

function rules(
   text: string,
   toolNames?: readonly string[],
): SpanishStyleRuleId[] {
   return lintSpanish(text, toolNames ? { toolNames } : {}).map((f) => f.rule);
}

describe("corpus — the voice we had", () => {
   for (const reply of KIMI_REPLIES) {
      test(`kimi reply ${reply.id} (${reply.at}) is clean`, () => {
         const findings = lintSpanish(reply.text);
         expect(describeFindings(findings)).toBe("");
      });
   }
});

describe("corpus — the regressions reported on the DeepSeek switch", () => {
   test('"se le habla … le pregunto UNA cosa … para elx" trips register, invented pronoun and scaffolding', () => {
      const reply = DEEPSEEK_REGRESSIONS.find(
         (r) => r.id === "1537630365106315406",
      );
      expect(reply).toBeDefined();
      const findings = lintSpanish(reply!.text);
      const byRule = new Map(findings.map((f) => [f.rule, f.match]));

      expect(byRule.get("usted")).toBe("se le habla");
      expect(byRule.get("inclusive_malformed")).toBe("elx");
      expect(byRule.get("scaffolding")).toBe("UNA");
   });

   test('"Propónlo en la próxima asamblea" trips the enclitic-accent rule', () => {
      const reply = DEEPSEEK_REGRESSIONS.find(
         (r) => r.id === "1537630259191480351",
      );
      expect(reply).toBeDefined();
      const findings = lintSpanish(reply!.text);

      expect(findings.map((f) => f.rule)).toContain("enclitic_accent");
      expect(findings.find((f) => f.rule === "enclitic_accent")?.match).toBe(
         "Propónlo",
      );
   });

   test('the community plural "ellxs" in the same reply is NOT flagged', () => {
      const reply = DEEPSEEK_REGRESSIONS.find(
         (r) => r.id === "1537630259191480351",
      )!;
      const invented = lintSpanish(reply.text).filter(
         (f) => f.rule === "inclusive_malformed",
      );
      expect(invented).toEqual([]);
   });

   test("every flagged reply produces at least one finding", () => {
      for (const reply of DEEPSEEK_REGRESSIONS) {
         expect(
            lintSpanish(reply.text).length,
            `reply ${reply.id}`,
         ).toBeGreaterThan(0);
      }
   });
});

describe("usted register", () => {
   test.each([
      ["¿Desea que lo cree?", "usted"],
      ["Si necesita algo, avíseme.", "usted"],
      ["Usted puede crear el evento aquí.", "usted"],
      ["Tenga en cuenta que el calendario se publica solo.", "usted"],
      ["No dude en escribir por aquí.", "usted"],
      ["Se le informa cuando quede publicado.", "usted"],
   ])("%j is flagged", (text, rule) => {
      expect(rules(text)).toContain(rule);
   });

   test.each([
      "Ya quedó, ¿quieres que lo suba también a eventos?",
      "Ustedes pueden crear el evento desde este canal.",
      "Le creé el evento de Discord y le puse la sala.",
      "Dile que le interesa sumarse a la comisión.",
   ])("%j stays clean", (text) => {
      expect(lintSpanish(text)).toEqual([]);
   });

   test("mixing tú and usted in one reply is called out on its own", () => {
      const found = rules("Ya te lo creé. Si necesita otra cosa, avíseme.");
      expect(found).toContain("usted");
      expect(found).toContain("mixed_register");
   });
});

describe("inclusive language", () => {
   // The community's own vocabulary, evidenced by the server itself: the welcome
   // channel is #bienvenidx and the guild profile says "amix".
   test.each([
      "lxs mods",
      "todxs lxs compañerxs",
      "ellxs coordinan",
      "moderadorxs",
      "¡Qué onda, bienvenidx!",
      "va, amix",
      "una compañerx preguntó",
   ])("the community form %j is correct", (text) => {
      expect(lintSpanish(text)).toEqual([]);
   });

   test.each([
      "un mensaje para elx",
      "unx de lxs mods",
      "estx es su ticket",
      "se lo paso a ellx",
   ])("the invented pronoun in %j is flagged", (text) => {
      expect(rules(text)).toContain("inclusive_malformed");
   });

   test("real words and names ending in x are never inclusive forms", () => {
      expect(
         lintSpanish("Marx, el códex y el fax siguen en el índex de Félix."),
      ).toEqual([]);
   });
});

describe("scaffolding leaks", () => {
   test("a tool id in prose is a leak", () => {
      expect(
         rules("Voy a llamar a calendar_search_events para ubicarlo."),
      ).toContain("scaffolding");
   });

   test("tool names passed by the turn are matched exactly", () => {
      expect(
         rules("Uso ig_pausar_cuenta y listo.", ["ig_pausar_cuenta"]),
      ).toContain("scaffolding");
   });

   test("a prompt parameter name is a leak", () => {
      expect(rules("Lo guardé con recurrence_freq semanal.")).toContain(
         "scaffolding",
      );
   });

   test("ALL-CAPS emphasis copied from the prompt is a leak", () => {
      expect(rules("Te pregunto UNA cosa a la vez.")).toContain("scaffolding");
      expect(rules("NUNCA creo un evento nuevo para eso.")).toContain(
         "scaffolding",
      );
   });

   test("talking about being configured is a leak", () => {
      expect(
         rules("Mis instrucciones dicen que pregunte una cosa a la vez."),
      ).toContain("scaffolding");
   });

   test("code blocks, inline code and links are not prose", () => {
      expect(
         lintSpanish(
            "Te dejo el script:\n```python\nstart_at_iso = 1\ndef pon_lo(): pass\n```",
         ),
      ).toEqual([]);
      expect(
         lintSpanish("El campo `recurrence_freq` va en el archivo."),
      ).toEqual([]);
      expect(
         lintSpanish(
            "Quedó aquí: https://discord.com/events/1/2 y en <#1518328211165941912>",
         ),
      ).toEqual([]);
   });

   test("ordinary capitalised words and acronyms are not leaks", () => {
      expect(
         lintSpanish("Ya se publicaron el PDF y el ICS del mes. ¡LISTO!"),
      ).toEqual([]);
   });
});

describe("closers", () => {
   test.each([
      "¿Algo más?",
      "Cualquier cosa, no dudes en preguntar.",
      "Espero que esta información te sea útil.",
      "Estoy aquí para ayudarte con lo que necesites.",
      "Quedo atento a tu respuesta.",
   ])("the service closer %j is flagged", (text) => {
      expect(rules(text)).toContain("service_closer");
   });

   test("a concrete offer is not a service closer", () => {
      expect(
         lintSpanish(
            "¿Quieres que cree también el evento de Discord para que la gente se apunte?",
         ),
      ).toEqual([]);
   });
});

describe("orthography", () => {
   test.each([
      "Propónlo en la asamblea.",
      "Pónlo en la sala de eventos.",
      "Házlo cuando puedas.",
   ])("%j is flagged", (text) => {
      expect(rules(text)).toContain("enclitic_accent");
   });

   test.each([
      "Proponlo en la asamblea.",
      "Ponlo en la sala de eventos.",
      "Hazlo cuando puedas.",
      "Propónmelo mañana.",
   ])("%j is correct", (text) => {
      expect(lintSpanish(text)).toEqual([]);
   });
});

describe("spanglish", () => {
   test("the live #general reply trips the hyphenated English suffix", () => {
      const reply = DEEPSEEK_REGRESSIONS.find(
         (r) => r.id === "1541988518379921459",
      );
      expect(reply).toBeDefined();
      const findings = lintSpanish(reply!.text);
      expect(findings.map((f) => f.rule)).toContain("spanglish");
      expect(findings.find((f) => f.rule === "spanglish")?.match).toBe(
         "emoción-ed",
      );
   });

   test.each(["Estoy emoción-ed, jaja.", "Salí emocioned."])(
      "%j is flagged",
      (text) => {
         expect(rules(text)).toContain("spanglish");
      },
   );

   test.each([
      "Estoy emocionado, jaja.",
      "Suena que va a estar buenísimo.",
      "El e-mail llegó.",
      "Haz copy-paste del enlace.",
   ])("%j stays clean", (text) => {
      expect(lintSpanish(text)).toEqual([]);
   });
});

describe("describeFindings", () => {
   test("renders rule and snippet for the journal", () => {
      expect(describeFindings(lintSpanish("¿Desea que lo cree?"))).toBe(
         'usted("¿Desea")',
      );
   });

   test("is empty for clean text", () => {
      expect(
         describeFindings(
            lintSpanish("Listo, ya quedó el evento del jueves a las 8."),
         ),
      ).toBe("");
   });
});
