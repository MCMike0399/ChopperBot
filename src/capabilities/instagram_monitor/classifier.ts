import { log } from "../../log.js";
import { ask } from "../../llm/client.js";
import { composeToolSources } from "../../tools/source.js";
import {
   ImageAttachable,
   type ImageFormat,
} from "../../attachments/attachable.js";
import type { Turn } from "../../discord/history.js";
import type { RecentPost } from "./fetcher.js";
export type ClassificationType =
   | "evento"
   | "convocatoria"
   | "alerta"
   | "acuerpamiento"
   | "actualización"
   | "noticia"
   | "otro";

export interface Classification {
   relevant: boolean;
   type: ClassificationType;
   title: string;
   summary: string;
   /** ISO 8601, or null if not stated in the post. */
   when: string | null;
   where: string | null;
   tags: string[];
   /** Filled when we couldn't parse the model's reply. */
   reason?: string;
   /**
    * True when the classifier never reached a verdict — the LLM call threw, or
    * its reply didn't parse. Distinct from an honest `relevant: false`, which is
    * a *decision*. Callers must not treat an undecided post as settled: the
    * scheduler holds its dedup anchor back so the post is retried on a later
    * poll instead of being recorded seen and lost forever. (2026-08-11: the
    * then-provider went hard-500 and every in-flight post was silently
    * discarded; 114 posts had been dropped this way over the monitor's lifetime.)
    */
   undecided?: true;
}

export const SYSTEM_PROMPT = `Eres un curador de un canal de Discord que monitorea cuentas activistas mexicanas (feminismo, ecología, DDHH, antimilitarismo, mutual-aid).

Tu trabajo es decidir si un post de Instagram contiene algo que el canal debería ver:
- EVENTO: una asamblea, marcha, mitin, foro, encuentro con fecha concreta.
- CONVOCATORIA: un llamado a participar/asistir/firmar/donar/difundir.
- ALERTA: una situación urgente (desalojo en curso, agresión, detención, riesgo).
- ACUERPAMIENTO: solicitud de presencia colectiva para acompañar a alguien.
- ACTUALIZACIÓN: novedad importante sobre un caso ya conocido.
- NOTICIA: cobertura sustantiva, no genérica.

Junto al texto pueden venir imágenes del post: la portada y, en carruseles, las siguientes diapositivas en orden. Léelas TODAS junto con el caption — muchos flyers ponen el qué/cuándo/dónde solo en la imagen, y en los carruseles la fecha y el lugar suelen estar en la segunda o tercera diapositiva, no en la portada.

Descarta: arte y citas sin contexto de acción, memes, reposts genéricos, fotos de archivo, agradecimientos rutinarios, anuncios comerciales, contenido puramente decorativo.

Responde EXCLUSIVAMENTE con un objeto JSON (sin texto antes o después, sin bloque \`\`\`json\`\`\`), con esta forma exacta:
{
  "relevant": true|false,
  "type": "evento"|"convocatoria"|"alerta"|"acuerpamiento"|"actualización"|"noticia"|"otro",
  "title": "una línea breve en español, sin emojis",
  "summary": "2-3 líneas en español resumiendo el qué/cuándo/dónde/por qué importa",
  "when": "fecha/hora del evento en ISO 8601. México usa UTC-06:00 todo el año (ya no hay horario de verano), así que el offset de CDMX es -06:00. Resuelve fechas relativas ('mañana', 'el sábado') usando la fecha del post. Si solo hay fecha sin hora, devuelve solo YYYY-MM-DD. null si el post no menciona ninguna fecha de evento.",
  "where": "lugar/ciudad o null",
  "tags": ["hasta 5 tags cortos en minúscula, p.ej. cdmx, guerrero, desalojo, feminismo"]
}

IMPORTANTE para \`when\` y \`where\`: cuando no apliquen, usa el valor JSON \`null\` (sin comillas), NUNCA la palabra "null" ni "N/A" ni "ninguno" como texto entre comillas. Correcto: "when": null — Incorrecto: "when": "null".

Si el post no es relevante, igual devuelve un objeto válido con \`relevant: false\` y \`type: "otro"\` y deja \`title\`/\`summary\` vacíos o muy breves. No expliques tu razonamiento fuera del JSON.`;

