/**
 * Month-rollover auto-publish, end to end through the real publisher against a
 * fake Discord client (added 2026-08-03).
 *
 * Why this exists: on 2026-08-01 the live board silently missed the new month.
 * `reconcile()` only ran on a calendar mutation or at boot, and the bot had been
 * up since Jul 29 — so nothing computed "it's August now". These tests pin the
 * wiring that fixes it: the watcher publishes the new month exactly once, is
 * idempotent across restarts, and retries a failed publish.
 *
 * The real month template + pdf-lib render run here (~100 ms) because that's the
 * path that actually reaches Discord. Only the PNG rasterizer is mocked: real
 * `pdftoppm` at 150 DPI costs ~5 s per card on the Pi and is exercised by the
 * live `scripts/preview-calendar-board.ts --render` instead.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../raster.js', () => ({
  pdfToPng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // "\x89PNG"
}));

const { SqliteMemoryStore, NamespacedMemory } = await import('../../../memory/store.js');
const { CalendarCapability } = await import('../capability.js');
const { CalendarStore } = await import('../store.js');
const { monthKeyOfUtc } = await import('../grid.js');
type CalendarStore = InstanceType<typeof CalendarStore>;
type CalendarCapability = InstanceType<typeof CalendarCapability>;

const OUT = 'OUTPUT_CHAN';

/** A Discord client stub recording every send/edit/delete the publisher makes. */
function fakeClient() {
  const sent: Array<{ id: string; content: string }> = [];
  const edited: string[] = [];
  const deleted: string[] = [];
  let seq = 0;
  const messages = {
    fetch: async (id: string) => {
      if (deleted.includes(id) || !sent.some((m) => m.id === id)) throw new Error('Unknown Message');
      return {
        id,
        edit: async () => { edited.push(id); },
      };
    },
    delete: async (id: string) => { deleted.push(id); },
  };
  const channel = {
    isTextBased: () => true,
    send: async ({ content }: { content: string }) => {
      const id = `MSG_${++seq}`;
      sent.push({ id, content });
      return { id };
    },
    messages,
  };
  const client = { channels: { fetch: async (id: string) => (id === OUT ? channel : null) } };
  return { client: client as never, sent, edited, deleted };
}

async function boot() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  const cap = new CalendarCapability();
  await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' });
  const store = new CalendarStore(memory.db());
  store.setOutputChannelId(OUT);
  return { memory, cap, store };
}

/** Drive the private rollover check the interval would fire. */
const tick = (cap: CalendarCapability, client: unknown) =>
  (cap as unknown as { checkMonthRollover(c: unknown): Promise<void> }).checkMonthRollover(client);

/** Cards (not the ICS) posted so far, by month. */
const monthCards = (store: CalendarStore) =>
  store.listPublished().filter((r) => r.pub_key.startsWith('pdf:')).map((r) => r.pub_key.slice(4));

describe('month-rollover auto-publish', () => {
  test('publishes the current month when no card exists yet, and tracks it', async () => {
    const { memory, cap, store } = await boot();
    const { client, sent } = fakeClient();
    const current = monthKeyOfUtc(Date.now());

    expect(monthCards(store)).toEqual([]);
    await tick(cap, client);

    expect(monthCards(store)).toEqual([current]);
    // A brand-new month is a NEW message (fresh pub_key), not an edit.
    expect(sent.some((m) => m.content.includes('Calendario Revolución Z'))).toBe(true);
    await cap.dispose();
    memory.close();
  }, 30_000);

  test('a second check does nothing — a restart cannot double-post', async () => {
    const { memory, cap, store } = await boot();
    const { client, sent } = fakeClient();
    await tick(cap, client);
    const afterFirst = sent.length;
    const trackedId = store.getPublished(`pdf:${monthKeyOfUtc(Date.now())}`)!.message_id;

    await tick(cap, client);
    await tick(cap, client);

    expect(sent.length).toBe(afterFirst);          // nothing new posted
    expect(store.getPublished(`pdf:${monthKeyOfUtc(Date.now())}`)!.message_id).toBe(trackedId);
    await cap.dispose();
    memory.close();
  }, 30_000);

  test('a failed publish leaves no row, so the next check retries', async () => {
    const { memory, cap, store } = await boot();
    // Channel unreachable → reconcile reports not-ok and tracks nothing.
    const broken = { channels: { fetch: async () => null } } as never;
    await tick(cap, broken);
    expect(monthCards(store)).toEqual([]);

    // Discord comes back → the very next check publishes.
    const { client, sent } = fakeClient();
    await tick(cap, client);
    expect(monthCards(store)).toEqual([monthKeyOfUtc(Date.now())]);
    expect(sent.length).toBeGreaterThan(0);
    await cap.dispose();
    memory.close();
  }, 30_000);

  test('the new month replaces the old card — the board does not accumulate', async () => {
    const { memory, cap, store } = await boot();
    const { client, deleted } = fakeClient();
    await tick(cap, client);
    const current = monthKeyOfUtc(Date.now());

    // Fake a card left over from a previous month, as a real rollover would have.
    store.setPublished('pdf:2026-06', OUT, 'MSG_STALE');
    expect(monthCards(store).sort()).toEqual(['2026-06', current].sort());

    // Any reconcile prunes it (the rollover path runs the same reconcile).
    store.clearPublished(`pdf:${current}`);
    await tick(cap, client);

    expect(monthCards(store)).toEqual([current]);
    expect(deleted).toContain('MSG_STALE');
    await cap.dispose();
    memory.close();
  }, 30_000);

  test('start() reconciles immediately, arms the watcher, and dispose() clears it', async () => {
    const { memory, cap, store } = await boot();
    const { client } = fakeClient();
    const timer = () => (cap as unknown as { rolloverTimer: unknown }).rolloverTimer;

    expect(timer()).toBeNull();
    await cap.start({ client, registry: {} as never, router: {} as never, userDirectory: {} as never });

    // start() reconciles up front, so a rollover missed while the bot was DOWN
    // is corrected at boot without waiting for the interval.
    expect(monthCards(store)).toEqual([monthKeyOfUtc(Date.now())]);
    expect(timer()).not.toBeNull();

    await cap.dispose();
    expect(timer()).toBeNull(); // no leaked interval
    memory.close();
  }, 30_000);
});
