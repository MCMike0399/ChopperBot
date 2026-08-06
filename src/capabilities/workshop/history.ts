import type { Client, Message } from 'discord.js';
import { stripContinuationFooter } from '../../discord/chunk.js';
import type { Turn } from '../../discord/history.js';

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
  let content = isAssistant ? stripContinuationFooter(m.content) : m.content;
  content = content.trim();
  if (!content && m.attachmentNames.length > 0) {
    content = `[envió archivo(s): ${m.attachmentNames.join(', ')}]`;
  }
  if (!content) return null;
  return { role: isAssistant ? 'assistant' : 'user', content };
}

/** Fetch and assemble the session history, chronological, capped. */
export async function buildChannelHistory(
  client: Client,
  message: Message,
  opts: ChannelHistoryOptions,
): Promise<Turn[]> {
  const botUserId = client.user?.id ?? '';
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const maxChars = opts.maxChars ?? MAX_TOTAL_CHARS;

  const fetched = await message.channel.messages
    .fetch({ limit: 50, before: message.id })
    .catch(() => null);
  if (!fetched) return [];

  // fetch() returns newest-first; walk newest → oldest accumulating caps, then
  // reverse to chronological.
  const collected: Turn[] = [];
  let chars = 0;
  for (const m of fetched.values()) {
    if (collected.length >= maxTurns || chars >= maxChars) break;
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
    collected.push(turn);
    chars += turn.content.length;
  }
  return collected.reverse();
}
