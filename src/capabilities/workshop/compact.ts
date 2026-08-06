import { ask } from '../../llm/client.js';
import { composeToolSources } from '../../tools/source.js';
import { log } from '../../log.js';
import type { Turn } from '../../discord/history.js';

/**
 * Session-context compaction ("compact"), web-LLM style: when a taller's
 * conversation outgrows the live history window, the overflow is folded into
 * a running summary stored on the session row and injected into the system
 * prompt — so hour-long study sessions keep their thread without dragging the
 * whole transcript through every request.
 */

/** Turns kept verbatim in the live window (the rest is compactable). */
export const KEEP_RECENT_TURNS = 10;
/** Compaction triggers when the overflow reaches either threshold. */
export const COMPACT_MIN_OLD_TURNS = 6;
export const COMPACT_MIN_OLD_CHARS = 5_000;
/** Hard cap on the stored summary (rides every turn's system prompt). */
export const SUMMARY_MAX_CHARS = 1_800;
/** Cap on the transcript chunk sent to the summarizer. */
const TRANSCRIPT_MAX_CHARS = 14_000;

/** Whether the overflow is worth a compaction call. Pure — tested. */
export function shouldCompact(olderTurns: readonly Turn[]): boolean {
  if (olderTurns.length === 0) return false;
  if (olderTurns.length >= COMPACT_MIN_OLD_TURNS) return true;
  const chars = olderTurns.reduce((acc, t) => acc + t.content.length, 0);
  return chars >= COMPACT_MIN_OLD_CHARS;
}

function renderCompactionPrompt(): string {
  return `Eres el compactador de contexto de una sesión de asistencia (escuela/trabajo) en Discord.
Recibirás el resumen previo de la sesión (puede estar vacío) y un fragmento de conversación más antiguo que va a salir de la ventana de contexto.
Devuelve SOLO el nuevo resumen consolidado (sin encabezados ni comentarios), en español, máximo ~250 palabras, conservando:
- qué está estudiando/trabajando la persona y su objetivo,
- decisiones tomadas y preferencias expresadas (formato, tono, estilo),
- archivos del workspace relevantes (nombres exactos) y qué contienen,
- estado del trabajo: qué ya se hizo y qué quedó pendiente.
Omite saludos, errores transitorios y detalles superados.`;
}

/**
 * Fold `olderTurns` into `prevSummary` → the new summary, or null when the
 * summarizer failed (caller keeps the previous summary and retries later).
 */
export async function compactConversation(
  prevSummary: string | null,
  olderTurns: readonly Turn[],
): Promise<string | null> {
  const transcript = olderTurns
    .map((t) => `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.content}`)
    .join('\n\n')
    .slice(-TRANSCRIPT_MAX_CHARS);
  const body =
    (prevSummary ? `RESUMEN PREVIO:\n${prevSummary}\n\n` : '') +
    `CONVERSACIÓN A INTEGRAR:\n${transcript}`;
  try {
    const reply = await ask({
      system: renderCompactionPrompt(),
      messages: [{ role: 'user', content: body }],
      tools: composeToolSources([]),
      effort: 'medium',
    });
    const cleaned = reply.trim();
    // A fallback/apology string is not a summary — keep the previous one.
    if (cleaned.length < 40 || cleaned.startsWith('No pude')) return null;
    return cleaned.slice(0, SUMMARY_MAX_CHARS);
  } catch (err) {
    log.warn({ err }, 'workshop.compact_failed');
    return null;
  }
}
