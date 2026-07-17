import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { SancusOpsStore, SANCUS_OPS_MIGRATIONS } from '../store.js';
import { SANCUS_OPS_CAPABILITY_ID } from '../constants.js';

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, SANCUS_OPS_CAPABILITY_ID).migrate(
    SANCUS_OPS_CAPABILITY_ID,
    SANCUS_OPS_MIGRATIONS,
  );
  return { store: new SancusOpsStore(mem.db()), mem };
}

const CH_A = '10000000000000000001';
const CH_B = '10000000000000000002';

describe('SancusOpsStore migration + notes', () => {
  test('migration creates the sancus_ops_notes table and index', async () => {
    const { mem } = await newStore();
    const tables = mem
      .db()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sancus_ops_notes'`)
      .all();
    expect(tables).toHaveLength(1);
    const idx = mem
      .db()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='sancus_ops_notes_channel_time'`)
      .all();
    expect(idx).toHaveLength(1);
    mem.close();
  });

  test('migration is idempotent (re-running applies no duplicate)', async () => {
    const mem = new SqliteMemoryStore({ path: ':memory:' });
    const ns = new NamespacedMemory(mem, SANCUS_OPS_CAPABILITY_ID);
    await ns.migrate(SANCUS_OPS_CAPABILITY_ID, SANCUS_OPS_MIGRATIONS);
    await ns.migrate(SANCUS_OPS_CAPABILITY_ID, SANCUS_OPS_MIGRATIONS);
    const applied = mem
      .db()
      .prepare(`SELECT COUNT(*) as n FROM _migrations WHERE capability = ?`)
      .get(SANCUS_OPS_CAPABILITY_ID) as { n: number };
    expect(applied.n).toBe(SANCUS_OPS_MIGRATIONS.length);
    mem.close();
  });

  test('addNote persists and getById returns it with normalized fields', async () => {
    const { store, mem } = await newStore();
    const saved = store.addNote({
      channel_id: CH_A,
      note: 'Dock sin bootstrap en qa causó los 500s del martes',
      tags: 'dock qa',
      created_by: 'U1',
      now_ms: 1_000,
    });
    expect(saved.id).toBeGreaterThan(0);
    expect(store.getById(saved.id)?.note).toContain('Dock sin bootstrap');
    expect(saved.tags).toBe('dock qa');
    mem.close();
  });

  test('recentNotes is per-channel and newest-first', async () => {
    const { store, mem } = await newStore();
    store.addNote({ channel_id: CH_A, note: 'primera', created_by: 'U1', now_ms: 1 });
    store.addNote({ channel_id: CH_A, note: 'segunda', created_by: 'U1', now_ms: 2 });
    store.addNote({ channel_id: CH_B, note: 'otra sala', created_by: 'U1', now_ms: 3 });
    const a = store.recentNotes(CH_A, 10);
    expect(a.map((n) => n.note)).toEqual(['segunda', 'primera']);
    const b = store.recentNotes(CH_B, 10);
    expect(b.map((n) => n.note)).toEqual(['otra sala']);
    mem.close();
  });

  test('searchNotes matches note text and tags, case-insensitively', async () => {
    const { store, mem } = await newStore();
    store.addNote({ channel_id: CH_A, note: 'pico de latencia en Fintoc', tags: 'fintoc spei', created_by: 'U1', now_ms: 1 });
    store.addNote({ channel_id: CH_A, note: 'error en dispersión', tags: 'mambu', created_by: 'U1', now_ms: 2 });
    expect(store.searchNotes(CH_A, 'FINTOC', 10)).toHaveLength(1);
    expect(store.searchNotes(CH_A, 'mambu', 10)).toHaveLength(1);
    expect(store.searchNotes(CH_A, 'nada-que-ver', 10)).toHaveLength(0);
    // empty query falls back to recent
    expect(store.searchNotes(CH_A, '   ', 10)).toHaveLength(2);
    mem.close();
  });

  test('deleteNote is scoped to the channel', async () => {
    const { store, mem } = await newStore();
    const n = store.addNote({ channel_id: CH_A, note: 'borrable', created_by: 'U1', now_ms: 1 });
    expect(store.deleteNote(CH_B, n.id)).toBe(false); // wrong channel
    expect(store.deleteNote(CH_A, n.id)).toBe(true);
    expect(store.getById(n.id)).toBeNull();
    mem.close();
  });
});
