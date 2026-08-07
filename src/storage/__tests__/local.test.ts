import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStorage } from '../local.js';

const dirs: string[] = [];

function newStorage(): LocalObjectStorage {
  const dir = mkdtempSync(join(tmpdir(), 'objstore-test-'));
  dirs.push(dir);
  return new LocalObjectStorage(dir);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('LocalObjectStorage', () => {
  test('put → get → delete round-trip', async () => {
    const s = newStorage();
    const bytes = new TextEncoder().encode('contenido');
    await s.put('workshop/c1/uploads/a.txt', bytes);
    expect(await s.get('workshop/c1/uploads/a.txt')).toEqual(bytes);
    await s.delete('workshop/c1/uploads/a.txt');
    expect(await s.get('workshop/c1/uploads/a.txt')).toBeNull();
    // Deleting a missing key is not an error.
    await s.delete('workshop/c1/uploads/a.txt');
  });

  test('get of a missing key is null', async () => {
    expect(await newStorage().get('nope')).toBeNull();
  });

  test('deletePrefix removes everything under the prefix only', async () => {
    const s = newStorage();
    await s.put('workshop/c1/a', new Uint8Array([1]));
    await s.put('workshop/c1/sub/b', new Uint8Array([2]));
    await s.put('workshop/c2/c', new Uint8Array([3]));
    expect(await s.deletePrefix('workshop/c1/')).toBe(2);
    expect(await s.get('workshop/c1/a')).toBeNull();
    expect(await s.get('workshop/c2/c')).toEqual(new Uint8Array([3]));
    expect(await s.deletePrefix('workshop/c1/')).toBe(0);
  });

  test('keys cannot escape the root', async () => {
    const s = newStorage();
    await expect(s.put('../evil', new Uint8Array([1]))).rejects.toThrow(/escapes/);
    // Leading slashes are stripped (same semantics as the workshop's safeJoin),
    // so an absolute-looking path just resolves INSIDE the root → a miss.
    expect(await s.get('/etc/passwd')).toBeNull();
  });

  test('ensureReady creates the root and reports true', async () => {
    const s = newStorage();
    expect(await s.ensureReady()).toBe(true);
  });
});
