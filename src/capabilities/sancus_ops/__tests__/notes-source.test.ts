import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { SancusOpsStore, SANCUS_OPS_MIGRATIONS } from '../store.js';
import { SancusOpsNotesToolSource } from '../notes-source.js';
import { SANCUS_OPS_CAPABILITY_ID } from '../constants.js';

const CH = '10000000000000000001';
const USER = '20000000000000000009';

async function newSource(channelId = CH) {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, SANCUS_OPS_CAPABILITY_ID).migrate(
    SANCUS_OPS_CAPABILITY_ID,
    SANCUS_OPS_MIGRATIONS,
  );
  const store = new SancusOpsStore(mem.db());
  const source = new SancusOpsNotesToolSource({ store, channelId, userId: USER, nowMs: 1_000 });
  return { source, store, mem };
}

describe('SancusOpsNotesToolSource', () => {
  test('exposes remember/recall/forget and no mutating platform tool', async () => {
    const { source, mem } = await newSource();
    const names = source.tools().map((t) => t.name).sort();
    expect(names).toEqual(['forget', 'recall', 'remember']);
    mem.close();
  });

  test('remember persists a note and normalizes tags to lowercase tokens', async () => {
    const { source, store, mem } = await newSource();
    const out = await source.handle('remember', { note: 'incidente Dock', tags: 'Dock, QA' });
    expect(out.status).toBe('success');
    const saved = store.recentNotes(CH, 10);
    expect(saved).toHaveLength(1);
    expect(saved[0].tags).toBe('dock qa');
    mem.close();
  });

  test('remember rejects an empty note', async () => {
    const { source, mem } = await newSource();
    const out = await source.handle('remember', { note: '   ' });
    expect(out.status).toBe('error');
    mem.close();
  });

  test('recall without query returns recent notes; with query filters', async () => {
    const { source, mem } = await newSource();
    await source.handle('remember', { note: 'latencia Fintoc', tags: 'fintoc' });
    await source.handle('remember', { note: 'error Mambu', tags: 'mambu' });
    const all = await source.handle('recall', {});
    expect((all.payload as any).count).toBe(2);
    const filtered = await source.handle('recall', { query: 'fintoc' });
    expect((filtered.payload as any).count).toBe(1);
    mem.close();
  });

  test('recall is scoped to the calling channel', async () => {
    const a = await newSource('11111111111111111111');
    await a.source.handle('remember', { note: 'sala A' });
    // A second source over the SAME db but a different channel sees nothing.
    const bSource = new SancusOpsNotesToolSource({
      store: a.store,
      channelId: '22222222222222222222',
      userId: USER,
      nowMs: 2_000,
    });
    const out = await bSource.handle('recall', {});
    expect((out.payload as any).count).toBe(0);
    a.mem.close();
  });

  test('forget removes by id and refuses a nonexistent id', async () => {
    const { source, mem } = await newSource();
    const saved = await source.handle('remember', { note: 'borrable' });
    const id = (saved.payload as any).saved.id;
    expect((await source.handle('forget', { id: 999999 })).status).toBe('error');
    expect((await source.handle('forget', { id })).status).toBe('success');
    mem.close();
  });
});
