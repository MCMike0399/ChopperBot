import { ask } from "../../llm/client.js";
import { composeToolSources } from "../../tools/source.js";
import { SPANISH_VOICE_RULES } from "../../lang/voice.js";

/** Context the final minutes carry in their header + the prompts reason about. */
export interface MinutesMeta {
   title: string;
   channelName: string;
   /** Human date, e.g. "sábado 16 de agosto de 2026". */
   dateLabel: string;
   /** Human duration, e.g. "47 min". */
   durationLabel: string;
   participants: string[];
   /** Session start (for the date → weekday table). */
   startedAtMs?: number;
   /** "Nombre (también aparece como X)" for members who renamed mid-session. */
   aliases?: string[];
}

/** Above this the draft is summarized in blocks first (map), then merged. */
export const SINGLE_PASS_MAX_CHARS = 48_000;
/** Block size for the map pass; splits fall on line boundaries. */
export const BLOCK_MAX_CHARS = 48_000;

/**
 * The minutes writer is a community-facing surface: the output is posted
 * verbatim to #minutas-de-asambleas, so it carries the same voice contract as
 * every other member-visible prompt.
 */
export function buildMinutesSystemPrompt(): string {
   return `Eres ChopperBot redactando la MINUTA de una reunión de voz de la comunidad Revolución Z. Recibes la transcripción automática (por hablante, con marcas de tiempo). Las líneas con 💬 son comentarios del CHAT de texto del canal: son CONTEXTO para entender o aclarar lo hablado (un enlace, un nombre, una corrección). Nunca son intervenciones habladas.

Reglas duras:
- Atribuye lo dicho a las personas EXACTAMENTE con el nombre que aparece en la transcripción. Nunca inventes quién dijo algo.
- **Nombres: la lista de participantes manda.** El texto hablado es automático y oye mal los nombres («Repseta» por «RevZ»; un apodo como «tlacuache» que se oye «Tlacuachi»). Cuando un nombre dicho en voz alta se refiere claramente a alguien de la lista de participantes, escríbelo con la ortografía EXACTA de la lista (sin los adornos decorativos: «tlacuache ✩‧₊˚» → «tlacuache»). Una persona = un solo nombre en toda el acta; si alguien aparece con un alias, usa el nombre principal.
- No inventes contenido: si algo no está en la transcripción hablada, no existe. La transcripción es automática y puede tener errores; si un tramo es ambiguo, resume lo seguro.
- **Nada de conocimiento externo.** No completes nombres de autorxs, títulos, fechas ni datos que no se dijeron («Calibán y la bruja» no se vuelve «de Silvia Federici» si nadie lo dijo).
- **Fechas:** usa la tabla de fechas del encabezado para poner día de la semana y mes. Nunca agregues un mes que no se dijo si la tabla no lo resuelve; «el sábado» o «el 29» se quedan así si no hay forma segura de saber cuál.
- **Privacidad:** esto se publica al servidor. Si alguien compartió algo personal (salud mental, terapia, diagnósticos, historia de violencia) o se habló del detalle de un caso de acoso/denuncia, NO lo registres con nombre ni con detalles identificables: resume en neutro («se compartieron experiencias personales sobre salud mental»; «se revisó un caso de convivencia y se acordó X») y registra solo lo acordado.
- El chat NO se publica: no copies comentarios, no armes una sección de chat, no cites «lo que escribieron». Si un comentario aclara un tema hablado, incorpóralo en Resumen/Temas/Acuerdos con las palabras de la minuta, no como cita del chat.
- Bromas, memes, hipérboles y comentarios en chiste (p. ej. «el 2do aniversario tomamos palacio nacional») NO son acuerdos, compromisos ni temas. El tono de acta es sobrio: lo jocoso del chat o de la sala no entra al registro formal.
- Estructura EXACTA del acta (markdown de Discord), sin más secciones:
  ## Resumen
  (3–6 líneas del propósito y el tono de la sesión)
  ## Temas tratados
  (una viñeta por tema: qué se dijo y quién lo planteó/defendió, con nombres)
  ## Acuerdos y decisiones
  (solo lo que quedó acordado o decidido de verdad; si no hubo, escribe "Sin acuerdos formales.")
  ## Compromisos
  (quién se comprometió a qué; si no hubo, "Sin compromisos.")
- No uses @menciones con <@id>: escribe los nombres en texto plano.
- Tono de acta: claro, sobrio y fiel. Nada de relleno corporativo.

${SPANISH_VOICE_RULES}`;
}

export function buildMinutesUserPrompt(
   draft: string,
   meta: MinutesMeta,
): string {
   return `${renderMetaBlock(meta)}

Esta es la transcripción completa (borrador), con marcas de tiempo relativas al inicio. Las líneas 💬 son chat de texto: úsalas como contexto (enlaces, nombres, correcciones) y no las copies al acta.

${draft}

Redacta la minuta.`;
}

