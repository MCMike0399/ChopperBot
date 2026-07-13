import { describe, test, expect } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from '../store.js';
import type { ParsedForm } from '../parse.js';

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  return { store: new EventIntakeStore(mem.db()), mem };
}

const FORM: ParsedForm = {
  title: 'Círculo de lectura',
  dayRaw: 'domingo',
  timeRaw: '8pm',
  speaker: 'Burbuja',
  flyerSelf: false,
  pairs: [],
};

describe('EventIntakeStore settings', () => {
  test('seed watched categories only when empty; edits survive re-seed', async () => {
    const { store, mem } = await newStore();
    store.seedWatchedCategories(['cat1']);
    expect(store.getWatchedCategories()).toEqual(['cat1']);
    store.setWatchedCategories(['cat2']);
    store.seedWatchedCategories(['cat1']); // a restart re-seed must not clobber
    expect(store.getWatchedCategories()).toEqual(['cat2']);
    mem.close();
  });

  test('mod roles seed + set (names or ids)', async () => {
    const { store, mem } = await newStore();
    expect(store.getModRoles()).toEqual([]); // empty by default (watcher applies fallback)
    store.seedModRoles(['Moderador', '123']);
    expect(store.getModRoles()).toEqual(['Moderador', '123']);
    mem.close();
  });
});

describe('EventIntakeStore tickets', () => {
  test('recordProposal is idempotent per channel; markCreated flips status', async () => {
    const { store, mem } = await newStore();
    store.recordProposal({
      channelId: 'chan1',
      guildId: 'g1',
      requesterId: 'u1',
      parsedForm: FORM,
      resolvedStartAt: null,
      proposalMessageId: 'm1',
    });
    const t1 = store.getTicket('chan1')!;
    expect(t1.status).toBe('proposed');
    expect(t1.requester_id).toBe('u1');
    expect(EventIntakeStore.parseForm(t1)?.title).toBe('Círculo de lectura');

    store.markCreated('chan1', 42);
    const t2 = store.getTicket('chan1')!;
    expect(t2.status).toBe('created');
    expect(t2.created_event_id).toBe(42);

    // A second form event for the same channel does not create a duplicate row.
    store.recordProposal({
      channelId: 'chan1',
      guildId: 'g1',
      requesterId: 'u1',
      parsedForm: FORM,
      resolvedStartAt: null,
      proposalMessageId: 'm2',
    });
    expect(store.recentTickets(10)).toHaveLength(1);
    mem.close();
  });

  test('parseForm tolerates a missing/garbage row', async () => {
    const { store, mem } = await newStore();
    expect(EventIntakeStore.parseForm(undefined)).toBeNull();
    expect(store.getTicket('nope')).toBeUndefined();
    mem.close();
  });
});
