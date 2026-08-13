import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeJoin, PathEscapeError, SessionWorkspace, workspaceDirFor, isDeliverablePath, listUndeliveredDeliverables } from '../workspace.js';

let root: string;
/** Stands in for the host secrets a workspace escape would reach (.env, dist/). */
let outside: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'workshop-ws-'));
  root = join(base, 'session');
  outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
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

/**
 * The escape `safeJoin` cannot see. Sandboxed python can't read the host, but
 * it CAN drop a symlink inside its own workspace — and the file tools run in
 * the bot process, where `readFileSync` happily follows it. Left unguarded,
 * `os.symlink('../../.env', 'loot.pdf')` + `workshop_send_file loot.pdf` mails
 * DISCORD_TOKEN to a Discord channel, and a write through a link to
 * `dist/index.js` is code execution as the bot on the next restart.
 */
describe('SessionWorkspace — symlink containment', () => {
  const secret = () => {
    const p = join(outside, 'secret.env');
    writeFileSync(p, 'DISCORD_TOKEN=supersecreto\n', 'utf-8');
    return p;
  };

  test('reading through a symlink to a host file is refused (no token exfiltration)', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    symlinkSync(secret(), join(root, 'loot.pdf'));

    expect(() => ws.readText('loot.pdf', 10_000)).toThrow(PathEscapeError);
    expect(() => ws.readBytes('loot.pdf')).toThrow(PathEscapeError);
    expect(() => ws.absolute('loot.pdf')).toThrow(PathEscapeError);
    expect(() => ws.stat('loot.pdf')).toThrow(PathEscapeError);
    expect(() => ws.exists('loot.pdf')).toThrow(PathEscapeError);
  });

  test('writing through a symlink cannot modify a file outside the workspace', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    const target = join(outside, 'index.js');
    writeFileSync(target, 'original', 'utf-8');
    symlinkSync(target, join(root, 'payload.js'));

    expect(() => ws.writeText('payload.js', 'malicious')).toThrow(PathEscapeError);
    expect(() => ws.writeBytes('payload.js', new Uint8Array([1, 2, 3]))).toThrow(PathEscapeError);
    expect(readFileSync(target, 'utf-8')).toBe('original');
  });

  test('a symlinked DIRECTORY component is refused too (the whole path is walked)', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    symlinkSync(outside, join(root, 'escape'));
    writeFileSync(join(outside, 'nota.txt'), 'de afuera', 'utf-8');

    expect(() => ws.readText('escape/nota.txt', 1000)).toThrow(PathEscapeError);
    expect(() => ws.writeText('escape/nuevo.txt', 'x')).toThrow(PathEscapeError);
    // …and nothing was created out there on the way to failing.
    expect(() => readFileSync(join(outside, 'nuevo.txt'))).toThrow();
  });

  test('a symlink pointing INSIDE the workspace is refused as well (flat ban)', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    ws.writeText('real.txt', 'contenido');
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'));

    expect(() => ws.readText('alias.txt', 1000)).toThrow(PathEscapeError);
    expect(ws.readText('real.txt', 1000).content).toBe('contenido'); // the real file still works
  });

  test('symlinks never appear in listings (so the model is never offered one)', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    ws.writeText('informe.docx', 'x');
    symlinkSync(secret(), join(root, 'loot.pdf'));
    symlinkSync(outside, join(root, 'escape'));

    expect(ws.list().map((f) => f.path)).toEqual(['informe.docx']);
  });

  test('ordinary files, nested dirs and overwrites keep working', () => {
    const ws = new SessionWorkspace(root);
    ws.ensure();
    ws.writeText('sub/dir/a.txt', 'uno');
    ws.writeText('sub/dir/a.txt', 'dos'); // overwrite truncates, no leftovers
    ws.writeBytes('bin.dat', new Uint8Array([7, 8, 9]));

    expect(ws.readText('sub/dir/a.txt', 100).content).toBe('dos');
    expect([...ws.readBytes('bin.dat')]).toEqual([7, 8, 9]);
    expect(ws.stat('bin.dat').bytes).toBe(3);
    expect(ws.exists('sub/dir/a.txt')).toBe(true);
    expect(ws.exists('sub/dir/falta.txt')).toBe(false);
    ws.remove('bin.dat');
    expect(ws.exists('bin.dat')).toBe(false);
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
