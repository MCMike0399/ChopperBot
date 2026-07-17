import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { buildRouter } from '../../routing.js';
import {
  ConfigurationStore,
  CONFIGURATION_MIGRATIONS,
} from '../../configuration/store.js';
import { CONFIGURATION_CAPABILITY_ID } from '../../configuration/constants.js';
import { SANCUS_OPS_CAPABILITY_ID } from '../constants.js';

const OPS_CHANNEL = '1527515596663685190'; // the channel bound to sancus_ops

async function newConfigStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, CONFIGURATION_CAPABILITY_ID).migrate(
    CONFIGURATION_CAPABILITY_ID,
    CONFIGURATION_MIGRATIONS,
  );
  return { store: new ConfigurationStore(mem.db()), mem };
}

describe('sancus_ops channel binding + routing', () => {
  test('a persisted binding routes the channel to sancus_ops', async () => {
    const { store, mem } = await newConfigStore();
    // Simulate the sqlite3-CLI insert done against the live DB.
    store.upsert(OPS_CHANNEL, SANCUS_OPS_CAPABILITY_ID, 'operator');

    const channelMap = store.loadBootBindings(new Map());
    const router = buildRouter(channelMap);

    expect(router.resolve(OPS_CHANNEL)).toBe(SANCUS_OPS_CAPABILITY_ID);
    expect(router.allChannelIds().has(OPS_CHANNEL)).toBe(true);
    mem.close();
  });

  test('binding survives the boot reload (DB rows are the source of truth)', async () => {
    const { store, mem } = await newConfigStore();
    store.upsert(OPS_CHANNEL, SANCUS_OPS_CAPABILITY_ID, 'operator');
    // env seed is empty; loadBootBindings must keep the DB row untouched.
    const map = store.loadBootBindings(new Map());
    expect(map.get(OPS_CHANNEL)).toBe(SANCUS_OPS_CAPABILITY_ID);
    // And re-reading returns the same binding (no drift).
    expect(store.get(OPS_CHANNEL)?.capability_id).toBe(SANCUS_OPS_CAPABILITY_ID);
    mem.close();
  });

  test('an unbound channel resolves to null (bot stays silent there)', async () => {
    const { store, mem } = await newConfigStore();
    store.upsert(OPS_CHANNEL, SANCUS_OPS_CAPABILITY_ID, 'operator');
    const router = buildRouter(store.loadBootBindings(new Map()));
    expect(router.resolve('99999999999999999999')).toBeNull();
    mem.close();
  });
});
