import { log } from '../../log.js';
import { ask } from '../../llm/client.js';
import { composeToolSources } from '../../tools/source.js';
import { ImageAttachable, type ImageFormat } from '../../attachments/attachable.js';
import type { Turn } from '../../discord/history.js';
import type { RecentPost } from './fetcher.js';

export type ClassificationType =
  | 'evento'
  | 'convocatoria'
  | 'alerta'
  | 'acuerpamiento'
  | 'actualización'
  | 'noticia'
  | 'otro';

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
}

export const SYSTEM_PROMPT = `Eres un curador de un canal de Discord que monitorea cuentas activistas mexicanas (feminismo, ecología, DDHH, antimilitarismo, mutual-aid).

Tu trabajo es decidir si un post de Instagram contiene algo que el canal debería ver:
- EVENTO: una asamblea, marcha, mitin, foro, encuentro con fecha concreta.
- CONVOCATORIA: un llamado a participar/asistir/firmar/donar/difundir.
- ALERTA: una situación urgente (desalojo en curso, agresión, detención, riesgo).
- ACUERPAMIENTO: solicitud de presencia colectiva para acompañar a alguien.
- ACTUALIZACIÓN: novedad importante sobre un caso ya conocido.
- NOTICIA: cobertura sustantiva, no genérica.

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

/** System prompt for the vision (Nova Lite) transcription stage. Nova ONLY
 * reads the flyer here — it never decides relevance. Keeping the decision off
 * the weaker vision model is deliberate: Nova regularly mangled the JSON schema
 * (e.g. emitting the string "null" for `when`), whereas reading text off a
 * flyer is "not a model differentiator" (Nova does it reliably). */
export const TRANSCRIBE_SYSTEM_PROMPT = `Eres un transcriptor de imágenes. Te doy la imagen de portada de un post de Instagram — normalmente un flyer de un colectivo activista mexicano.

Transcribe TODO el texto visible en la imagen, en español, tal como aparece: títulos, fechas, horas, lugares, nombres, convocatorias, hashtags, datos de contacto. Conserva el orden de lectura de arriba a abajo. Si la imagen tiene poco o ningún texto, describe en 1-2 líneas qué se ve.

Responde SOLO con el texto transcrito (o la breve descripción). Sin comentarios, sin encabezados, sin formato adicional.`;

export interface ClassifierOptions {
  /** Optional cover image as raw bytes — read by the Nova transcription stage. */
  cover?: { bytes: Uint8Array; mimeType: string; format: ImageFormat };
  nowMs: number;
}

/**
 * Two-stage classification (2026-07-15). Kimi is the text BRAIN and makes every
 * relevance/type/date decision; Amazon Nova Lite is used ONLY as the eyes:
 *
 *   1. VISION (Nova Lite) — if the post has a cover, transcribe the flyer's
 *      visible text. Failure is non-fatal (we fall back to caption-only).
 *   2. TEXT (Kimi) — classify from the caption + the transcribed flyer text.
 *
 * This replaced the single image-carrying `ask()` that routed the WHOLE
 * decision to Nova (the routing rule sends any image turn to Bedrock). Nova
 * doing the decision was the root cause of the string-"null" / lower-quality
 * classifications seen after the 2026-07-13 Kimi repoint. Returns a parsed
 * Classification, or — on parse/call failure — a non-relevant one with a
 * `reason` set, so the caller never has to handle a null.
 */
export async function classifyPost(
  account: string,
  post: RecentPost,
  opts: ClassifierOptions,
): Promise<Classification> {
  // Stage 1 (vision, Nova Lite): read the flyer. Non-fatal on failure.
  const flyerText = opts.cover ? await transcribeFlyer(account, post, opts.cover) : null;

  // Stage 2 (text brain, Kimi): decide relevance/type/date from caption + flyer text.
  const takenIso = new Date(post.takenAtMs).toISOString();
  const userText = [
    `Cuenta: @${account}`,
    `Fecha del post (UTC): ${takenIso}`,
    `Tipo de medio: ${post.mediaType}`,
    `Shortcode: ${post.shortcode}`,
    '',
    'Caption:',
    post.caption || '(sin caption)',
    ...(flyerText
      ? [
          '',
          'Texto de la imagen (portada), transcrito por un lector de imágenes. Úsalo JUNTO ' +
            'con el caption para clasificar y resumir — muchos flyers ponen el qué/cuándo/dónde ' +
            'SOLO en la imagen, no en el caption:',
          flyerText,
        ]
      : []),
  ].join('\n');

  const tools = composeToolSources([]);
  let raw = '';
  try {
    // No attachment here → routes to Kimi (the text brain). The flyer's text is
    // already inlined above, so this stage never needs vision.
    const turn: Turn = { role: 'user', content: userText };
    raw = await ask({ system: SYSTEM_PROMPT, messages: [turn], tools, effort: 'medium' });
  } catch (err) {
    log.warn({ err, account, shortcode: post.shortcode }, 'classifier ask() failed');
    return failClassification(`ask_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseClassificationReply(raw);
  if (!parsed) {
    log.warn(
      { account, shortcode: post.shortcode, raw: raw.slice(0, 200) },
      'classifier returned unparseable JSON',
    );
    return failClassification('parse_error');
  }
  return parsed;
}

