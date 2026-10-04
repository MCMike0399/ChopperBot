import { log } from "../log.js";

/** One identical failure reply per channel/5min; bounded process-local state. */
export class ErrorReplyGuard {
   private readonly last = new Map<string, number>();
   constructor(
      private readonly intervalMs = 5 * 60_000,
      private readonly maxKeys = 512,
   ) {}
   allow(channelId: string, content: string, now = Date.now()): boolean {
      for (const [key, at] of this.last)
         if (now - at >= this.intervalMs) this.last.delete(key);
      const key = `${channelId}:${content}`;
      if (this.last.has(key)) return false;
      this.last.set(key, now);
      while (this.last.size > this.maxKeys)
         this.last.delete(this.last.keys().next().value!);
      return true;
   }
}

const errorReplies = new ErrorReplyGuard();
export function allowErrorReply(channelId: string, content: string): boolean {
   const allowed = errorReplies.allow(channelId, content);
   if (!allowed) log.info({ channelId }, "discord.error_reply_suppressed");
   return allowed;
}
