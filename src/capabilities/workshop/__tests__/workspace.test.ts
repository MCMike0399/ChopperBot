import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeJoin, PathEscapeError, SessionWorkspace, workspaceDirFor, isDeliverablePath, listUndeliveredDeliverables } from '../workspace.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workshop-ws-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('safeJoin', () => {
  test('accepts normal relative paths (and creates nothing)', () => {
    expect(safeJoin('/ws', 'a.txt')).toBe('/ws/a.txt');
    expect(safeJoin('/ws', 'sub/dir/b.csv')).toBe('/ws/sub/dir/b.csv');
    expect(safeJoin('/ws', './c.md')).toBe('/ws/c.md');
  });

  test('strips leading slashes instead of treating them as absolute', () => {
    expect(safeJoin('/ws', '/etc/passwd')).toBe('/ws/etc/passwd');
  });

  test('rejects traversal, empty and null-byte paths', () => {
    expect(() => safeJoin('/ws', '../outside')).toThrow(PathEscapeError);
    expect(() => safeJoin('/ws', 'a/../../outside')).toThrow(PathEscapeError);
    expect(() => safeJoin('/ws', '..')).toThrow(PathEscapeError);
    expect(() => safeJoin('/ws', '')).toThrow(PathEscapeError);
    expect(() => safeJoin('/ws', 'a\0b')).toThrow(PathEscapeError);
  });

  test('rejects sneaky prefix escapes (/ws2 is not inside /ws)', () => {
    expect(() => safeJoin('/ws', '../ws2/file')).toThrow(PathEscapeError);
  });
});

describe('SessionWorkspace', () => {
  test('write/read/list round-trip, nested dirs, hidden .workshop excluded', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    ws.writeText('notes.md', 'hola');
    ws.writeText('sub/data.csv', 'a,b\n1,2');
    ws.writeText('.workshop/run.py', 'print(1)');

    const files = ws.list().map((f) => f.path);
    expect(files).toEqual(['notes.md', 'sub/data.csv']);

    const read = ws.readText('sub/data.csv', 1000);
    expect(read.content).toBe('a,b\n1,2');
    expect(read.truncated).toBe(false);
  });

  test('readText truncates at maxBytes', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    ws.writeText('big.txt', 'x'.repeat(100));
    const read = ws.readText('big.txt', 10);
    expect(read.content).toHaveLength(10);
    expect(read.truncated).toBe(true);
    expect(read.bytes).toBe(100);
  });

  test('list on a missing root returns []', () => {
    const ws = new SessionWorkspace(join(root, 'nope'));
    expect(ws.list()).toEqual([]);
  });
});

describe('workspaceDirFor', () => {
  test('builds the per-channel dir and rejects non-snowflake ids', () => {
    expect(workspaceDirFor('/data', '123456789012345678')).toBe(
      '/data/workshop/sessions/123456789012345678',
    );
    expect(() => workspaceDirFor('/data', '../evil')).toThrow();
    expect(() => workspaceDirFor('/data', 'abc')).toThrow();
  });
});

describe('isDeliverablePath', () => {
  test('deliverable extensions qualify, intermediates and uploads do not', () => {
    expect(isDeliverablePath('reporte.docx')).toBe(true);
    expect(isDeliverablePath('carpeta/grafica.PNG')).toBe(true);
    expect(isDeliverablePath('tabla.xlsx')).toBe(true);
    expect(isDeliverablePath('extracto.txt')).toBe(false);
    expect(isDeliverablePath('notas.md')).toBe(false);
    expect(isDeliverablePath('sin_extension')).toBe(false);
    expect(isDeliverablePath('uploads/libro.pdf')).toBe(false);
  });
});

describe('listUndeliveredDeliverables', () => {
  const file = (path: string, modifiedAt: number, bytes = 100) => ({ path, bytes, modifiedAt });

  test('returns deliverables created or rewritten this turn, minus skips', () => {
    const before = new Map<string, number>([
      ['viejo.docx', 1000], // untouched this turn
      ['editado.pdf', 1000],
      ['extracto.txt', 1000],
    ]);
    const after = [
      file('viejo.docx', 1000), // same mtime → not this turn
      file('editado.pdf', 2000), // rewritten this turn
      file('nuevo.xlsx', 2000), // created this turn
      file('extracto.txt', 2000), // changed but not a deliverable
      file('uploads/subida.pdf', 2000), // user upload, never a deliverable
      file('ya_enviado.docx', 2000), // created this turn but already recorded
    ];
    const skip = new Set(['ya_enviado.docx']);
    const found = listUndeliveredDeliverables(before, after, skip).map((f) => f.path);
    expect(found).toEqual(['editado.pdf', 'nuevo.xlsx']);
  });

  test('empty workspace yields nothing', () => {
    expect(listUndeliveredDeliverables(new Map(), [], new Set())).toEqual([]);
  });
});
