import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore } from '../../memory/store.js';
import { FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS, UserDirectory } from '../store.js';

async function freshDirectory(): Promise<{ store: SqliteMemoryStore; dir: UserDirectory }> {
  const store = new SqliteMemoryStore({ path: ':memory:' });
  await store.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  return { store, dir: new UserDirectory(store.db()) };
}

describe('UserDirectory', () => {
  test('upsert inserts a new row on first call', async () => {
    const { store, dir } = await freshDirectory();
    const u = dir.upsert('111', 'alice#0001', 1000);
    expect(u).toEqual({
      discord_user_id: '111',
      discord_tag: 'alice#0001',
      first_seen_at: 1000,
      last_seen_at: 1000,
    });
    expect(dir.get('111')).toEqual(u);
    store.close();
  });

  test('upsert advances last_seen_at and preserves first_seen_at', async () => {
    const { store, dir } = await freshDirectory();
    dir.upsert('222', 'bob#0002', 1000);
    const updated = dir.upsert('222', 'bob#0002', 5000);
    expect(updated.first_seen_at).toBe(1000);
    expect(updated.last_seen_at).toBe(5000);
    store.close();
  });

  test('upsert refreshes discord_tag if the user renamed', async () => {
    const { store, dir } = await freshDirectory();
    dir.upsert('333', 'carol_old', 1000);
    const updated = dir.upsert('333', 'carol_new', 2000);
    expect(updated.discord_tag).toBe('carol_new');
    expect(dir.get('333')?.discord_tag).toBe('carol_new');
    store.close();
  });

  test('get returns null for unknown users', async () => {
    const { store, dir } = await freshDirectory();
    expect(dir.get('does-not-exist')).toBeNull();
    store.close();
  });

  test('list orders by last_seen_at desc and respects limit', async () => {
    const { store, dir } = await freshDirectory();
    dir.upsert('a', 'alice', 1000);
    dir.upsert('b', 'bob', 3000);
    dir.upsert('c', 'carol', 2000);
    const all = dir.list(10);
    expect(all.map((u) => u.discord_user_id)).toEqual(['b', 'c', 'a']);
    const top2 = dir.list(2);
    expect(top2.map((u) => u.discord_user_id)).toEqual(['b', 'c']);
    store.close();
  });

  test('migrations are idempotent', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    await store.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
    await store.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
    const count = store
      .db()
      .prepare('SELECT COUNT(*) as c FROM _migrations WHERE capability = ?')
      .get(FRAMEWORK_CAPABILITY_ID) as { c: number };
    expect(count.c).toBe(1);
    store.close();
  });
});
