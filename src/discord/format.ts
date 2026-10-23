/** The Discord text adapter: one contract shared by prompts and delivery. */
export const DISCORD_REPLY_FORMAT = {
   instructions: `# Formato de la respuesta en Discord
- Escribe párrafos breves, listas, negritas y bloques de código con lenguaje.
- Discord no muestra tablas Markdown ni fórmulas LaTeX: para comparar, usa listas con etiquetas; para matemáticas, texto legible (λ, Σ, x²) o código. No dibujes tablas con espacios: se rompen en móviles.
- Si necesitas una tabla editable, una ecuación compuesta o un diseño para entregar, crea un archivo con las herramientas disponibles. El chat lleva la explicación breve; el archivo conserva el formato completo.`,
   render: renderDiscordText,
};

/** Split cells without mistaking escaped pipes or pipes in inline code for columns. */
function cells(line: string): string[] | null {
   const text = line.trim();
   let codeTicks = 0;
   let cell = "";
   const result: string[] = [];
   let pipes = 0;
   for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
         cell += ch + text[++i];
      } else if (ch === "`") {
         let n = 1;
         while (text[i + n] === "`") n++;
         if (codeTicks === 0) codeTicks = n;
         else if (codeTicks === n) codeTicks = 0;
         cell += "`".repeat(n);
         i += n - 1;
      } else if (ch === "|" && codeTicks === 0) {
         result.push(cell.trim());
         cell = "";
         pipes++;
      } else cell += ch;
   }
   if (pipes === 0) return null;
   result.push(cell.trim());
   if (text.startsWith("|")) result.shift();
   if (text.endsWith("|") && result.at(-1) === "") result.pop();
   return result;
}

function label(text: string): string {
   if (!text) return "";
   // Keep existing inline formatting; avoid nesting ** around an already bold heading.
   const plain = text.replace(/^\*\*(.*)\*\*$/, "$1");
   return `**${plain}:** `;
}

/** Only valid tables outside fenced code are adapted; other text stays verbatim. */
function renderDiscordText(text: string): string {
   const lines = text.split(/\r?\n/);
   const out: string[] = [];
   let fence: { char: string; length: number } | null = null;
   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (mark) {
         if (!fence) fence = { char: mark[1][0], length: mark[1].length };
         else if (
            mark[1][0] === fence.char &&
            mark[1].length >= fence.length &&
            !mark[2].trim()
         )
            fence = null;
         out.push(line);
         continue;
      }
      const header = fence ? null : cells(line);
      const divider =
         header && i + 1 < lines.length ? cells(lines[i + 1]) : null;
      if (
         !header ||
         !divider ||
         header.length < 2 ||
         header.length !== divider.length ||
         !divider.every((c) => /^:?-{3,}:?$/.test(c))
      ) {
         out.push(line);
         continue;
      }
      const rows: string[][] = [];
      let end = i + 2;
      while (end < lines.length) {
         const row = cells(lines[end]);
         if (!row || row.length !== header.length) break;
         rows.push(row);
         end++;
      }
      if (!rows.length) {
         out.push(line);
         continue;
      }
      if (out.length && out.at(-1) !== "") out.push("");
      out.push(
         rows
            .map((row) =>
               row
                  .map(
                     (value, col) =>
                        `${col === 0 ? "- " : "  "}${label(header[col])}${value.replace(/<br\s*\/?\s*>/gi, " / ")}`,
                  )
                  .join("\n"),
            )
            .join("\n\n"),
      );
      out.push("");
      i = end - 1;
   }
   return out.join("\n");
}
