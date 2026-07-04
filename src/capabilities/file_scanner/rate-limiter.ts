import { log } from '../../log.js';
import type { FileScannerStore } from './store.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Thrown by {@link ScanRateLimiter.schedule} when the rolling daily budget is spent. */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly used: number,
    readonly budget: number,
  ) {
    super(`VirusTotal daily request budget exhausted (${used}/${budget})`);
    this.name = 'BudgetExhaustedError';
  }
}

/** Thrown when the scan queue is already saturated (back-pressure). */
export class QueueFullError extends Error {
  constructor(readonly depth: number) {
    super(`Scan queue full (${depth} waiting)`);
    this.name = 'QueueFullError';
  }
}

export interface ScanRateLimiterDeps {
  store: FileScannerStore;
  /** Rolling-24h ceiling on VirusTotal API calls. */
  dailyBudget: number;
  /** Minimum spacing between consecutive VT calls (ms). */
  minIntervalMs: number;
  /** Max jobs allowed to wait behind the in-flight one before we shed load. */
  maxQueueDepth?: number;
  /** Injectable for tests. Defaults to Date.now / real setTimeout. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes every VirusTotal HTTP call through a single in-process queue so
 * that (a) at most one call is in flight at a time, (b) consecutive calls are
 * spaced at least `minIntervalMs` apart (the free tier's 4-req/min limit), and
 * (c) each call is gated by the persistent rolling-24h budget in the store.
 *
 * A burst of uploads therefore drains politely at ~4/min instead of tripping
 * VirusTotal's own 429s — the whole point the reference bot got wrong by just
 * sleeping a fixed 25 s per request with no cross-request coordination.
 */
export class ScanRateLimiter {
  private readonly store: FileScannerStore;
  private readonly dailyBudget: number;
  private readonly minIntervalMs: number;
  private readonly maxQueueDepth: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Promise chain: each scheduled job appends to the tail, so they run in order. */
  private tail: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;
  private lastCallAt = 0;

  constructor(deps: ScanRateLimiterDeps) {
    this.store = deps.store;
    this.dailyBudget = deps.dailyBudget;
    this.minIntervalMs = deps.minIntervalMs;
    this.maxQueueDepth = deps.maxQueueDepth ?? 24;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Number of jobs waiting behind the one currently running (0 = idle). */
  get depth(): number {
    return this.queueDepth;
  }

  /** Requests used in the rolling window right now (for status/digests). */
  usedInWindow(): number {
    return this.store.requestsInWindow(this.now(), WINDOW_MS);
  }

  /**
   * Enqueue one VirusTotal call. The returned promise resolves with `fn`'s
   * result once its turn comes up, the spacing delay has elapsed, and a budget
   * slot was reserved. Rejects with {@link QueueFullError} immediately if the
   * queue is saturated, or {@link BudgetExhaustedError} when it's this job's
   * turn but no budget remains.
   */
  schedule<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.queueDepth >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError(this.queueDepth));
    }
    this.queueDepth++;
    const run = this.tail.then(async () => {
      try {
        await this.waitForSlot();
        this.reserveBudgetOrThrow();
        this.lastCallAt = this.now();
        return await fn();
      } finally {
        this.queueDepth--;
      }
    });
    // Keep the chain alive even if this job rejects, so later jobs still run.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Sleep until at least `minIntervalMs` has elapsed since the last VT call. */
  private async waitForSlot(): Promise<void> {
    const elapsed = this.now() - this.lastCallAt;
    const wait = this.minIntervalMs - elapsed;
    if (this.lastCallAt > 0 && wait > 0) {
      log.debug({ wait }, 'file_scanner.rate_limit.wait');
      await this.sleep(wait);
    }
  }

  private reserveBudgetOrThrow(): void {
    const ok = this.store.tryConsumeBudget(this.now(), this.dailyBudget, WINDOW_MS);
    if (!ok) {
      throw new BudgetExhaustedError(this.usedInWindow(), this.dailyBudget);
    }
  }
}