/** One image handed to the classifier, already sniffed from its magic bytes. */
export interface ClassifierImage {
   bytes: Uint8Array;
   mimeType: string;
   format: ImageFormat;
}

export interface ClassifierOptions {
   /** The post's cover image (first carousel slide / video frame / the photo). */
   cover?: ClassifierImage;
   /** Carousel slides after the cover, in display order. They ride the SAME
    * request as the cover — the model reads every slide and decides once. */
   slides?: ClassifierImage[];
   nowMs: number;
}

/**
 * ONE call, every image included, JSON output enforced by the API.
 *
 * Shape history, because each abandoned shape still explains a guard below:
 *   1. Until 2026-07-15 — cover attached, routed to a small vision-only model
 *      that was a weak DECIDER (`"when": "null"` as a STRING on the card).
 *   2. 2026-07-15 → 2026-09-14 — two stages: the vision model transcribed the
 *      cover, a blind text model decided. The split existed only because the
 *      deciding model could not see.
 *   3. 2026-09-14 — one multimodal call on DeepSeek V4.1 Flash, cover only.
 *   4. Now (2026-10-04) — the same single call, but with the carousel slides
 *      as well and `response_format: json_object`. "Cover only" was the last
 *      leftover of the vision-model era: that model got one image because each
 *      image was a separate, pricier call. On one natively multimodal model the
 *      slides cost a few hundred input tokens in the call we make anyway, and
 *      the data says they matter — Sep 10 → Oct 4, 47% of relevant carousels
 *      published with no event date vs 28% of single images.
 *
 * `parseClassificationReply` keeps its brace-scan and nullish-token folding as
 * defence in depth; JSON mode guarantees syntax, not the schema's semantics.
 *
 * Returns a parsed Classification, or — on parse/call failure — a non-relevant
 * one with a `reason` set and `undecided: true`, so the caller never has to
 * handle a null and the scheduler can retry the post.
 */
