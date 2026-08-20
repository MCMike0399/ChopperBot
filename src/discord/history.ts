import { Client, Message } from "discord.js";
import { stripContinuationFooter } from "./chunk.js";
import type { Attachable } from "../attachments/attachable.js";

export interface Turn {
   role: "user" | "assistant";
   content: string;
   attachments?: Attachable[];
}

const MAX_TURNS = 8;
const MAX_TOTAL_CHARS = 16_000;

function stripMention(client: Client, content: string): string {
   if (!client.user) return content;
   return content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
}

/**
 * Walks the reply chain backward from `message`, returning prior turns in
 * chronological order. The current `message` itself is NOT included — the
 * caller appends it as the trailing user turn.
 *
 * Stops on: no-reference, deleted/inaccessible parent, foreign bot, turn cap,
 * or character cap.
 */
export async function buildHistory(
   client: Client,
   message: Message,
): Promise<Turn[]> {
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

      const role: Turn["role"] =
         parent.author.id === client.user?.id ? "assistant" : "user";
      // Strip the continuation footer from bot chunks so it never leaks back
      // to the model as part of the conversation history.
      const stripped =
         role === "assistant"
            ? stripContinuationFooter(parent.content)
            : parent.content;
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
 * Header for a bot message that OPENS the window, folded into the first user
 * turn. It's labelled rather than passed off as the person's own words, so the
 * model can tell "this is what I said before" from "this is what they asked".
 */
const LEADING_BOT_HEADER =
   "[Contexto — mensaje anterior de ChopperBot en este canal, al que la persona está respondiendo]";

/**
 * Coerce a sequence of turns into the canonical chat shape the model expects:
 *   - alternating user/assistant
 *   - starts with user
 * Strategy: merge consecutive same-role turns (concatenate content), then FOLD
 * any leading assistant turns into the first user turn as labelled context.
 *
 * Folding (rather than dropping) is load-bearing for **bot-initiated** threads.
 * A chain that starts with the bot is not an anomaly here: the calendar's
 * "falta crear el evento de Discord" nudge, the daily announcement and admin
 * alerts all speak first, and a mod replying to one of them produces a window
 * whose only history turn is that bot message. Dropping it left the model with
 * a bare "crea el evento" and no referent — observed live on 2026-08-10, where
 * it answered "¿qué evento quieres crear?" to a reply on its own nudge.
 */
export function normalizeTurns(turns: Turn[]): Turn[] {
   const merged: Turn[] = [];
   for (const t of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === t.role) {
         last.content += "\n\n" + t.content;
         if (t.attachments?.length) {
            last.attachments ??= [];
            last.attachments.push(...t.attachments);
         }
      } else {
         merged.push({
            role: t.role,
            content: t.content,
            attachments: t.attachments,
         });
      }
   }

   const leading: Turn[] = [];
   while (merged.length > 0 && merged[0].role === "assistant")
      leading.push(merged.shift()!);
   // Nothing to fold into (an assistant-only window can't be a prompt) — the
   // caller always appends the live user message, so this stays an edge case.
   if (leading.length > 0 && merged.length > 0) {
      const quoted = leading
         .map((t) => t.content)
         .join("\n\n")
         .split("\n")
         .map((line) => `> ${line}`)
         .join("\n");
      merged[0].content = `${LEADING_BOT_HEADER}\n${quoted}\n\n${merged[0].content}`;
   }
   return merged;
}
