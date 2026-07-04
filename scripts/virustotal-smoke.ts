/**
 * Live end-to-end smoke test against the REAL VirusTotal public API.
 *
 * Exercises the exact production scan path (src/capabilities/file_scanner):
 *   1. A brand-new random file → cache miss → hash lookup 404 → UPLOAD → poll
 *      the analysis until completed. Proves the upload+poll loop and the
 *      rate limiter's spacing between calls.
 *   2. The EICAR anti-malware test string → VirusTotal already knows the hash,
 *      so it returns a verdict INSTANTLY via the hash lookup (no upload, no
 *      wait). Proves the hash-first fast path and the 🛑 malicious wording.
 *      (EICAR is a harmless industry-standard test file every AV engine flags.)
 *
 * Usage:  npx tsx scripts/virustotal-smoke.ts
 *
 * Does NOT run inside `pnpm test`. Makes real VirusTotal calls and spends a few
 * requests of the daily budget. Requires VIRUSTOTAL_API_KEY in .env.
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { SqliteMemoryStore, NamespacedMemory } from '../src/memory/store.js';
import { FileScannerStore, FILE_SCANNER_MIGRATIONS } from '../src/capabilities/file_scanner/store.js';
import { VirusTotalClient } from '../src/capabilities/file_scanner/virustotal.js';
import { ScanRateLimiter } from '../src/capabilities/file_scanner/rate-limiter.js';
import { FileScanner } from '../src/capabilities/file_scanner/scanner.js';
import { renderScanMessage } from '../src/capabilities/file_scanner/format.js';

// The canonical EICAR test string (68 bytes). Not real malware — a standard
// probe that every antivirus engine (and VirusTotal) reports as malicious.
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function main(): Promise<void> {
  if (!config.VIRUSTOTAL_API_KEY) {
    console.error('✗ VIRUSTOTAL_API_KEY not set in .env — cannot run the live smoke.');
    process.exit(1);
  }

  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'file_scanner').migrate('file_scanner', FILE_SCANNER_MIGRATIONS);
  const store = new FileScannerStore(mem.db());
  const client = new VirusTotalClient(config.VIRUSTOTAL_API_KEY);
  const limiter = new ScanRateLimiter({
    store,
    dailyBudget: config.VIRUSTOTAL_DAILY_REQUEST_BUDGET,
    minIntervalMs: config.VIRUSTOTAL_MIN_REQUEST_INTERVAL_MS,
  });
  const scanner = new FileScanner({
    client,
    limiter,
    store,
    maliciousThreshold: config.VIRUSTOTAL_MALICIOUS_THRESHOLD,
    maxPolls: config.VIRUSTOTAL_MAX_POLLS,
  });

  // 1. A unique random file — guaranteed unknown → upload + poll path.
  const rnd = new Uint8Array(2048);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  console.log('\n=== 1) Novel random file (upload + poll) ===');
  const t1 = Date.now();
  const out1 = await scanner.scanBytes(rnd, { fileName: 'chopperbot-smoke-random.bin', uploader: null });
  console.log(`took ${((Date.now() - t1) / 1000).toFixed(1)}s · budget used=${limiter.usedInWindow()}`);
  console.log(renderScanMessage([{ fileName: 'chopperbot-smoke-random.bin', status: out1 }]));

  // 2. EICAR — VirusTotal knows the hash → instant verdict via lookup.
  console.log('\n=== 2) EICAR test file (hash-first, should be instant 🛑) ===');
  const t2 = Date.now();
  const out2 = await scanner.scanBytes(new TextEncoder().encode(EICAR), {
    fileName: 'eicar.com',
    uploader: null,
  });
  console.log(`took ${((Date.now() - t2) / 1000).toFixed(1)}s · budget used=${limiter.usedInWindow()}`);
  console.log(renderScanMessage([{ fileName: 'eicar.com', status: out2 }]));

  const eicarOk = out2.kind === 'verdict' && out2.verdict === 'malicious';
  console.log(`\n${eicarOk ? '✓' : '✗'} EICAR classified as malicious: ${eicarOk}`);
  mem.close();
  process.exit(eicarOk ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
