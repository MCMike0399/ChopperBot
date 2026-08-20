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
- No inventes contenido: si algo no está en la transcripción hablada, no existe. La transcripción es automática y puede tener errores; si un tramo es ambiguo, resume lo seguro.
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

Con esas notas, redacta la minuta completa con la estructura indicada.`;
}

function renderMetaBlock(meta: MinutesMeta): string {
   return [
      `Sesión: ${meta.title}`,
      `Canal: ${meta.channelName}`,
      `Fecha: ${meta.dateLabel}`,
      `Duración: ${meta.durationLabel}`,
      `Participantes: ${meta.participants.join(", ") || "desconocidos"}`,
   ].join("\n");
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
 * Draft → minutes via the text brain. One pass when the draft fits; for long
 * assemblies a map pass extracts per-block notes (effort medium — no tools,
 * no thinking tokens needed) and a final pass merges them into the acta.
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
         effort: "medium",
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
            effort: "medium",
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
         effort: "medium",
      });
   }
   return stripMinutesChatSection(body);
}