/**
 * Stage 1: ask Nova Lite (the vision backend) to transcribe the flyer's visible
 * text. Returns the transcription, or null if there's no usable text or the
 * vision call fails — the caller then classifies caption-only, so a bad/missing
 * cover never drops a post (the "never do worse than caption-only" guarantee).
 */
async function transcribeFlyer(
  account: string,
  post: RecentPost,
  cover: NonNullable<ClassifierOptions['cover']>,
): Promise<string | null> {
  const attachment = new ImageAttachable(
    `post-${post.shortcode}.${cover.format === 'jpeg' ? 'jpg' : cover.format}`,
    cover.mimeType,
    cover.bytes,
    cover.format,
  );
  const tools = composeToolSources([]);
  const turn: Turn = {
    role: 'user',
    content: `Transcribe el texto visible en esta imagen (portada del post de @${account}).`,
    attachments: [attachment],
  };
  try {
    // Image attached → ask() routes to Nova Lite. effort 'low' is the vision
    // tier (the attachment alone already forces Bedrock, but be explicit).
    const raw = await ask({ system: TRANSCRIBE_SYSTEM_PROMPT, messages: [turn], tools, effort: 'low' });
    const text = raw.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    log.warn(
      { err, account, shortcode: post.shortcode },
      'flyer transcription (Nova) failed — classifying caption-only',
    );
    return null;
  }
}

/** A non-relevant Classification carrying a failure `reason`, so callers never
 * have to handle a null and an unclassifiable post is simply not pushed. */
function failClassification(reason: string): Classification {
  return { relevant: false, type: 'otro', title: '', summary: '', when: null, where: null, tags: [], reason };
}

const TYPE_VALUES: ReadonlySet<ClassificationType> = new Set([
  'evento',
  'convocatoria',
  'alerta',
  'acuerpamiento',
  'actualización',
  'noticia',
  'otro',
]);

export function parseClassificationReply(raw: string): Classification | null {
  const text = stripJsonFences(raw).trim();
  if (!text) return null;
  // Find the first `{` and matching balanced `}` — models occasionally add a
  // prefix sentence despite instructions.
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = lastBalancedBrace(text, start);
  if (end < 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o.type === 'string' && TYPE_VALUES.has(o.type as ClassificationType)
    ? (o.type as ClassificationType)
    : 'otro';
  const tagsRaw = Array.isArray(o.tags) ? o.tags : [];
  const tags = tagsRaw
    .filter((t): t is string => typeof t === 'string')
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
 * Tokens a model writes as a *string* when it means "no value". The weaker
 * vision model (Nova Lite, which handles the image-carrying classifier calls —
 * Kimi is text-only) regularly emits `"when": "null"` / `"where": "none"`
 * instead of the JSON literal `null` the prompt asks for. Left verbatim, that
 * string is truthy, so `renderText` printed a literal `Cuándo: null` on the
 * card (observed 2026-07-15). We fold every such token back to a real absence.
 * Accent/case-insensitive so `"N/A"`, `"Sin Fecha"`, `"No especificado"` all
 * match.
 */
const NULLISH_TOKENS: ReadonlySet<string> = new Set([
  'null',
  'none',
  'nil',
  'undefined',
  'n/a',
  'na',
  'sin fecha',
  'sin hora',
  'sin lugar',
  'no especificado',
  'no especificada',
  'no aplica',
  'desconocido',
  'desconocida',
  'ninguno',
  'ninguna',
]);

function isNullishToken(s: string): boolean {
  const norm = s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // strip combining accents
  return NULLISH_TOKENS.has(norm);
}

/** Optional field (`when`/`where`): a blank or nullish-token string → real null. */
function nullableField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && !isNullishToken(t) ? t : null;
}

/** Always-present text field (`title`/`summary`): a blank or nullish-token string → ''. */
function textField(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t && !isNullishToken(t) ? t : '';
}

function stripJsonFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
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
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
