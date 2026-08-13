/**
 * calendar_set_session_theme — the "esta semana vemos Persepolis" tool. Themes
 * ONE session of a recurring series (title/description/same-day retime) via
 * the occurrence-override machinery, republishes, and creates-or-refreshes the
 * linked Discord event. The regression guard for the live 2026-08-13 failure:
 * handed a flyer, the model created a duplicate "Cine Club: Persepolis" series
 * instead of theming the existing club's session.
 *
 * The syncer and publisher are fakes; the store is a real in-memory SQLite.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import type {
  DiscordEventSyncer,
  RefreshOutcome,
  RemoveOutcome,
  SyncOutcome,
} from '../discord-events.js';
import type { PublishSummary } from '../publisher.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const NOW = Date.parse('2026-08-13T20:00:00Z'); // Aug 13, 2:00 PM CDMX
const START = Date.parse('2026-08-14T02:00:00Z'); // Aug 13, 8:00 PM CDMX (a Thursday)
const NINE_PM = Date.parse('2026-08-14T03:00:00Z'); // same local day, 9:00 PM CDMX

let memory: InstanceType<typeof SqliteMemoryStore>;
let store: InstanceType<typeof CalendarStore>;

const syncMock = vi.fn<(id: number) => Promise<SyncOutcome>>();
const refreshMock = vi.fn<(id: number) => Promise<RefreshOutcome>>();
const removeMock = vi.fn<(id: number) => Promise<RemoveOutcome>>();
const reconcileMock = vi.fn<() => Promise<PublishSummary>>();

function makeSource(opts: { allowWrite?: boolean } = {}) {
  const syncer: DiscordEventSyncer = { sync: syncMock, refresh: refreshMock, remove: removeMock };
  const publisher = { outputChannelId: () => 'OUT', reconcile: reconcileMock };
  return new CalendarToolSource(store, 'mod-user', NOW, publisher, {
    syncer,
    ...(opts.allowWrite === false ? { allowWrite: false } : {}),
  });
}

/** The weekly Club de cine series, Thursdays 8pm CDMX. */
function createSeries(opts: { linked?: boolean } = {}) {
  const created = store.create({
    created_by: 'mod-user',
    title: 'Club de cine',
    start_at: START,
    location: 'sala de cine',
    recurrence_freq: 'weekly',
  });
  if (opts.linked) store.setDiscordEventId(created.id, 'DE1');
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
    startAtLocal: 'Thu, Aug 13, 8:00 PM',
    imageSet: false,
    venue: { kind: 'stage', name: '🎬 Sala de Cineclub 🎬' },
  });
  refreshMock.mockReset().mockResolvedValue({
    ok: true,
    action: 'updated',
    url: 'https://discord.com/events/G1/DE1',
    changed: ['fecha/hora'],
  });
  removeMock.mockReset().mockResolvedValue({ ok: true, action: 'deleted' });
  reconcileMock.mockReset().mockResolvedValue({ posted: ['2026-08'], removed: [], skipped: [], ok: true });
});

describe('calendar_set_session_theme', () => {
  test('themes one session and creates the Discord event when the series is unlinked', async () => {
    const series = createSeries();
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: series.id,
      occurrence_date_iso: '2026-08-13',
      title: 'Club de cine: Persepolis',
      description: 'Charla y discusión después de la proyección',
    });
    expect(res.status).toBe('success');
    const payload = res.payload as Record<string, unknown>;
    expect(payload.updated).toBe('session');
    expect(payload.occurrence_local).toContain('8:00 PM');
    expect((payload.discord_event as Record<string, unknown>).action).toBe('created');

    // The override landed: this week's occurrence is themed, the series is not.
    const occs = store.listOccurrences(NOW, NOW + 21 * 86_400_000).filter((o) => o.id === series.id);
    expect(occs[0]!.title).toBe('Club de cine: Persepolis');
    expect(occs[0]!.description).toBe('Charla y discusión después de la proyección');
    expect(occs[0]!.start_at).toBe(START);
    expect(occs[1]!.title).toBe('Club de cine'); // next week stays generic
    expect(store.get(series.id)!.title).toBe('Club de cine');

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(series.id);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test('a same-day retime rides along with the theme', async () => {
    const series = createSeries();
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: series.id,
      occurrence_date_iso: '2026-08-13',
      title: 'Club de cine: Persepolis',
      start_at_iso: new Date(NINE_PM).toISOString(),
    });
    expect(res.status).toBe('success');
    expect((res.payload as Record<string, unknown>).occurrence_local).toContain('9:00 PM');
    const occ = store.listOccurrences(NOW, NOW + 86_400_000).find((o) => o.id === series.id)!;
    expect(occ.start_at).toBe(NINE_PM);
  });

  test('refuses a retime that lands on another day — and stores nothing', async () => {
    const series = createSeries();
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: series.id,
      occurrence_date_iso: '2026-08-13',
      title: 'Club de cine: Persepolis',
      start_at_iso: '2026-08-15T03:00:00Z', // Aug 14, 9 PM CDMX — the NEXT day
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/MISMO día/);
    const occ = store.listOccurrences(NOW, NOW + 86_400_000).find((o) => o.id === series.id)!;
    expect(occ.title).toBe('Club de cine');
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  test('refuses a one-off event and points at calendar_update_event', async () => {
    const oneOff = store.create({ created_by: 'mod-user', title: 'Taller único', start_at: START });
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: oneOff.id,
      occurrence_date_iso: '2026-08-13',
      title: 'Taller único: edición especial',
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/no es una serie recurrente/);
  });

  test('refuses a date with no occurrence of the series', async () => {
    const series = createSeries();
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: series.id,
      occurrence_date_iso: '2026-08-15', // a Saturday — the club is Thursdays
      title: 'Club de cine: Persepolis',
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/No encontré una ocurrencia/);
  });

  test('a linked series refreshes its Discord event instead of creating one', async () => {
    const series = createSeries({ linked: true });
    const res = await makeSource().handle('calendar_set_session_theme', {
      id: series.id,
      occurrence_date_iso: '2026-08-13',
      title: 'Club de cine: Persepolis',
    });
    expect(res.status).toBe('success');
    expect(refreshMock).toHaveBeenCalledWith(series.id);
    expect(syncMock).not.toHaveBeenCalled();
    expect(((res.payload as Record<string, unknown>).discord_event as Record<string, unknown>).action).toBe('updated');
  });

  test('is advertised as a tool but refused when the bundle is read-only', async () => {
    expect(makeSource().tools().map((t) => t.name)).toContain('calendar_set_session_theme');
    const res = await makeSource({ allowWrite: false }).handle('calendar_set_session_theme', {
      id: 1,
      occurrence_date_iso: '2026-08-13',
      title: 'Club de cine: Persepolis',
    });
    expect(res.status).toBe('error');
    expect(JSON.stringify(res.payload)).toMatch(/Solo un moderador/);
  });
});