export function buildBlockExtractionPrompt(
   block: string,
   index: number,
   total: number,
): string {
   return `Esta es la parte ${index} de ${total} de la transcripción de una reunión:

${block}

Extrae, en viñetas breves y en español: los temas discutidos, las posturas de cada persona (con su nombre), cualquier acuerdo/decisión y cualquier compromiso que aparezca EN ESTA PARTE. Las líneas 💬 son contexto del chat: no las extraigas como temas, acuerdos ni compromisos; solo úsalas para aclarar lo hablado. Bromas, memes e hipérboles no son acuerdos. No redactes todavía el acta; solo notas fieles a la transcripción.`;
}

export function buildFinalFromNotesPrompt(
   notes: string,
   meta: MinutesMeta,
): string {
   return `${renderMetaBlock(meta)}

Estas son las notas de extracción de toda la reunión, parte por parte:

${notes}

Con esas notas, redacta la minuta completa con la estructura indicada. Las notas vienen por partes, pero el acta es UNA reunión: **fusiona** lo que se repite entre partes (un mismo tema, acuerdo o compromiso va una sola vez, con todo lo que se dijo de él), y no menciones «partes», «bloques» ni «en este tramo» en el acta.`;
}

function renderMetaBlock(meta: MinutesMeta): string {
   return [
      `Sesión: ${meta.title}`,
      `Canal: ${meta.channelName}`,
      `Fecha: ${meta.dateLabel}`,
      `Duración: ${meta.durationLabel}`,
      `Participantes: ${meta.participants.join(", ") || "desconocidos"}`,
      ...(meta.aliases?.length ? [`Alias vistos en la sesión: ${meta.aliases.join("; ")}`] : []),
      ...(meta.startedAtMs !== undefined ? [renderDateTable(meta.startedAtMs)] : []),
   ].join("\n");
}

/**
 * Weekday ↔ date for the two weeks before and six after the session, so "el
 * sábado 29" resolves by lookup, not by the model's calendar arithmetic.
 * Live miss (0818): chat «sábado 29» (= Sat 29 Aug) became «sábado 29 de
 * septiembre», which is a Tuesday.
 */
export function renderDateTable(startedAtMs: number): string {
   const fmt = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      weekday: "short",
      day: "numeric",
      month: "short",
   });
   const DAY = 86_400_000;
   const rows: string[] = [];
   for (let d = -14; d <= 42; d++) rows.push(fmt.format(new Date(startedAtMs + d * DAY)));
   return `Tabla de fechas (hora CDMX; la sesión es el día ${fmt.format(new Date(startedAtMs))}): ${rows.join(" · ")}`;
}

/**
 * The full post document: header (title/channel/date/duration/participants) +
 * the minutes body. Posted chunked to the channel and stored as minuta.md.
 */
export function renderMinutesPost(
   minutesBody: string,
   meta: MinutesMeta,
): string {
   return [
      `# 📜 Minuta — ${meta.title}`,
      `**Canal:** ${meta.channelName} · **Fecha:** ${meta.dateLabel} · **Duración:** ${meta.durationLabel}`,
      `**Participaron:** ${meta.participants.join(", ") || "—"}`,
      "",
      minutesBody.trim(),
   ].join("\n");
}

/** The body lines under one `## <heading>` section (empty when absent). */
function sectionLines(body: string, heading: RegExp): string[] {
   const out: string[] = [];
   let inside = false;
   for (const line of body.split("\n")) {
      const t = line.trim();
      if (/^##\s+\S/.test(t)) {
         inside = heading.test(t);
         continue;
      }
      if (inside) out.push(line);
   }
   return out;
}

