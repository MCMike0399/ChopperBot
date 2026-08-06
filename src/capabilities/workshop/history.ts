import type { Client, Message } from 'discord.js';
import { stripContinuationFooter } from '../../discord/chunk.js';
import { EMPTY_RESPONSE_FALLBACK, CONTENT_FILTER_FALLBACK } from '../../llm/client.js';
import { GENERIC_ERROR_REPLY, QUEUE_BUSY_REPLY } from '../../discord/handlers.js';
import type { Turn } from '../../discord/history.js';

/**
 * Bot messages that are OPERATIONAL noise, not conversation — they must never
 * be fed back to the model as assistant turns. The live failure this guards
 * against (2026-08-06): a session whose history carried two genuine
 * "No pude generar una respuesta esta vez…" fallbacks taught Kimi to answer
 * the user's next (repeated) question with that exact string — a
 * self-perpetuating failure loop that survived the fix of the original error.
 * Also skipped: live status lines (`-# `), the VirusTotal verdict card the
 * file_scanner posts in the same channel, and the session panel/goodbye.
 */
const NOISE_ASSISTANT_PREFIXES = [
  EMPTY_RESPONSE_FALLBACK,
  CONTENT_FILTER_FALLBACK,
  GENERIC_ERROR_REPLY,
  QUEUE_BUSY_REPLY,
  '-# ',
  '🔎 **Análisis de seguridad',
  '🔒 Cerrando este taller',
  '🧹 Listo — borrón y cuenta nueva',
];

/** Whether a bot-authored message is operational noise. Exported for tests. */
export function isNoiseAssistantMessage(content: string): boolean {
  const trimmed = content.trimStart();
  return NOISE_ASSISTANT_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Channel-based conversation history for a workshop session.
 *
 * Unlike the reply-chain walker in discord/history.ts (built for public
 * channels where threads interleave), a workshop channel IS one conversation —
 * so the last N messages of the channel are the context, exactly like a web
 * LLM chat. No reply-chains needed.
 */

const MAX_TURNS = 20;
const MAX_TOTAL_CHARS = 16_000;

export interface ChannelHistoryOptions {
  /** Ignore messages at/before this timestamp ("limpiar contexto"). */
  sinceMs: number | null;
  /** Message ids to skip (control panel, the triggering message itself). */
  skipIds: ReadonlySet<string>;
  maxTurns?: number;
  maxChars?: number;
}

/**
 * Pure classification of one fetched message into a Turn (or null to skip).
 * Exported for tests.
 */
export function classifyMessage(
  m: {
    id: string;
    authorId: string | null;
    authorBot: boolean;
    content: string;
    createdTimestamp: number;
    attachmentNames: string[];
  },
  botUserId: string,
  opts: ChannelHistoryOptions,
): Turn | null {
  if (opts.skipIds.has(m.id)) return null;
  if (opts.sinceMs !== null && m.createdTimestamp <= opts.sinceMs) return null;
  if (m.authorBot && m.authorId !== botUserId) return null; // foreign bots

  const isAssistant = m.authorId === botUserId;
  if (isAssistant && isNoiseAssistantMessage(m.content)) return null;
  let content = isAssistant ? stripContinuationFooter(m.content) : m.content;
  content = content.trim();
  if (!content && m.attachmentNames.length > 0) {
    content = `[envió archivo(s): ${m.attachmentNames.join(', ')}]`;
  }
  if (!content) return null;
  return { role: isAssistant ? 'assistant' : 'user', content };
}

export interface ChannelHistoryResult {
  /** The live window fed verbatim to the model (chronological). */
  turns: Turn[];
  /** Older turns that overflowed the window (chronological) — compaction input. */
  older: Turn[];
  /** createdTimestamp of the NEWEST message in `older` (summary covers-until). */
  olderNewestMs: number | null;
}

/** Fetch and assemble the session history, chronological, capped — plus the
 * overflow beyond the window so the caller can fold it into the session
 * summary (see compact.ts). */
export async function buildChannelHistory(
  client: Client,
  message: Message,
  opts: ChannelHistoryOptions,
): Promise<ChannelHistoryResult> {
  const botUserId = client.user?.id ?? '';
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const maxChars = opts.maxChars ?? MAX_TOTAL_CHARS;

  const fetched = await message.channel.messages
    .fetch({ limit: 50, before: message.id })
    .catch(() => null);
  if (!fetched) return { turns: [], older: [], olderNewestMs: null };

  // fetch() returns newest-first; walk newest → oldest filling the live
  // window, then keep collecting into `older` for compaction; reverse both.
  const collected: Turn[] = [];
  const older: Turn[] = [];
  let olderNewestMs: number | null = null;
  let chars = 0;
  for (const m of fetched.values()) {
    const turn = classifyMessage(
      {
        id: m.id,
        authorId: m.author?.id ?? null,
        authorBot: m.author?.bot ?? false,
        content: m.content ?? '',
        createdTimestamp: m.createdTimestamp,
        attachmentNames: [...m.attachments.values()].map((a) => a.name),
      },
      botUserId,
      opts,
    );
    if (!turn) continue;
    if (collected.length >= maxTurns || chars >= maxChars) {
      older.push(turn);
      if (olderNewestMs === null) olderNewestMs = m.createdTimestamp;
      continue;
    }
    collected.push(turn);
    chars += turn.content.length;
  }
  return { turns: collected.reverse(), older: older.reverse(), olderNewestMs };
}
