import { log } from '../log.js';
import { Semaphore } from '../llm/gate.js';

/**
 * Orders and bounds concurrent message-handling turns.
 *
 * Two guarantees, fixing the live "two messages at once" failures (2026-08-06):
 *  1. **Per-channel FIFO** — turns in the SAME channel run strictly in arrival
 *     order, so two rapid messages can't produce interleaved/older-context
 *     replies (each queued turn re-reads channel history only when it actually
 *     starts, so it sees the previous reply).
 *  2. **Global cap** — at most `maxConcurrent` turns execute across ALL
 *     channels, protecting the Pi and the LLM backend from a pile-up. Excess
 *     turns wait their turn; `onQueued` lets the caller show a ⏳ signal.
 *
 * A queued task whose channel backlog exceeds `maxQueuedPerChannel` is
 * rejected with {@link QueueBusyError} so a spammed channel degrades with a
 * polite "espera un momento" instead of an unbounded promise pile.
 */
export class QueueBusyError extends Error {
  constructor(channelId: string, depth: number) {
    super(`Turn queue for channel ${channelId} is full (${depth} waiting)`);
    this.name = 'QueueBusyError';
  }
}

export interface TurnQueueOptions {
  maxConcurrent: number;
  /** Max turns WAITING per channel (the running one doesn't count). Default 5. */
  maxQueuedPerChannel?: number;
}

export class TurnQueue {
  private readonly gate: Semaphore;
  private readonly maxQueuedPerChannel: number;
  /** Tail of each channel's promise chain (undefined = channel idle). */
  private readonly channelTails = new Map<string, Promise<unknown>>();
  private readonly channelDepth = new Map<string, number>();
  private queuedTotal = 0;

  constructor(opts: TurnQueueOptions) {
    this.gate = new Semaphore(opts.maxConcurrent);
    this.maxQueuedPerChannel = opts.maxQueuedPerChannel ?? 5;
  }

  /** Turns currently executing. */
  get running(): number {
    return this.gate.running;
  }

  /** Turns waiting (any channel). */
  get queued(): number {
    return this.queuedTotal;
  }

  /**
   * Run `task` after every earlier task in this channel finished, holding one
   * of the global slots. `onQueued` fires once, synchronously, iff the task
   * cannot start immediately.
   */
  run<T>(channelId: string, task: () => Promise<T>, hooks?: { onQueued?: () => void }): Promise<T> {
    const depth = this.channelDepth.get(channelId) ?? 0;
    if (depth > this.maxQueuedPerChannel) {
      throw new QueueBusyError(channelId, depth);
    }

    const prior = this.channelTails.get(channelId);
    const channelBusy = prior !== undefined;
    const globallyBusy = this.gate.running >= this.gate.capacity || this.gate.waiting > 0;
    if (channelBusy || globallyBusy) hooks?.onQueued?.();

    this.channelDepth.set(channelId, depth + 1);
    this.queuedTotal += 1;

    const runAfterPrior = async (): Promise<T> => {
      // Wait for the channel's previous turn — success or failure — first.
      if (prior) await prior.catch(() => {});
      return this.gate.run(task);
    };

    const p = runAfterPrior();
    // The chain tail must never reject (it would poison the next .catch-less
    // await), so store a settled-safe copy.
    const tail = p.catch(() => {});
    this.channelTails.set(channelId, tail);
    void p.finally(() => {
      this.queuedTotal -= 1;
      const d = (this.channelDepth.get(channelId) ?? 1) - 1;
      if (d <= 0) this.channelDepth.delete(channelId);
      else this.channelDepth.set(channelId, d);
      // If nothing new chained after us, the channel is idle again.
      if (this.channelTails.get(channelId) === tail) this.channelTails.delete(channelId);
    }).catch(() => {});
    p.catch(() => log.debug({ channelId }, 'turn_queue.task_failed'));
    return p;
  }
}
