import { Client, Message } from 'discord.js';
import { stripContinuationFooter } from './chunk.js';
import type { Attachable } from '../attachments/attachable.js';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachable[];
}

const MAX_TURNS = 8;
const MAX_TOTAL_CHARS = 16_000;

function stripMention(client: Client, content: string): string {
  if (!client.user) return content;
  return content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
}

/**
 * Walks the reply chain backward from `message`, returning prior turns in
 * chronological order. The current `message` itself is NOT included — the
 * caller appends it as the trailing user turn.
 *
 * Stops on: no-reference, deleted/inaccessible parent, foreign bot, turn cap,
 * or character cap.
 */
export async function buildHistory(client: Client, message: Message): Promise<Turn[]> {
  const turns: Turn[] = [];
  let chars = 0;
  let cursor: Message = message;

  while (turns.length < MAX_TURNS) {
    const refId = cursor.reference?.messageId;
    if (!refId) break;

    let parent: Message;
    try {
      parent = await cursor.channel.messages.fetch(refId);
    } catch {
      break;
    }

    if (parent.author.bot && parent.author.id !== client.user?.id) break;

    const role: Turn['role'] = parent.author.id === client.user?.id ? 'assistant' : 'user';
    // Strip the continuation footer from bot chunks so it never leaks back
    // to the model as part of the conversation history.
    const stripped =
      role === 'assistant' ? stripContinuationFooter(parent.content) : parent.content;
    const content = stripMention(client, stripped);
    if (content) {
      // Intentional v1 limitation: historical turns are text-only.
      // Re-downloading old Discord CDN attachments on every reply adds
      // latency and complexity. Only the current message's attachments
      // are resolved and sent to the model.
      turns.push({ role, content });
      chars += content.length;
      if (chars > MAX_TOTAL_CHARS) break;
    }
    cursor = parent;
  }

  return turns.reverse();
}

/**
 * Coerce a sequence of turns into the canonical chat shape the model expects:
 *   - alternating user/assistant
 *   - starts with user
 * Strategy: merge consecutive same-role turns (concatenate content),
 * then drop any leading assistant turns.
 */
export function normalizeTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.content += '\n\n' + t.content;
      if (t.attachments?.length) {
        last.attachments ??= [];
        last.attachments.push(...t.attachments);
      }
    } else {
      merged.push({ role: t.role, content: t.content, attachments: t.attachments });
    }
  }
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
  return merged;
}