/** Bullet items ("- …", "* …", "1. …") in a section, ignoring "ninguno"-style placeholders. */
function countItems(lines: readonly string[]): number {
   return lines.filter((l) => {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
      return m !== null && !/^(?:_?\(?)?(ningun[oa]s?|no hubo|sin |n\/a)/i.test(m[1]!.trim());
   }).length;
}

/** Room for the summary inside one Discord message (2000 cap, with margin). */
const SUMMARY_POST_MAX_CHARS = 1900;

/**
 * The Discord post for a minuta: header + **only the Resumen** + a pointer to
 * the attached `.md`, in ONE message.
 *
 * Why (user request 2026-09-23): the full acta was being chunked into the
 * channel — a 2½-hour assembly is several consecutive messages of Temas /
 * Acuerdos / Compromisos, which floods #minutas-de-asambleas and buries the
 * previous sessions. The whole document still ships, byte-identical, as the
 * attachment (and in the MinIO archive); the channel gets the part people
 * actually read first. Counting the acuerdos/compromisos in the pointer line
 * tells a reader whether it's worth opening the file.
 *
 * A body with no `## Resumen` (a model that ignored the structure) falls back
 * to its first paragraph, so the post is never empty. An over-long summary is
 * cut on a sentence boundary — the file is complete either way.
 */
export function renderMinutesSummaryPost(
   minutesBody: string,
   meta: MinutesMeta,
   fileName: string,
): string {
   const header = [
      `# 📜 Minuta — ${meta.title}`,
      `**Canal:** ${meta.channelName} · **Fecha:** ${meta.dateLabel} · **Duración:** ${meta.durationLabel}`,
      `**Participaron:** ${meta.participants.join(", ") || "—"}`,
   ].join("\n");
   const acuerdos = countItems(sectionLines(minutesBody, /^##\s+Acuerdos/i));
   const compromisos = countItems(sectionLines(minutesBody, /^##\s+Compromisos/i));
   const counts = [
      `${acuerdos} ${acuerdos === 1 ? "acuerdo" : "acuerdos"}`,
      `${compromisos} ${compromisos === 1 ? "compromiso" : "compromisos"}`,
   ].join(" y ");
   const footer = `📎 La minuta completa (temas tratados, ${counts}) va en el archivo adjunto **${fileName}**.`;

   let summary = sectionLines(minutesBody, /^##\s+Resumen\b/i).join("\n").trim();
   if (!summary) {
      summary =
         minutesBody
            .trim()
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .find((p) => p && !p.startsWith("#")) ?? "";
   }
   const budget = SUMMARY_POST_MAX_CHARS - header.length - footer.length - 20;
   if (summary.length > budget) {
      const cut = summary.slice(0, budget);
      const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
      summary = `${(lastStop > budget * 0.5 ? cut.slice(0, lastStop + 1) : cut).trimEnd()} …`;
   }
   return [header, "", "## Resumen", summary || "_(sin resumen)_", "", footer].join("\n");
}

/**
 * Drop a model-emitted `## Comentarios del chat` section if it still appears.
 * The prompt forbids it; this is the fail-closed guard so a joke dump never
 * lands in #minutas (2026-08-18 assembly: «tomamos palacio nacional»).
 */
export function stripMinutesChatSection(body: string): string {
   const out: string[] = [];
   let skipping = false;
   for (const line of body.split("\n")) {
      if (/^##\s+Comentarios del chat\b/i.test(line.trim())) {
         skipping = true;
         continue;
      }
      if (skipping && /^##\s+\S/.test(line.trim())) skipping = false;
      if (!skipping) out.push(line);
   }
   return out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
}

/** Split on line boundaries, never mid-utterance. */
export function splitTranscriptIntoBlocks(
   text: string,
   maxChars = BLOCK_MAX_CHARS,
): string[] {
   const lines = text.split("\n");
   const blocks: string[] = [];
   let current = "";
   for (const line of lines) {
      if (current.length + line.length + 1 > maxChars && current.length > 0) {
         blocks.push(current);
         current = "";
      }
      current = current ? `${current}\n${line}` : line;
   }
   if (current) blocks.push(current);
   return blocks;
}

/**
 * Draft → minutes via the LLM. One pass when the draft fits; for long
 * assemblies a map pass extracts per-block notes and a final pass merges them
 * into the acta. Every pass is `low` (thinking OFF): no tools are involved and
 * the work is summarization, which thinking only makes slower and dearer.
 */
export async function generateMinutes(
   draft: string,
   meta: MinutesMeta,
): Promise<string> {
   const system = buildMinutesSystemPrompt();
   let body: string;
   if (draft.length <= SINGLE_PASS_MAX_CHARS) {
      body = await ask({
         system,
         messages: [
            { role: "user", content: buildMinutesUserPrompt(draft, meta) },
         ],
         tools: composeToolSources([]),
         effort: "low",
      });
   } else {
      const blocks = splitTranscriptIntoBlocks(draft);
      const notes: string[] = [];
      for (let i = 0; i < blocks.length; i++) {
         const note = await ask({
            system,
            messages: [
               {
                  role: "user",
                  content: buildBlockExtractionPrompt(
                     blocks[i]!,
                     i + 1,
                     blocks.length,
                  ),
               },
            ],
            tools: composeToolSources([]),
            effort: "low",
         });
         notes.push(`### Parte ${i + 1}\n${note.trim()}`);
      }
      body = await ask({
         system,
         messages: [
            {
               role: "user",
               content: buildFinalFromNotesPrompt(notes.join("\n\n"), meta),
            },
         ],
         tools: composeToolSources([]),
         effort: "low",
      });
   }
   return stripMinutesChatSection(body);
}
