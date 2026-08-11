import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWorkspace } from '../workspace.js';
import { sandboxAvailable } from '../sandbox.js';
import {
  buildIndexerScript,
  docIndexDirFor,
  ensureDocIndex,
  excerptAround,
  parseIndexerOutput,
  readDocChunks,
  readDocIndex,
  searchChunks,
  type DocChunk,
} from '../docindex.js';

const chunk = (id: number, text: string, heading: string | null = null, page = 1): DocChunk => ({
  id,
  page_start: page,
  page_end: page,
  heading,
  text,
});

describe('docIndexDirFor', () => {
  test('deterministic, filesystem-safe, collision-resistant', () => {
    const a = docIndexDirFor('uploads/Federici libro (2011).pdf');
    expect(a).toBe(docIndexDirFor('uploads/Federici libro (2011).pdf'));
    expect(a).toMatch(/^\.docindex\/[a-z0-9_]+-[0-9a-f]+$/);
    expect(a).not.toBe(docIndexDirFor('uploads/otro.pdf'));
  });
});

describe('parseIndexerOutput', () => {
  test('finds the result line among other stdout noise', () => {
    const out = 'warning: something\nDOCINDEX_RESULT {"ok": true, "pages": 3, "chars": 900, "chunks": 2, "outline_entries": 1}\n';
    expect(parseIndexerOutput(out)).toEqual({ ok: true, pages: 3, chars: 900, chunks: 2, outline_entries: 1 });
  });
  test('null on missing or corrupt line', () => {
    expect(parseIndexerOutput('no result here')).toBeNull();
    expect(parseIndexerOutput('DOCINDEX_RESULT {broken')).toBeNull();
  });
});

describe('buildIndexerScript', () => {
  test('injects parameters as JSON (no injection through weird filenames)', () => {
    const script = buildIndexerScript({
      sourceRel: 'uploads/raro "nombre".pdf',
      outDirRel: '.docindex/x-1',
      sourceKey: '10:20',
    });
    expect(script).toContain('json.loads(');
    // The quoted filename survives double-JSON-encoding intact.
    expect(script).toContain('raro');
    expect(script).not.toContain('import os, sys; os.system');
  });
});

describe('searchChunks (lexical retrieval)', () => {
  const corpus = [
    chunk(0, 'La caza de brujas fue un instrumento de disciplinamiento del cuerpo femenino.', 'CAPÍTULO 4', 120),
    chunk(1, 'El feudalismo entró en crisis por las revueltas campesinas y la peste negra.', 'CAPÍTULO 1', 20),
    chunk(2, 'La acumulación primitiva requirió la separación del campesinado de la tierra común.', 'CAPÍTULO 2', 60),
    chunk(3, 'Recetario: mezclar harina y agua hasta obtener una masa homogénea.', null, 200),
  ];

  test('ranks the on-topic chunk first, accent- and case-insensitive', () => {
    const hits = searchChunks(corpus, '¿Qué dice sobre la caza de BRUJAS?', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.id).toBe(0);
  });

  test('irrelevant queries return nothing (score 0 filtered)', () => {
    expect(searchChunks(corpus, 'fotosíntesis clorofila', 3)).toHaveLength(0);
  });

  test('stopword-only queries return nothing instead of noise', () => {
    expect(searchChunks(corpus, 'de la el en', 3)).toHaveLength(0);
  });

  test('respects k', () => {
    const hits = searchChunks(corpus, 'campesinado revueltas tierra crisis', 1);
    expect(hits).toHaveLength(1);
  });
});

describe('excerptAround', () => {
  test('returns short text unchanged', () => {
    expect(excerptAround('corto', 'algo', 100)).toBe('corto');
  });
  test('centers the window on the first query hit and marks the cuts', () => {
    const text = `${'x'.repeat(500)} brujas ${'y'.repeat(500)}`;
    const out = excerptAround(text, 'brujas', 120);
    expect(out.length).toBeLessThanOrEqual(122 + 2);
    expect(out).toContain('brujas');
    expect(out.startsWith('…')).toBe(true);
  });
});

describe.skipIf(!sandboxAvailable())('ensureDocIndex (real sandbox)', () => {
  test('indexes a txt document end-to-end: meta, chunks, outline, freshness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docindex-'));
    try {
      const ws = new SessionWorkspace(root);
      ws.ensure();
      mkdirSync(join(root, 'uploads'), { recursive: true });
      const body =
        'CAPÍTULO 1. LA CRISIS\n\n' +
        `${'El feudalismo entró en crisis. '.repeat(40)}\n\n` +
        'CAPÍTULO 2. LA TRANSICIÓN\n\n' +
        `${'La acumulación primitiva transformó el campo. '.repeat(40)}\n`;
      writeFileSync(join(root, 'uploads', 'libro.txt'), body, 'utf-8');

      const built = await ensureDocIndex({
        workspace: ws,
        sourceRel: 'uploads/libro.txt',
        venvDir: null,
        timeoutMs: 30_000,
      });
      expect('error' in built).toBe(false);
      if ('error' in built) return;
      expect(built.meta.pages).toBe(1);
      expect(built.meta.chunks).toBeGreaterThan(1);
      expect(built.meta.outline.map((o) => o.heading)).toEqual([
        'CAPÍTULO 1. LA CRISIS',
        'CAPÍTULO 2. LA TRANSICIÓN',
      ]);

      const chunks = readDocChunks(ws, built.dir);
      expect(chunks.length).toBe(built.meta.chunks);
      const hit = searchChunks(chunks, 'acumulación primitiva', 1);
      expect(hit[0].chunk.heading).toBe('CAPÍTULO 2. LA TRANSICIÓN');

      // Fresh source → reuses the index without a rebuild (same meta).
      const again = await ensureDocIndex({
        workspace: ws,
        sourceRel: 'uploads/libro.txt',
        venvDir: null,
        timeoutMs: 30_000,
      });
      expect('error' in again).toBe(false);

      // The index is hidden from the model's listing.
      expect(ws.list().every((f) => !f.path.startsWith('.docindex'))).toBe(true);
      expect(readDocIndex(ws, 'uploads/libro.txt')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('unsupported extension and missing file are clean Spanish errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docindex-'));
    try {
      const ws = new SessionWorkspace(root);
      ws.ensure();
      writeFileSync(join(root, 'datos.xlsx'), 'not really xlsx', 'utf-8');
      const bad = await ensureDocIndex({ workspace: ws, sourceRel: 'datos.xlsx', venvDir: null, timeoutMs: 10_000 });
      expect(bad).toHaveProperty('error');
      const missing = await ensureDocIndex({ workspace: ws, sourceRel: 'no-existe.pdf', venvDir: null, timeoutMs: 10_000 });
      expect(missing).toHaveProperty('error');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
