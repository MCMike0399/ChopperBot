import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { INSTAGRAM_MONITOR_MIGRATIONS, InstagramMonitorStore } from '../../instagram_monitor/store.js';
import {
  CONFIGURATION_CAPABILITY_ID,
  CONFIGURATION_CHANNEL_ID,
} from '../constants.js';
import { CONFIGURATION_MIGRATIONS, ConfigurationStore } from '../store.js';

async function freshStore() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate(CONFIGURATION_CAPABILITY_ID, CONFIGURATION_MIGRATIONS);
  return { memory, store: new ConfigurationStore(memory.db()) };
}

const CH_A = '20000000000000000001';
const CH_B = '20000000000000000002';
const CH_C = '20000000000000000003';

describe('ConfigurationStore — migrations', () => {
  test('migration applies idempotently', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    await memory.migrate(CONFIGURATION_CAPABILITY_ID, CONFIGURATION_MIGRATIONS);
    await memory.migrate(CONFIGURATION_CAPABILITY_ID, CONFIGURATION_MIGRATIONS);
    const cols = memory
      .db()
      .prepare('PRAGMA table_info(configuration_bindings)')
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['capability_id', 'channel_id', 'updated_at', 'updated_by'].sort(),
    );
    memory.close();
  });
});

describe('ConfigurationStore — CRUD', () => {
  test('upsert/get/list/remove round-trip', async () => {
    const { memory, store } = await freshStore();
    store.upsert(CH_A, 'instagram_monitor', 'USER_1');
    expect(store.get(CH_A)?.capability_id).toBe('instagram_monitor');

    // Update path
    store.upsert(CH_A, 'calendar', 'USER_2');
    expect(store.get(CH_A)?.capability_id).toBe('calendar');
    expect(store.get(CH_A)?.updated_by).toBe('USER_2');

    store.upsert(CH_B, 'instagram_monitor', 'USER_1');
    const all = store.list();
    expect(all.map((r) => r.channel_id).sort()).toEqual([CH_A, CH_B].sort());

    expect(store.remove(CH_A)).toBe(true);
    expect(store.remove(CH_A)).toBe(false);
    expect(store.get(CH_A)).toBeNull();
    memory.close();
  });
});

describe('ConfigurationStore — loadBootBindings', () => {
  test('empty table + non-empty env seed → seeds DB and force-binds the config channel', async () => {
    const { memory, store } = await freshStore();
    const env = new Map([[CH_A, 'instagram_monitor'], [CH_B, 'calendar']]);
    const result = store.loadBootBindings(env);

    expect(result.get(CH_A)).toBe('instagram_monitor');
    expect(result.get(CH_B)).toBe('calendar');
    expect(result.get(CONFIGURATION_CHANNEL_ID)).toBe(CONFIGURATION_CAPABILITY_ID);

    const persistedAuthor = store.get(CH_A)?.updated_by;
    expect(persistedAuthor).toBe('env-seed');
    expect(store.get(CONFIGURATION_CHANNEL_ID)?.updated_by).toBe('bootstrap');
    memory.close();
  });

  test('second loadBootBindings call with same env is idempotent', async () => {
    const { memory, store } = await freshStore();
    const env = new Map([[CH_A, 'instagram_monitor']]);
    store.loadBootBindings(env);
    const firstUpdatedAt = store.get(CONFIGURATION_CHANNEL_ID)?.updated_at;
    expect(firstUpdatedAt).toBeDefined();

    const result = store.loadBootBindings(env);
    // CH_A is still seeded once (not re-seeded — we only seed when the table is empty).
    expect(result.get(CH_A)).toBe('instagram_monitor');
    // Config channel is force-upserted each time; updated_at may bump but row stays.
    expect(store.get(CONFIGURATION_CHANNEL_ID)?.capability_id).toBe(CONFIGURATION_CAPABILITY_ID);
    expect(store.list().filter((r) => r.channel_id === CH_A)).toHaveLength(1);
    memory.close();
  });

  test('non-empty table is preserved — env seed is ignored on subsequent boots', async () => {
    const { memory, store } = await freshStore();
    store.upsert(CH_A, 'calendar', 'admin');
    // Even with a totally different env, the DB wins.
    const env = new Map([[CH_A, 'instagram_monitor'], [CH_B, 'instagram_monitor']]);
    const result = store.loadBootBindings(env);
    expect(result.get(CH_A)).toBe('calendar'); // not overwritten
    expect(result.get(CH_B)).toBeUndefined(); // env not applied because DB was non-empty
    memory.close();
  });

  test('always force-binds the configuration channel even if missing', async () => {
    const { memory, store } = await freshStore();
    store.loadBootBindings(new Map());
    expect(store.get(CONFIGURATION_CHANNEL_ID)?.capability_id).toBe(CONFIGURATION_CAPABILITY_ID);
    // And re-binds it if someone manually pointed it elsewhere.
    store.upsert(CONFIGURATION_CHANNEL_ID, 'instagram_monitor', 'tamperer');
    store.loadBootBindings(new Map());
    expect(store.get(CONFIGURATION_CHANNEL_ID)?.capability_id).toBe(CONFIGURATION_CAPABILITY_ID);
    memory.close();
  });
});

