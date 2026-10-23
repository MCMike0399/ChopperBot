import { DISCORD_REPLY_FORMAT } from "./format.js";

const DISCORD_LIMIT = 2000;
type Fence = { opening: string; closing: string };

/**
 * Visible footer appended to every bot chunk EXCEPT the last when a reply
 * spans multiple Discord messages. The history walker (`history.ts`) walks
 * `message.reference.messageId` backwards, so it only captures the full
 * prior answer when the user replies to the tail of the chain. Marking
 * non-tail chunks nudges the user toward replying to the bottom — the
 * absence of the marker on the last chunk is the "reply here" signal.
 *
 * Kept short so it costs little of the 2000-char budget. Stripped from
 * captured history before being sent back to the model.
 */
export const CONTINUATION_FOOTER = "\n\n_…sigue ↓_";

/**
 * Split a long message into Discord-sized chunks WITHOUT breaking markdown
 * code blocks. If a chunk boundary lands inside a ``` fence, the chunk is
 * closed with ``` and the next chunk reopens with the same language tag.
 */
export function chunkMessage(text: string, limit = DISCORD_LIMIT): string[] {
   if (text.length <= limit) return [text];

   const chunks: string[] = [];
   let buf = "";
   let fence: Fence | null = null;
   const flush = (): void => {
      if (!buf) return;
      chunks.push(buf + (fence ? "\n" + fence.closing : ""));
      buf = fence ? fence.opening : "";
   };
   for (const line of text.split("\n")) {
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const nextFence: Fence | null = mark
         ? !fence
            ? { opening: line, closing: mark[1] }
            : mark[1][0] === fence.closing[0] &&
                mark[1].length >= fence.closing.length &&
                !mark[2].trim()
              ? null
              : fence
         : fence;
      const reserve = nextFence ? nextFence.closing.length + 1 : 0;
      if (
         line.length + reserve + (nextFence?.opening.length ?? 0) > limit &&
         mark
      ) {
         // An absurdly long fence info string cannot be repeated in a Discord message.
         // Treat it as plain text so delivery still obeys the hard limit.
         const plain = line.replace(/`/g, "ˋ").replace(/~/g, "∼");
         for (const part of chunkMessage(plain, limit)) {
            if (buf) flush();
            chunks.push(part);
         }
         continue;
      }
      if (
         buf.length + (buf ? 1 : 0) + line.length + reserve > limit &&
         buf &&
         buf !== fence?.opening
      )
         flush();
      let rest = line;
      do {
         const prefix = buf ? "\n" : "";
         const capacity = limit - buf.length - prefix.length - reserve;
         if (capacity < 0 || (capacity === 0 && rest.length > 0))
            throw new Error("Chunk limit too small for the code fence");
         let take = Math.min(rest.length, capacity);
         if (take < rest.length && /[\uD800-\uDBFF]/.test(rest[take - 1]))
            take--;
         if (take === 0 && rest.length) {
            flush();
            continue;
         }
         buf += prefix + rest.slice(0, take);
         rest = rest.slice(take);
         if (rest) flush();
      } while (rest);
      fence = nextFence;
   }
   if (buf) chunks.push(buf + (fence ? "\n" + fence.closing : ""));

   return chunks;
}

/**
 * Hard ceiling on messages one reply may occupy. A legitimate answer fits in a
 * few; more than this means something went wrong (2026-08-06: a degenerate
 * model loop filled ~8 messages of a member's taller with tool-call
 * scaffolding). The tail is dropped with a visible note instead.
 */
export const MAX_REPLY_CHUNKS = 5;

/** Appended when the reply was cut at MAX_REPLY_CHUNKS. */
const TRUNCATION_NOTE =
   "\n\n_(respuesta recortada — pídeme la parte que falte o dime que te la mande como archivo)_";

/**
 * Chunk a bot reply for Discord. Single-chunk replies pass through
 * unchanged. Multi-chunk replies get `CONTINUATION_FOOTER` appended to
 * every chunk except the last, AND are chunked with a tighter per-chunk
 * limit so each chunk + footer still fits in Discord's 2000-char cap.
 * Never returns more than `maxChunks` messages.
 */
export function chunkBotReply(
   text: string,
   limit = DISCORD_LIMIT,
   maxChunks = MAX_REPLY_CHUNKS,
): string[] {
   text = DISCORD_REPLY_FORMAT.render(text);
   // First-pass: would this fit in one message?
   const dry = chunkMessage(text, limit);
   if (dry.length <= 1) return dry;

   // Multi-chunk: re-chunk with reduced per-chunk budget so the footer fits.
   const reserved = limit - CONTINUATION_FOOTER.length;
   const chunks = chunkMessage(text, reserved);
   if (chunks.length <= maxChunks) {
      return chunks.map((c, i) =>
         i < chunks.length - 1 ? c + CONTINUATION_FOOTER : c,
      );
   }
   const kept = chunks.slice(0, maxChunks);
   return kept.map((c, i) =>
      i < kept.length - 1
         ? c + CONTINUATION_FOOTER
         : chunkMessage(c, reserved - TRUNCATION_NOTE.length)[0] +
           TRUNCATION_NOTE,
   );
}

/**
 * Remove the continuation footer from a captured bot message before it's
 * fed back to the model as conversation history. The marker is UI-only;
 * the model shouldn't see it (avoids confusing the model and saves tokens).
 */
export function stripContinuationFooter(content: string): string {
   if (content.endsWith(CONTINUATION_FOOTER)) {
      return content.slice(0, -CONTINUATION_FOOTER.length);
   }
   return content;
}