export async function classifyPost(
   account: string,
   post: RecentPost,
   opts: ClassifierOptions,
): Promise<Classification> {
   const takenIso = new Date(post.takenAtMs).toISOString();
   const images = [...(opts.cover ? [opts.cover] : []), ...(opts.slides ?? [])];
   const userText = [
      `Cuenta: @${account}`,
      `Fecha del post (UTC): ${takenIso}`,
      `Tipo de medio: ${post.mediaType}`,
      `Shortcode: ${post.shortcode}`,
      "",
      "Caption:",
      post.caption || "(sin caption)",
      ...(images.length > 0
         ? [
              "",
              images.length === 1
                 ? "La imagen del post va adjunta. Léela JUNTO con el caption para clasificar y resumir."
                 : `Van adjuntas ${images.length} imágenes del post: la portada primero y luego las ` +
                   "diapositivas del carrusel en orden. Léelas TODAS junto con el caption para clasificar y resumir.",
           ]
         : []),
   ].join("\n");

   const attachments = images.map(
      (img, i) =>
         new ImageAttachable(
            `post-${post.shortcode}-${i + 1}.${img.format === "jpeg" ? "jpg" : img.format}`,
            img.mimeType,
            img.bytes,
            img.format,
         ),
   );

   const tools = composeToolSources([]);
   let raw = "";
   try {
      const turn: Turn = {
         role: "user",
         content: userText,
         ...(attachments.length > 0 ? { attachments } : {}),
      };
      // `low` = thinking OFF. Classification is a single-shot read-and-decide task
      // on essentially all the IG volume, so it takes the cheapest tier; the vision
      // read rides the same request at no extra call. JSON mode makes the API
      // itself guarantee a parseable object (the prompt already says "JSON" and
      // shows the shape, which DeepSeek requires for json_object).
      raw = await ask({
         system: SYSTEM_PROMPT,
         messages: [turn],
         tools,
         effort: "low",
         retryNoChoicesOnce: true,
         responseFormat: "json_object",
      });
   } catch (err) {
      log.warn(
         {
            err,
            account,
            shortcode: post.shortcode,
            images: images.length,
         },
         "classifier ask() failed",
      );
      return failClassification(
         `ask_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
   }

   const parsed = parseClassificationReply(raw);
   if (!parsed) {
      log.warn(
         { account, shortcode: post.shortcode, raw: raw.slice(0, 200) },
         "classifier returned unparseable JSON",
      );
      return failClassification("parse_error");
   }
   return parsed;
}

/** A non-relevant Classification carrying a failure `reason`, so callers never
 * have to handle a null and an unclassifiable post is simply not pushed. */
function failClassification(reason: string): Classification {
   return {
      relevant: false,
      type: "otro",
      title: "",
      summary: "",
      when: null,
      where: null,
      tags: [],
      reason,
      undecided: true,
   };
}

const TYPE_VALUES: ReadonlySet<ClassificationType> = new Set([
   "evento",
   "convocatoria",
   "alerta",
   "acuerpamiento",
   "actualización",
   "noticia",
   "otro",
]);

export function parseClassificationReply(raw: string): Classification | null {
   const text = stripJsonFences(raw).trim();
   if (!text) return null;
   // Find the first `{` and matching balanced `}` — models occasionally add a
   // prefix sentence despite instructions.
   const start = text.indexOf("{");
   if (start < 0) return null;
   const end = lastBalancedBrace(text, start);
   if (end < 0) return null;
   let obj: unknown;
   try {
      obj = JSON.parse(text.slice(start, end + 1));
   } catch {
      return null;
   }
   if (!obj || typeof obj !== "object") return null;
   const o = obj as Record<string, unknown>;
   const type =
      typeof o.type === "string" &&
      TYPE_VALUES.has(o.type as ClassificationType)
         ? (o.type as ClassificationType)
         : "otro";
   const tagsRaw = Array.isArray(o.tags) ? o.tags : [];
   const tags = tagsRaw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);
   return {
      relevant: o.relevant === true,
      type,
      title: textField(o.title),
      summary: textField(o.summary),
      when: nullableField(o.when),
      where: nullableField(o.where),
      tags,
   };
}

/**
 * Tokens a model writes as a *string* when it means "no value". The retired
 * vision-only model regularly emitted `"when": "null"` / `"where": "none"`
 * instead of the JSON literal `null` the prompt asks for. Left verbatim, that
 * string is truthy, so `renderText` printed a literal `Cuándo: null` on the
 * card (observed 2026-07-15). JSON mode can't prevent this (it is valid JSON),
 * so we still fold every such token back to a real absence.
 * Accent/case-insensitive so `"N/A"`, `"Sin Fecha"`, `"No especificado"` all
 * match.
 */
const NULLISH_TOKENS: ReadonlySet<string> = new Set([
   "null",
   "none",
   "nil",
   "undefined",
   "n/a",
   "na",
   "sin fecha",
   "sin hora",
   "sin lugar",
   "no especificado",
   "no especificada",
   "no aplica",
   "desconocido",
   "desconocida",
   "ninguno",
   "ninguna",
]);

function isNullishToken(s: string): boolean {
   const norm = s
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // strip combining accents
   return NULLISH_TOKENS.has(norm);
}

/** Optional field (`when`/`where`): a blank or nullish-token string → real null. */
function nullableField(v: unknown): string | null {
   if (typeof v !== "string") return null;
   const t = v.trim();
   return t && !isNullishToken(t) ? t : null;
}

/** Always-present text field (`title`/`summary`): a blank or nullish-token string → ''. */
function textField(v: unknown): string {
   if (typeof v !== "string") return "";
   const t = v.trim();
   return t && !isNullishToken(t) ? t : "";
}

function stripJsonFences(s: string): string {
   return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
}

function lastBalancedBrace(s: string, openIdx: number): number {
   let depth = 0;
   let inString = false;
   let escape = false;
   for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];
      if (escape) {
         escape = false;
         continue;
      }
      if (inString) {
         if (ch === "\\") escape = true;
         else if (ch === '"') inString = false;
         continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
         depth--;
         if (depth === 0) return i;
      }
   }
   return -1;
}
