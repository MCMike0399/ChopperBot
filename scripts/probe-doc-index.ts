/**
 * Proof/experiment script for the workshop document-index skill (docindex.ts).
 * Builds the index for a real document in a THROWAWAY temp workspace (touches
 * no session state), prints the outline, then runs sample searches and a
 * page-range read — the exact operations the workshop_doc_* tools expose.
 *
 *   # a local file:
 *   npx tsx scripts/probe-doc-index.ts /path/to/doc.pdf "consulta de prueba"
 *
 *   # a stored workshop file (pulled from MinIO):
 *   npx tsx scripts/probe-doc-index.ts minio:<channelId>/<relPath> "consulta"
 */
import 'dotenv/config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SessionWorkspace } from '../src/capabilities/workshop/workspace.js';
import {
  ensureDocIndex,
  readDocChunks,
  searchChunks,
  excerptAround,
} from '../src/capabilities/workshop/docindex.js';
import { createObjectStorage } from '../src/storage/index.js';

const source = process.argv[2];
const query = process.argv[3] ?? 'acumulación primitiva';
if (!source) {
  console.error('usage: npx tsx scripts/probe-doc-index.ts <file|minio:channel/relPath> [query]');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'probe-docindex-'));
try {
  let fileName: string;
  let bytes: Uint8Array;
  if (source.startsWith('minio:')) {
    const key = `workshop/${source.slice('minio:'.length)}`;
    const storage = createObjectStorage();
    if (!storage) throw new Error('MinIO no configurado (MINIO_ACCESS_KEY/SECRET).');
    const got = await storage.get(key);
    if (!got) throw new Error(`Objeto no encontrado: ${key}`);
    bytes = got;
    fileName = basename(key);
    storage.destroy?.();
  } else {
    bytes = readFileSync(source);
    fileName = basename(source);
  }
  // Match the workshop's real layout: the source under uploads/.
  const ws = new SessionWorkspace(root);
  ws.ensure();
  mkdirSync(join(root, 'uploads'), { recursive: true });
  const rel = `uploads/${fileName.endsWith('.pdf') || /\.(docx|txt|md)$/i.test(fileName) ? fileName : `${fileName}.pdf`}`;
  writeFileSync(join(root, rel), bytes);
  console.log(`source: ${rel} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

  const venvDir = resolve('data/workshop/venv');
  const t0 = Date.now();
  const built = await ensureDocIndex({ workspace: ws, sourceRel: rel, venvDir, timeoutMs: 120_000 });
  if ('error' in built) throw new Error(built.error);
  console.log(`indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s → pages=${built.meta.pages} chars=${built.meta.chars} chunks=${built.meta.chunks}`);
  console.log(`outline (${built.meta.outline.length} entries):`);
  for (const o of built.meta.outline.slice(0, 30)) {
    console.log(`  p.${String(o.page).padStart(4)}  ${o.heading}`);
  }

  const chunks = readDocChunks(ws, built.dir);
  const t1 = Date.now();
  const hits = searchChunks(chunks, query, 4);
  console.log(`\nsearch "${query}" (${Date.now() - t1}ms, ${hits.length} hits):`);
  for (const h of hits) {
    console.log(`  [pp. ${h.chunk.page_start}–${h.chunk.page_end}] score=${h.score.toFixed(2)} ${h.chunk.heading ?? ''}`);
    console.log(`    ${excerptAround(h.chunk.text, query, 220).replace(/\n/g, ' ')}`);
  }

  const mid = Math.floor(built.meta.pages / 2);
  const range = chunks.filter((c) => c.page_end >= mid && c.page_start <= mid + 3);
  console.log(`\nread pages ${mid}–${mid + 3}: ${range.length} chunks, ${range.reduce((a, c) => a + c.text.length, 0)} chars`);
  console.log('\n✅ doc-index probe OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
