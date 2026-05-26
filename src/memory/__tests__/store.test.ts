import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory, type Migration } from '../store.js';

const m = (version: number, up: string): Migration => ({ version, up });

describe('SqliteMemoryStore + migrations', () => {
  test('runs migrations in order and records them', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    await store.migrate('demo', [
      m(1, 'CREATE TABLE IF NOT EXISTS demo_things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'),
      m(2, 'CREATE INDEX IF NOT EXISTS demo_things_name ON demo_things (name)'),
    ]);
    const tables = store
      .db()
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('demo_things');
    expect(names).toContain('demo_things_name');
    expect(names).toContain('_migrations');

    const applied = store
      .db()
      .prepare('SELECT version FROM _migrations WHERE capability = ? ORDER BY version')
      .all('demo')
      .map((r) => (r as { version: number }).version);
    expect(applied).toEqual([1, 2]);
    store.close();
  });

  test('migration is idempotent — rerunning the same set is a no-op', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    const migrations = [m(1, 'CREATE TABLE IF NOT EXISTS demo_t (id INTEGER PRIMARY KEY)')];
    await store.migrate('demo', migrations);
    await store.migrate('demo', migrations);
    await store.migrate('demo', migrations);
    const applied = store
      .db()
      .prepare('SELECT COUNT(*) as c FROM _migrations WHERE capability = ?')
      .get('demo') as { c: number };
    expect(applied.c).toBe(1);
    store.close();
  });

  test('adding a new migration version applies only the new one', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    await store.migrate('demo', [m(1, 'CREATE TABLE IF NOT EXISTS demo_t (id INTEGER PRIMARY KEY)')]);
    await store.migrate('demo', [
      m(1, 'CREATE TABLE IF NOT EXISTS demo_t (id INTEGER PRIMARY KEY)'),
      m(2, 'ALTER TABLE demo_t ADD COLUMN name TEXT'),
    ]);
    const cols = store.db().prepare('PRAGMA table_info(demo_t)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    store.close();
  });

  test('two capabilities migrate independently and do not collide', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    await store.migrate('alpha', [m(1, 'CREATE TABLE IF NOT EXISTS alpha_t (id INTEGER PRIMARY KEY)')]);
    await store.migrate('beta', [m(1, 'CREATE TABLE IF NOT EXISTS beta_t (id INTEGER PRIMARY KEY)')]);

    const counts = store
      .db()
      .prepare('SELECT capability, COUNT(*) as c FROM _migrations GROUP BY capability ORDER BY capability')
      .all() as { capability: string; c: number }[];
    expect(counts).toEqual([
      { capability: 'alpha', c: 1 },
      { capability: 'beta', c: 1 },
    ]);
    store.close();
  });

  test('migrations run inside a transaction — failing migration rolls back', async () => {
    const store = new SqliteMemoryStore({ path: ':memory:' });
    await expect(
      store.migrate('demo', [
        m(1, 'CREATE TABLE demo_t (id INTEGER PRIMARY KEY); INSERT INTO nonexistent VALUES (1)'),
      ]),
    ).rejects.toThrow();
    // No migration row was inserted, and the partially-created table was rolled back.
    const row = store
      .db()
      .prepare("SELECT name FROM sqlite_master WHERE name = 'demo_t'")
      .get();
    expect(row).toBeUndefined();
    const applied = store
      .db()
      .prepare("SELECT * FROM _migrations WHERE capability = 'demo'")
      .all();
    expect(applied).toEqual([]);
    store.close();
  });
});

describe('NamespacedMemory', () => {
  test('forwards db() and fixes capabilityId on migrate()', async () => {
    const inner = new SqliteMemoryStore({ path: ':memory:' });
    const calView = new NamespacedMemory(inner, 'calendar');
    // The "wrong" id passed in is ignored — calendar's namespace is used.
    await calView.migrate('not-calendar', [
      { version: 1, up: 'CREATE TABLE IF NOT EXISTS calendar_events (id INTEGER PRIMARY KEY)' },
    ]);
    const row = inner
      .db()
      .prepare("SELECT capability FROM _migrations WHERE version = 1")
      .get() as { capability: string };
    expect(row.capability).toBe('calendar');
    // The view's db() points to the shared handle.
    expect(calView.db()).toBe(inner.db());
    inner.close();
  });
});
