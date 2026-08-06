import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeJoin, PathEscapeError, SessionWorkspace, workspaceDirFor } from '../workspace.js';

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
