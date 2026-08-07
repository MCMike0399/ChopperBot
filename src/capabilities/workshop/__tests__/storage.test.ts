import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStorage } from '../../../storage/object-storage.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { WorkshopStore, WORKSHOP_MIGRATIONS } from '../store.js';
import { SessionWorkspace } from '../workspace.js';
import {
  deleteSessionObjects,
  restoreFromStorage,
  storageKeyFor,
  uploadToStorage,
} from '../storage.js';

/** In-memory ObjectStorage with an optional failure switch. */
class FakeStorage implements ObjectStorage {
  readonly backend = 'fake';
  readonly objects = new Map<string, Uint8Array>();
  failNext = false;

  private maybeFail(): void {
    if (this.failNext) throw new Error('storage down');
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.maybeFail();
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.maybeFail();
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.maybeFail();
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.maybeFail();
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) {
        this.objects.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async ensureReady(): Promise<boolean> {
    return true;
  }
}

const dirs: string[] = [];

function newWorkspace(): SessionWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'ws-storage-test-'));
  dirs.push(dir);
  return new SessionWorkspace(dir);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'workshop').migrate('workshop', WORKSHOP_MIGRATIONS);
  return { store: new WorkshopStore(mem.db()), mem };
}

describe('workshop storage glue', () => {
  test('storageKeyFor is deterministic and session-scoped', () => {
    expect(storageKeyFor('123', 'uploads/libro.pdf')).toBe('workshop/123/uploads/libro.pdf');
  });

  test('uploadToStorage stores the bytes and records the key', async () => {
    const { store, mem } = await newStore();
    store.createSession({ channelId: 'c1', guildId: 'g1', userId: 'u1', userTag: 'u#1', nowMs: 1 });
    store.recordFile({ channelId: 'c1', relPath: 'a.txt', messageId: 'm1', bytes: 2, nowMs: 1 });
    const storage = new FakeStorage();

    const ok = await uploadToStorage(storage, store, {
      channelId: 'c1',
      relPath: 'a.txt',
      bytes: new Uint8Array([7, 8]),
    });

    expect(ok).toBe(true);
    expect(storage.objects.get('workshop/c1/a.txt')).toEqual(new Uint8Array([7, 8]));
    expect(store.fileManifest('c1')[0]!.storage_key).toBe('workshop/c1/a.txt');
    mem.close();
  });

  test('uploadToStorage failure: returns false, keeps storage_key NULL, never throws', async () => {
    const { store, mem } = await newStore();
    store.createSession({ channelId: 'c1', guildId: 'g1', userId: 'u1', userTag: 'u#1', nowMs: 1 });
    store.recordFile({ channelId: 'c1', relPath: 'a.txt', messageId: 'm1', bytes: 2, nowMs: 1 });
    const storage = new FakeStorage();
    storage.failNext = true;

    const ok = await uploadToStorage(storage, store, {
      channelId: 'c1',
      relPath: 'a.txt',
      bytes: new Uint8Array([7]),
    });

    expect(ok).toBe(false);
    expect(store.fileManifest('c1')[0]!.storage_key).toBeNull();
    mem.close();
  });

  test('restoreFromStorage writes the object into the workspace', async () => {
    const { store, mem } = await newStore();
    const ws = newWorkspace();
    store.createSession({ channelId: 'c1', guildId: 'g1', userId: 'u1', userTag: 'u#1', nowMs: 1 });
    store.recordFile({ channelId: 'c1', relPath: 'uploads/a.bin', messageId: 'm1', bytes: 3, nowMs: 1 });
    store.setStorageKey('c1', 'uploads/a.bin', 'workshop/c1/uploads/a.bin');
    const storage = new FakeStorage();
    storage.objects.set('workshop/c1/uploads/a.bin', new Uint8Array([1, 2, 3]));

    const rec = store.fileManifest('c1')[0]!;
    const bytes = await restoreFromStorage(storage, ws, rec);

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(ws.exists('uploads/a.bin')).toBe(true);
    mem.close();
  });

  test('restoreFromStorage: no key, missing object or a down backend → null (caller falls back)', async () => {
    const { store, mem } = await newStore();
    const ws = newWorkspace();
    store.createSession({ channelId: 'c1', guildId: 'g1', userId: 'u1', userTag: 'u#1', nowMs: 1 });
    store.recordFile({ channelId: 'c1', relPath: 'a.txt', messageId: 'm1', bytes: 1, nowMs: 1 });
    const storage = new FakeStorage();

    // NULL storage_key
    expect(await restoreFromStorage(storage, ws, store.fileManifest('c1')[0]!)).toBeNull();

    // Key recorded but object absent
    store.setStorageKey('c1', 'a.txt', 'workshop/c1/a.txt');
    expect(await restoreFromStorage(storage, ws, store.fileManifest('c1')[0]!)).toBeNull();

    // Backend down — caught, not thrown
    storage.failNext = true;
    expect(await restoreFromStorage(storage, ws, store.fileManifest('c1')[0]!)).toBeNull();
    expect(ws.exists('a.txt')).toBe(false);
    mem.close();
  });

  test('deleteSessionObjects removes the session prefix; a down backend → 0, never throws', async () => {
    const storage = new FakeStorage();
    storage.objects.set('workshop/c1/a', new Uint8Array([1]));
    storage.objects.set('workshop/c1/b', new Uint8Array([2]));
    storage.objects.set('workshop/c2/c', new Uint8Array([3]));

    expect(await deleteSessionObjects(storage, 'c1')).toBe(2);
    expect([...storage.objects.keys()]).toEqual(['workshop/c2/c']);

    storage.failNext = true;
    expect(await deleteSessionObjects(storage, 'c2')).toBe(0);
  });
});
