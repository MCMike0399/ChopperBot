/**
 * Counting semaphore gating concurrent requests to the LLM backend.
 *
 * Why this exists (2026-08-06): the bot handles Discord messages concurrently,
 * and the provider it used then (the Kimi coding endpoint) degraded under
 * overlapping requests — observed live on 2026-08-05, when two overlapping
 * mentions made one turn burn its whole output budget on reasoning_content and
 * return empty text (the user got the fallback string). Serializing the
 * REQUESTS (not the whole turns) keeps multi-user chat responsive — two agent
 * loops interleave their completions — while the provider only ever sees
 * `limit` requests in flight.
 *
 * DeepSeek tolerates overlap (its documented concurrency limit is 2500), so the
 * default limit was raised from 1 to 3 with the 2026-09-14 v4.1 migration: this
 * is now a Pi-protection and cost-shaping knob rather than a provider
 * requirement. See `DEEPSEEK_MAX_CONCURRENT`.
 */
export class Semaphore {
   private active = 0;
   private readonly waiters: Array<() => void> = [];

   constructor(private readonly limit: number) {
      if (!Number.isInteger(limit) || limit < 1) {
         throw new Error(
            `Semaphore limit must be a positive integer, got ${limit}`,
         );
      }
   }

   /** Number of tasks currently holding a slot. */
   get running(): number {
      return this.active;
   }

   /** The concurrency limit this semaphore enforces. */
   get capacity(): number {
      return this.limit;
   }

   /** Number of tasks waiting for a slot. */
   get waiting(): number {
      return this.waiters.length;
   }

   /**
    * Run `task` once a slot is free. `onWait` fires (synchronously, once) only
    * when the task could NOT start immediately — lets callers surface a
    * "queued" signal to the user.
    *
    * FIFO fair: on release the slot is handed DIRECTLY to the oldest waiter
    * (`active` is never decremented in between), so a task arriving while
    * others wait can never jump the queue or over-subscribe the limit.
    */
   async run<T>(
      task: () => Promise<T>,
      opts?: { onWait?: () => void },
   ): Promise<T> {
      if (this.active < this.limit && this.waiters.length === 0) {
         this.active += 1;
      } else {
         opts?.onWait?.();
         // When resolved, the releasing task has already transferred its slot to
         // us — `active` stays counted the whole time.
         await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      try {
         return await task();
      } finally {
         const next = this.waiters.shift();
         if (next) next();
         else this.active -= 1;
      }
   }
}