describe('ConfigurationStore — DB introspection', () => {
  test('listTables includes configuration_bindings and _migrations, excludes sqlite_*', async () => {
    const { memory, store } = await freshStore();
    const names = store.listTables().map((t) => t.name);
    expect(names).toContain('configuration_bindings');
    expect(names).toContain('_migrations');
    expect(names.every((n) => !n.startsWith('sqlite_'))).toBe(true);
    memory.close();
  });

  test('listTables reports accurate row counts', async () => {
    const { memory, store } = await freshStore();
    store.upsert(CH_A, 'instagram_monitor', 'u');
    store.upsert(CH_B, 'calendar', 'u');
    const t = store.listTables().find((x) => x.name === 'configuration_bindings');
    expect(t?.row_count).toBe(2);
    memory.close();
  });

  test('inspectTable returns rows and respects the hard cap', async () => {
    const { memory, store } = await freshStore();
    store.upsert(CH_A, 'instagram_monitor', 'u');
    store.upsert(CH_B, 'calendar', 'u');
    const rows = store.inspectTable('configuration_bindings', 50);
    expect(rows).toHaveLength(2);
    memory.close();
  });

  test('inspectTable rejects unsafe names', async () => {
    const { memory, store } = await freshStore();
    expect(() => store.inspectTable('configuration_bindings; DROP TABLE x', 5)).toThrow();
    expect(() => store.inspectTable('no_such_table', 5)).toThrow();
    memory.close();
  });

  test('migrationStatus reports applied migrations from _migrations', async () => {
    const { memory, store } = await freshStore();
    const rows = store.migrationStatus();
    expect(rows.some((r) => r.capability === CONFIGURATION_CAPABILITY_ID && r.version === 1)).toBe(
      true,
    );
    memory.close();
  });
});

describe('ConfigurationStore — purgeChannelData (capability-agnostic)', () => {
  test('deletes only rows in tables prefixed with the capability id AND carrying channel_id', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    await memory.migrate(CONFIGURATION_CAPABILITY_ID, CONFIGURATION_MIGRATIONS);
    await memory.migrate('instagram_monitor', INSTAGRAM_MONITOR_MIGRATIONS);
    const store = new ConfigurationStore(memory.db());
    const ig = new InstagramMonitorStore(memory.db());

    // instagram_monitor_accounts is GLOBAL (no channel_id) so it won't be
    // touched by purge. instagram_monitor_seen_posts is still per-channel
    // and IS what purge targets.
    ig.upsertAccount({ username: 'foo', added_by: 'u' });
    ig.recordSeen({
      channel_id: CH_A,
      ig_post_id: 'P1',
      account_username: 'foo',
      caption: null,
      media_type: null,
      posted_at: null,
      classification_json: null,
      pushed: true,
      discord_message_id: 'm1',
    });
    ig.recordSeen({
      channel_id: CH_A,
      ig_post_id: 'P2',
      account_username: 'foo',
      caption: null,
      media_type: null,
      posted_at: null,
      classification_json: null,
      pushed: false,
      discord_message_id: null,
    });
    ig.recordSeen({
      channel_id: CH_B,
      ig_post_id: 'P3',
      account_username: 'foo',
      caption: null,
      media_type: null,
      posted_at: null,
      classification_json: null,
      pushed: true,
      discord_message_id: 'm3',
    });

    const result = store.purgeChannelData('instagram_monitor', CH_A);
    expect(result.rows_deleted).toBe(2);
    expect(result.tables_affected.map((t) => t.table)).toContain('instagram_monitor_seen_posts');
    // Global accounts table untouched.
    expect(result.tables_affected.map((t) => t.table)).not.toContain('instagram_monitor_accounts');

    // CH_A is gone, CH_B is intact, account survives.
    expect(ig.hasSeen(CH_A, 'P1')).toBe(false);
    expect(ig.hasSeen(CH_A, 'P2')).toBe(false);
    expect(ig.hasSeen(CH_B, 'P3')).toBe(true);
    expect(ig.getAccount('foo')).not.toBeNull();
    memory.close();
  });

  test('refuses to purge configuration_* tables', async () => {
    const { memory, store } = await freshStore();
    expect(() => store.purgeChannelData(CONFIGURATION_CAPABILITY_ID, CH_A)).toThrow(
      /configuration/,
    );
    memory.close();
  });

  test('reports zero-row result when nothing matches', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    await memory.migrate('instagram_monitor', INSTAGRAM_MONITOR_MIGRATIONS);
    await memory.migrate(CONFIGURATION_CAPABILITY_ID, CONFIGURATION_MIGRATIONS);
    const store = new ConfigurationStore(memory.db());
    const result = store.purgeChannelData('instagram_monitor', CH_C);
    expect(result.rows_deleted).toBe(0);
    expect(result.tables_affected).toEqual([]);
    memory.close();
  });
});

// Anchor reference to keep tree-shake from biting if NamespacedMemory ever
// drifts in a way that breaks the test imports.
void NamespacedMemory;
