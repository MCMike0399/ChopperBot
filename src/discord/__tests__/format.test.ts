import { describe, test, expect } from "vitest";
import { DISCORD_REPLY_FORMAT } from "../format.js";
import { chunkBotReply, stripContinuationFooter } from "../chunk.js";

const table = "| Tipo | Ejemplo |\n|:---|---:|\n| Indicador | CAC |";
describe("Discord reply format", () => {
   test("adapts tables with and without outside pipes, retaining every cell", () => {
      expect(DISCORD_REPLY_FORMAT.render(table)).toContain(
         "- **Tipo:** Indicador\n  **Ejemplo:** CAC",
      );
      expect(
         DISCORD_REPLY_FORMAT.render("Tipo | Ejemplo\n--- | ---\nMeta | 150"),
      ).toContain("**Ejemplo:** 150");
   });
   test("keeps blank headings, empty cells, inline code pipes and escaped pipes", () => {
      const text =
         "| | **Indicador** | KPI |\n|---|---|---|\n| Qué es | `a|b` | valor \\| referencia |\n| Meta | | Sí |";
      const out = DISCORD_REPLY_FORMAT.render(text);
      expect(out).toContain("- Qué es");
      expect(out).toContain("**Indicador:** `a|b`");
      expect(out).toContain("valor \\| referencia");
      expect(out).toContain("**KPI:** Sí");
      expect(out).not.toContain("****");
   });
   test.each(["```markdown", "~~~~md"])(
      "does not transform tables in %s code fences",
      (opening) => {
         const close = opening.startsWith("`") ? "```" : "~~~~";
         const text = `${opening}\n${table}\n${close}\n\n${table}`;
         const out = DISCORD_REPLY_FORMAT.render(text);
         expect(out).toContain(`${opening}\n${table}\n${close}`);
         expect(out).toContain("**Tipo:** Indicador");
      },
   );
   test("leaves ordinary pipes and malformed tables alone", () => {
      for (const t of [
         "x | y",
         "a | b\n-- | --\nx | y",
         "|A|B|\n|---|---|",
         "`a|b`\nc|d",
      ])
         expect(DISCORD_REPLY_FORMAT.render(t)).toBe(t);
   });
   test("retains surrounding prose and all table values across Discord chunks", () => {
      const rows = Array.from(
         { length: 18 },
         (_, i) => `| caso ${i} | valor ${i} ${"texto ".repeat(12)} |`,
      );
      const text = `Antes\n\n| Caso | Detalle |\n|---|---|\n${rows.join("\n")}\n\nDespués`;
      const chunks = chunkBotReply(text);
      const joined = chunks.map(stripContinuationFooter).join("\n");
      expect(joined).toContain("Antes");
      expect(joined).toContain("Después");
      for (let i = 0; i < 18; i++) expect(joined).toContain(`valor ${i}`);
      for (const chunk of chunks)
         expect(chunk.length).toBeLessThanOrEqual(2000);
   });
   test("keeps code fences balanced around a long code line", () => {
      const chunks = chunkBotReply("```python\n" + "x".repeat(5000) + "\n```");
      for (const c of chunks) {
         expect(c.length).toBeLessThanOrEqual(2000);
         expect(c.match(/```/g)).toHaveLength(2);
      }
   });
   test("closes the code fence before a truncation notice", () => {
      const chunks = chunkBotReply("```python\n" + "x".repeat(20000) + "\n```");
      expect(chunks).toHaveLength(5);
      for (const c of chunks) expect(c.match(/```/g)).toHaveLength(2);
      expect(chunks.at(-1)).toMatch(/```\n\n_\(respuesta recortada/);
   });
});
