/**
 * The calendar tools keep a linked Discord scheduled event in step with the
 * calendar: updates refresh it, a whole-series delete cancels it, and the sync
 * tool accepts a banner image ONLY from the URLs the conversation advertised.
 * The syncer is a fake; the store is a real in-memory SQLite.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import type {
  DiscordEventSyncer,
  RefreshOutcome,
  RemoveOutcome,
  SyncOutcome,
} from '../discord-events.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const NOW = Date.parse('2026-08-06T18:00:00Z');
const START = Date.parse('2026-08-12T02:00:00Z'); // Aug 11, 8:00 PM CDMX
const FLYER = 'https://cdn.discordapp.com/attachments/1/2/flyer.png';

let memory: InstanceType<typeof SqliteMemoryStore>;
let store: InstanceType<typeof CalendarStore>;

const syncMock = vi.fn<(id: number, opts?: { imageUrl?: string | null }) => Promise<SyncOutcome>>();
const refreshMock = vi.fn<(id: number) => Promise<RefreshOutcome>>();
const removeMock = vi.fn<(id: number) => Promise<RemoveOutcome>>();

function makeSource(opts: { withSyncer?: boolean; allowedImageUrls?: string[] } = {}) {
  const syncer: DiscordEventSyncer = {
    sync: syncMock,
    refresh: refreshMock,
    remove: removeMock,
  };
  return new CalendarToolSource(store, 'mod-user', NOW, undefined, {
    syncer: opts.withSyncer === false ? undefined : syncer,
    allowedImageUrls: opts.allowedImageUrls ?? [],
  });
}

function createEvent(overrides: { title?: string; linked?: boolean } = {}) {
  const created = store.create({
    created_by: 'mod-user',
    title: overrides.title ?? 'Rosario Castellanos | Club de poesía',
    start_at: START,
  });
  if (overrides.linked) store.setDiscordEventId(created.id, 'DE1');
  return created;
}

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  syncMock.mockReset().mockResolvedValue({
    ok: true,
    discordEventId: 'DE1',
    url: 'https://discord.com/events/G1/DE1',
    created: true,
    startAtLocal: 'Tue, Aug 11, 8:00 PM',
    imageSet: false,
  });
  refreshMock.mockReset().mockResolvedValue({
    ok: true,
    action: 'updated',
    url: 'https://discord.com/events/G1/DE1',
    changed: ['fecha/hora'],
  });
  removeMock.mockReset().mockResolvedValue({ ok: true, action: 'deleted' });
});

afterEach(() => memory.close());

describe('update propagation', () => {
  test('editing a linked event refreshes its Discord event and says what changed', async () => {
    const ev = createEvent({ linked: true });
    const res = await makeSource().handle('calendar_update_event', {
      id: ev.id,
      start_at_iso: '2026-08-13T02:00:00Z',
    });
    expect(res.status).toBe('success');
    expect(refreshMock).toHaveBeenCalledWith(ev.id);
    const payload = res.payload as { discord_event?: { action: string; changed: string[] } };
    expect(payload.discord_event?.action).toBe('updated');
    expect(payload.discord_event?.changed).toContain('fecha/hora');
  });

  test('editing an UNLINKED event stays quiet (no discord_event in the payload)', async () => {
    refreshMock.mockResolvedValue({ ok: true, action: 'not_linked' });
    const ev = createEvent();
    const res = await makeSource().handle('calendar_update_event', {
      id: ev.id,
      title: 'Otro título',
    });
    expect(res.status).toBe('success');
    expect(refreshMock).toHaveBeenCalledWith(ev.id);
    expect((res.payload as Record<string, unknown>).discord_event).toBeUndefined();
  });

  test('a failed refresh is reported but never fails the calendar edit', async () => {
    refreshMock.mockResolvedValue({ ok: false, reason: 'error', message: 'Discord 500' });
    const ev = createEvent({ linked: true });
    const res = await makeSource().handle('calendar_update_event', {
      id: ev.id,
      title: 'Otro título',
    });
    expect(res.status).toBe('success');
    const payload = res.payload as { discord_event?: { action: string; message: string } };
    expect(payload.discord_event).toEqual({ action: 'error', message: 'Discord 500' });
  });
});

describe('delete propagation', () => {
  test('deleting a series cancels the linked Discord event BEFORE the row goes away', async () => {
    const ev = createEvent({ linked: true });
    // The remove must see the row (and its link) still present — after the
    // delete there'd be nothing to read the discord_event_id from.
    removeMock.mockImplementation(async (id: number) => {
      expect(store.get(id)?.discord_event_id).toBe('DE1');
      return { ok: true, action: 'deleted' };
    });
    const res = await makeSource().handle('calendar_delete_event', { id: ev.id });
    expect(res.status).toBe('success');
    expect(removeMock).toHaveBeenCalledWith(ev.id);
    expect(refreshMock).not.toHaveBeenCalled();
    expect((res.payload as { discord_event?: { action: string } }).discord_event?.action).toBe(
      'deleted',
    );
    expect(store.get(ev.id)).toBeNull();
  });

  test('deleting an unlinked event notes nothing', async () => {
    removeMock.mockResolvedValue({ ok: true, action: 'not_linked' });
    const ev = createEvent();
    const res = await makeSource().handle('calendar_delete_event', { id: ev.id });
    expect(res.status).toBe('success');
    expect((res.payload as Record<string, unknown>).discord_event).toBeUndefined();
  });

  test('cancelling ONE occurrence refreshes instead (the series lives on)', async () => {
    const created = store.create({
      created_by: 'mod-user',
      title: 'Club de cine',
      start_at: START,
      recurrence_freq: 'weekly',
    });
    store.setDiscordEventId(created.id, 'DE1');
    const res = await makeSource().handle('calendar_delete_event', {
      id: created.id,
      scope: 'occurrence',
      occurrence_date_iso: '2026-08-11',
    });
    expect(res.status).toBe('success');
    expect(refreshMock).toHaveBeenCalledWith(created.id);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('calendar_sync_discord_event — the banner parameter', () => {
  test('passes an advertised image URL through to the syncer', async () => {
    const ev = createEvent();
    const res = await makeSource({ allowedImageUrls: [FLYER] }).handle(
      'calendar_sync_discord_event',
      { event_id: ev.id, image_url: FLYER },
    );
    expect(res.status).toBe('success');
    expect(syncMock).toHaveBeenCalledWith(ev.id, { imageUrl: FLYER });
  });

  test('refuses a URL the conversation never offered (hallucination/injection guard)', async () => {
    const ev = createEvent();
    const res = await makeSource({ allowedImageUrls: [FLYER] }).handle(
      'calendar_sync_discord_event',
      { event_id: ev.id, image_url: 'https://cdn.discordapp.com/attachments/9/9/invented.png' },
    );
    expect(res.status).toBe('error');
    expect(syncMock).not.toHaveBeenCalled();
  });

  test('works without an image, and reports image_set in the payload', async () => {
    syncMock.mockResolvedValue({
      ok: true,
      discordEventId: 'DE1',
      url: 'https://discord.com/events/G1/DE1',
      created: true,
      startAtLocal: 'Tue, Aug 11, 8:00 PM',
      imageSet: true,
    });
    const ev = createEvent();
    const res = await makeSource().handle('calendar_sync_discord_event', { event_id: ev.id });
    expect(res.status).toBe('success');
    const payload = res.payload as { discord_event: { image_set: boolean } };
    expect(payload.discord_event.image_set).toBe(true);
  });
});
