const DISCORD_LIMIT = 2000;
const FENCE_RE = /^```(\S*)/;

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
export const CONTINUATION_FOOTER = '\n\n_…sigue ↓_';

/**
 * Split a long message into Discord-sized chunks WITHOUT breaking markdown
 * code blocks. If a chunk boundary lands inside a ``` fence, the chunk is
 * closed with ``` and the next chunk reopens with the same language tag.
 */
export function chunkMessage(text: string, limit = DISCORD_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let bufLen = 0;
  let openFence: string | null = null;

  const flush = (): void => {
    if (buf.length === 0) return;
    let chunk = buf.join('\n');
    if (openFence !== null) chunk += '\n```';
    chunks.push(chunk.trimEnd());
    buf = [];
    bufLen = 0;
    if (openFence !== null) {
      buf.push(openFence);
      bufLen = openFence.length + 1;
    }
  };

  for (const line of lines) {
    const closingReserve = openFence !== null ? 4 : 0; // "\n```"
    const projected = bufLen + line.length + 1 + closingReserve;

    if (projected > limit && buf.length > 0) flush();

    const m = line.match(FENCE_RE);
    if (m) openFence = openFence === null ? '```' + m[1] : null;

    buf.push(line);
    bufLen += line.length + 1;
  }

  if (buf.length > 0) {
    let chunk = buf.join('\n');
    if (openFence !== null) chunk += '\n```';
    chunks.push(chunk.trimEnd());
  }

  return chunks;
}

/**
 * Chunk a bot reply for Discord. Single-chunk replies pass through
 * unchanged. Multi-chunk replies get `CONTINUATION_FOOTER` appended to
 * every chunk except the last, AND are chunked with a tighter per-chunk
 * limit so each chunk + footer still fits in Discord's 2000-char cap.
 */
export function chunkBotReply(text: string, limit = DISCORD_LIMIT): string[] {
  // First-pass: would this fit in one message?
  const dry = chunkMessage(text, limit);
  if (dry.length <= 1) return dry;

  // Multi-chunk: re-chunk with reduced per-chunk budget so the footer fits.
  const reserved = limit - CONTINUATION_FOOTER.length;
  const chunks = chunkMessage(text, reserved);
  return chunks.map((c, i) => (i < chunks.length - 1 ? c + CONTINUATION_FOOTER : c));
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
