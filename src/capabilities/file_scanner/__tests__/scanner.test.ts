import { describe, test, expect, vi } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { FileScannerStore, FILE_SCANNER_MIGRATIONS } from '../store.js';
import { ScanRateLimiter } from '../rate-limiter.js';
import { FileScanner } from '../scanner.js';
import type { VirusTotalClient } from '../virustotal.js';

async function harness(overrides: {
  client: Partial<VirusTotalClient>;
  dailyBudget?: number;
  maxPolls?: number;
}) {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'file_scanner').migrate('file_scanner', FILE_SCANNER_MIGRATIONS);
  const store = new FileScannerStore(mem.db());
  const limiter = new ScanRateLimiter({
    store,
    dailyBudget: overrides.dailyBudget ?? 100,
    minIntervalMs: 0,
    now: () => 1_000,
    sleep: async () => {},
  });
  const scanner = new FileScanner({
    client: overrides.client as VirusTotalClient,
    limiter,
    store,
    maliciousThreshold: 2,
    maxPolls: overrides.maxPolls ?? 5,
    now: () => 1_000,
  });
  return { store, scanner, mem };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);
const CLEAN = { malicious: 0, suspicious: 0, harmless: 70, undetected: 5 };
const BAD = { malicious: 40, suspicious: 2, harmless: 10, undetected: 5 };

describe('FileScanner', () => {
  test('cache hit returns verdict without calling VirusTotal', async () => {
    const lookupByHash = vi.fn();
    const { store, scanner, mem } = await harness({ client: { lookupByHash } });
    const sha = FileScanner.sha256(BYTES);
    store.recordScan({
      sha256: sha,
      fileName: 'x',
      size: 4,
      verdict: 'malicious',
      stats: { ...BAD, total: 57 },
      uploader: null,
      nowMs: 1,
    });
    const out = await scanner.scanBytes(BYTES, { fileName: 'x.exe', uploader: 'U' });
    expect(out).toMatchObject({ kind: 'verdict', verdict: 'malicious', source: 'cache' });
    expect(lookupByHash).not.toHaveBeenCalled();
    mem.close();
  });

  test('hash lookup hit → verdict, persisted, no upload', async () => {
    const lookupByHash = vi.fn().mockResolvedValue({ ...CLEAN, total: 75 });
    const uploadFile = vi.fn();
    const { store, scanner, mem } = await harness({ client: { lookupByHash, uploadFile } });
    const out = await scanner.scanBytes(BYTES, { fileName: 'ok.pdf', uploader: 'U' });
    expect(out).toMatchObject({ kind: 'verdict', verdict: 'clean', source: 'hash' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(store.getScan(FileScanner.sha256(BYTES))?.verdict).toBe('clean');
    mem.close();
  });

  test('unknown file → upload then poll until completed', async () => {
    const lookupByHash = vi.fn().mockResolvedValue(null);
    const uploadFile = vi.fn().mockResolvedValue('analysis-1');
    const getAnalysis = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued', stats: null })
      .mockResolvedValueOnce({ status: 'completed', stats: { ...BAD, total: 57 } });
    const { scanner, mem } = await harness({ client: { lookupByHash, uploadFile, getAnalysis } });
    const out = await scanner.scanBytes(BYTES, { fileName: 'mal.exe', uploader: 'U' });
    expect(out).toMatchObject({ kind: 'verdict', verdict: 'malicious', source: 'analysis' });
    expect(getAnalysis).toHaveBeenCalledTimes(2);
    mem.close();
  });

  test('analysis never completes within maxPolls → pending', async () => {
    const lookupByHash = vi.fn().mockResolvedValue(null);
    const uploadFile = vi.fn().mockResolvedValue('a1');
    const getAnalysis = vi.fn().mockResolvedValue({ status: 'queued', stats: null });
    const { scanner, mem } = await harness({
      client: { lookupByHash, uploadFile, getAnalysis },
      maxPolls: 3,
    });
    const out = await scanner.scanBytes(BYTES, { fileName: 'slow.bin', uploader: null });
    expect(out.kind).toBe('pending');
    expect(getAnalysis).toHaveBeenCalledTimes(3);
    mem.close();
  });

  test('budget exhausted surfaces as budget_exhausted outcome', async () => {
    const lookupByHash = vi.fn().mockResolvedValue({ ...CLEAN, total: 75 });
    const { scanner, mem } = await harness({ client: { lookupByHash }, dailyBudget: 0 });
    const out = await scanner.scanBytes(BYTES, { fileName: 'x.zip', uploader: null });
    expect(out.kind).toBe('budget_exhausted');
    expect(lookupByHash).not.toHaveBeenCalled();
    mem.close();
  });
});
