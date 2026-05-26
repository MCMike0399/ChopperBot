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

const SYSTEM_PROMPT = `Eres un curador de un canal de Discord que monitorea cuentas activistas mexicanas (feminismo, ecología, DDHH, antimilitarismo, mutual-aid).

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
  "when": "ISO 8601 con offset o null",
  "where": "lugar/ciudad o null",
  "tags": ["hasta 5 tags cortos en minúscula, p.ej. cdmx, guerrero, desalojo, feminismo"]
}

Si el post no es relevante, igual devuelve un objeto válido con \`relevant: false\` y \`type: "otro"\` y deja \`title\`/\`summary\` vacíos o muy breves. No expliques tu razonamiento fuera del JSON.`;

export interface ClassifierOptions {
  /** Optional cover image as raw bytes — passed to the LLM for image-only posts (flyers). */
  cover?: { bytes: Uint8Array; mimeType: string; format: ImageFormat };
  nowMs: number;
}

/**
 * One LLM call per new post. Returns a parsed Classification, or — on parse
 * failure — a non-relevant Classification with a `reason` field set, so the
 * caller never has to handle a null.
 */
export async function classifyPost(
  account: string,
  post: RecentPost,
  opts: ClassifierOptions,
): Promise<Classification> {
  const takenIso = new Date(post.takenAtMs).toISOString();
  const userText = [
    `Cuenta: @${account}`,
    `Fecha del post (UTC): ${takenIso}`,
    `Tipo de medio: ${post.mediaType}`,
    `Shortcode: ${post.shortcode}`,
    '',
    'Caption:',
    post.caption || '(sin caption)',
  ].join('\n');

  const attachments = opts.cover
    ? [
        new ImageAttachable(
          `post-${post.shortcode}.${opts.cover.format === 'jpeg' ? 'jpg' : opts.cover.format}`,
          opts.cover.mimeType,
          opts.cover.bytes,
          opts.cover.format,
        ),
      ]
    : undefined;

  const turn: Turn = { role: 'user', content: userText, attachments };
  const tools = composeToolSources([]);

  let raw = '';
  try {
    raw = await ask({ system: SYSTEM_PROMPT, messages: [turn], tools });
  } catch (err) {
    log.warn({ err, account, shortcode: post.shortcode }, 'classifier ask() failed');
    return {
      relevant: false,
      type: 'otro',
      title: '',
      summary: '',
      when: null,
      where: null,
      tags: [],
      reason: `ask_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseClassificationReply(raw);
  if (!parsed) {
    log.warn(
      { account, shortcode: post.shortcode, raw: raw.slice(0, 200) },
      'classifier returned unparseable JSON',
    );
    return {
      relevant: false,
      type: 'otro',
      title: '',
      summary: '',
      when: null,
      where: null,
      tags: [],
      reason: 'parse_error',
    };
  }
  return parsed;
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
    title: typeof o.title === 'string' ? o.title.trim() : '',
    summary: typeof o.summary === 'string' ? o.summary.trim() : '',
    when: typeof o.when === 'string' && o.when.trim() ? o.when.trim() : null,
    where: typeof o.where === 'string' && o.where.trim() ? o.where.trim() : null,
    tags,
  };
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
