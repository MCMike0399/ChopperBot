import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { FileScannerStore, FILE_SCANNER_MIGRATIONS, parseChannelIdEnv } from '../store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'file_scanner').migrate('file_scanner', FILE_SCANNER_MIGRATIONS);
  return { store: new FileScannerStore(mem.db()), mem };
}

describe('FileScannerStore watched channels', () => {
  test('seed only writes when empty; later edits survive re-seed', async () => {
    const { store, mem } = await newStore();
    store.seedWatchedChannels(['111', '222']);
    expect(store.getWatchedChannels()).toEqual(['111', '222']);
    // Operator narrows the list...
    store.setWatchedChannels(['999']);
    // ...a restart re-seeds from env, but must NOT clobber the DB value.
    store.seedWatchedChannels(['111', '222']);
    expect(store.getWatchedChannels()).toEqual(['999']);
    mem.close();
  });

  test('setWatchedChannels dedupes and trims', async () => {
    const { store, mem } = await newStore();
    store.setWatchedChannels([' 1 ', '1', '2', '']);
    expect(store.getWatchedChannels()).toEqual(['1', '2']);
    mem.close();
  });
});

describe('FileScannerStore rolling budget', () => {
  test('tryConsumeBudget grants until budget, then rejects, then frees as window drains', async () => {
    const { store, mem } = await newStore();
    const t0 = 1_000_000_000_000;
    expect(store.tryConsumeBudget(t0, 2, DAY)).toBe(true);
    expect(store.tryConsumeBudget(t0 + 1000, 2, DAY)).toBe(true);
    expect(store.tryConsumeBudget(t0 + 2000, 2, DAY)).toBe(false); // full
    expect(store.requestsInWindow(t0 + 2000, DAY)).toBe(2);
    // 25h later the two old timestamps have aged out of the 24h window.
    expect(store.tryConsumeBudget(t0 + 25 * HOUR, 2, DAY)).toBe(true);
    expect(store.requestsInWindow(t0 + 25 * HOUR, DAY)).toBe(1);
    mem.close();
  });
});

describe('FileScannerStore scan cache', () => {
  test('recordScan inserts then upserts (bumps scan_count)', async () => {
    const { store, mem } = await newStore();
    const stats = { malicious: 3, suspicious: 0, harmless: 60, undetected: 5, total: 68 };
    store.recordScan({ sha256: 'abc', fileName: 'f.exe', size: 10, verdict: 'malicious', stats, uploader: 'U1', nowMs: 1 });
    store.recordScan({ sha256: 'abc', fileName: 'f.exe', size: 10, verdict: 'malicious', stats, uploader: 'U2', nowMs: 2 });
    const rec = store.getScan('abc')!;
    expect(rec.verdict).toBe('malicious');
    expect(rec.scan_count).toBe(2);
    expect(rec.last_uploader).toBe('U2');
    expect(store.verdictCounts()).toMatchObject({ total: 1, malicious: 1, suspicious: 0, clean: 0 });
    mem.close();
  });
});

describe('parseChannelIdEnv', () => {
  test('parses JSON array and delimited lists', () => {
    expect(parseChannelIdEnv('["1","2"]')).toEqual(['1', '2']);
    expect(parseChannelIdEnv('1, 2  3')).toEqual(['1', '2', '3']);
    expect(parseChannelIdEnv(undefined)).toEqual([]);
    expect(parseChannelIdEnv('')).toEqual([]);
  });
});
