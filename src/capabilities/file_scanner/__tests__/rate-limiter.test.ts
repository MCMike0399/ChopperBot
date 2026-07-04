import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { FileScannerStore, FILE_SCANNER_MIGRATIONS } from '../store.js';
import { ScanRateLimiter, BudgetExhaustedError, QueueFullError } from '../rate-limiter.js';

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'file_scanner').migrate('file_scanner', FILE_SCANNER_MIGRATIONS);
  return { store: new FileScannerStore(mem.db()), mem };
}

/** Fake clock whose `sleep` advances virtual time — no real waiting. */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('ScanRateLimiter', () => {
  test('runs jobs in order, spaced by minIntervalMs', async () => {
    const { store, mem } = await newStore();
    const clock = fakeClock();
    const limiter = new ScanRateLimiter({
      store,
      dailyBudget: 100,
      minIntervalMs: 16_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const stamps = await Promise.all(
      [0, 1, 2].map((i) => limiter.schedule(`j${i}`, async () => clock.now())),
    );
    expect(stamps[1] - stamps[0]).toBe(16_000);
    expect(stamps[2] - stamps[1]).toBe(16_000);
    mem.close();
  });

  test('rejects with BudgetExhaustedError once the daily budget is spent', async () => {
    const { store, mem } = await newStore();
    const clock = fakeClock();
    const limiter = new ScanRateLimiter({
      store,
      dailyBudget: 2,
      minIntervalMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) => limiter.schedule(`j${i}`, async () => i)),
    );
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('rejected');
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExhaustedError);
    mem.close();
  });

  test('rejects with QueueFullError past max queue depth', async () => {
    const { store, mem } = await newStore();
    const clock = fakeClock();
    const limiter = new ScanRateLimiter({
      store,
      dailyBudget: 100,
      minIntervalMs: 0,
      maxQueueDepth: 2,
      now: clock.now,
      sleep: clock.sleep,
    });
    // Schedule 3 synchronously before any resolves: the 3rd exceeds depth 2.
    const p1 = limiter.schedule('a', async () => 1);
    const p2 = limiter.schedule('b', async () => 2);
    const p3 = limiter.schedule('c', async () => 3);
    const settled = await Promise.allSettled([p1, p2, p3]);
    expect(settled[2].status).toBe('rejected');
    expect((settled[2] as PromiseRejectedResult).reason).toBeInstanceOf(QueueFullError);
    mem.close();
  });

  test('one job rejecting does not stall later jobs', async () => {
    const { store, mem } = await newStore();
    const clock = fakeClock();
    const limiter = new ScanRateLimiter({
      store,
      dailyBudget: 100,
      minIntervalMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });
    const p1 = limiter.schedule('a', async () => {
      throw new Error('boom');
    });
    const p2 = limiter.schedule('b', async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    mem.close();
  });
});
