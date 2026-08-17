import { describe, test, expect, vi } from 'vitest';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from '../store.js';
import { FlyerToolSource } from '../flyer-tools.js';
import type { ParsedForm } from '../parse.js';

const FORM: ParsedForm = {
  title: 'Charla Z',
  dayRaw: 'sábado',
  timeRaw: '7pm',
  speaker: 'Ana',
  flyerSelf: false,
  pairs: [],
};

async function setup() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'event_intake').migrate('event_intake', EVENT_INTAKE_MIGRATIONS);
  const store = new EventIntakeStore(mem.db());
  store.recordProposal({
    channelId: 'ticket-1',
    guildId: 'g1',
    requesterId: 'u1',
    parsedForm: FORM,
    resolvedStartAt: null,
    proposalMessageId: 'prop-1',
  });
  return { store, mem };
}

describe('FlyerToolSource flyer_request', () => {
  test('returns error when openFlyerJob fails — does not claim requested', async () => {
    const { store, mem } = await setup();
    const onFlyerAction = vi.fn(async () => false);
    const src = new FlyerToolSource({ store, ticketChannelId: 'ticket-1', onFlyerAction });

    const res = await src.handle('flyer_request', { notes: 'tema rojo' });
    expect(res.status).toBe('error');
    expect((res.payload as { flyer_status?: string }).flyer_status).toBe('none');
    expect((res.payload as { error?: string }).error).toMatch(/No pude abrir/);
    expect(store.getTicket('ticket-1')!.flyer_status).toBe('none');
    expect(onFlyerAction).toHaveBeenCalledWith('request', 'tema rojo');
    mem.close();
  });

  test('returns error when the watcher callback is missing', async () => {
    const { store, mem } = await setup();
    const src = new FlyerToolSource({ store, ticketChannelId: 'ticket-1' });
    const res = await src.handle('flyer_request', {});
    expect(res.status).toBe('error');
    expect((res.payload as { flyer_status?: string }).flyer_status).toBe('none');
    mem.close();
  });

  test('returns success only after the job actually opens', async () => {
    const { store, mem } = await setup();
    const onFlyerAction = vi.fn(async () => {
      store.markFlyerRequested('ticket-1', 'card-1', null);
      return true;
    });
    const src = new FlyerToolSource({ store, ticketChannelId: 'ticket-1', onFlyerAction });

    const res = await src.handle('flyer_request', {});
    expect(res.status).toBe('success');
    expect((res.payload as { flyer_status?: string }).flyer_status).toBe('requested');
    mem.close();
  });
});
