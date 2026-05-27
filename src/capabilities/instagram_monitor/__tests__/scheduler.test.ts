import { describe, test, expect, vi } from 'vitest';
import type { Client } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { InstagramMonitorStore, INSTAGRAM_MONITOR_MIGRATIONS } from '../store.js';
import { InstagramMonitorScheduler } from '../scheduler.js';
import { InstagramAuthError, type InstagramFetcher, type RecentPost } from '../fetcher.js';
import type { Classification } from '../classifier.js';
import type { PublishResult } from '../publisher.js';

const CHAN = '111111111111111111';
const CHAN_B = '222222222222222222';
const ONE_CHANNEL = () => [CHAN];
const NO_CHANNELS = () => [];
const TWO_CHANNELS = () => [CHAN, CHAN_B];

async function newStore() {
  const mem = new SqliteMemoryStore({ path: ':memory:' });
  await new NamespacedMemory(mem, 'instagram_monitor').migrate(
    'instagram_monitor',
    INSTAGRAM_MONITOR_MIGRATIONS,
  );
  return { store: new InstagramMonitorStore(mem.db()), mem };
}

function fakeFetcher(byUsername: Record<string, RecentPost[]>): InstagramFetcher {
  return {
    source: () => 'direct',
    async fetchRecentPosts(u) {
      const list = byUsername[u];
      if (!list) throw new Error(`no canned posts for ${u}`);
      return list;
    },
  };
}

function post(id: string, opts: Partial<RecentPost> = {}): RecentPost {
  return {
    igPostId: id,
    shortcode: id,
    caption: `caption ${id}`,
    takenAtMs: 1_700_000_000_000,
    mediaType: 'image',
    displayUrl: `https://cdn.example/${id}.jpg`,
    ...opts,
  };
}

const fakeClient = { channels: { cache: new Map() } } as unknown as Client;

describe('InstagramMonitorScheduler', () => {
  test('first poll seeds dedup anchor without publishing', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const publish = vi.fn();
    const classify = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P3'), post('P2'), post('P1')] }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify,
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.getAccount('foo')?.last_post_id).toBe('P3');
    mem.close();
  });

  test('publishes only LLM-relevant posts; records pushed=0 for skipped', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    // Seed so it's not the first poll.
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');

    const classify = vi.fn(async (_account: string, p: RecentPost): Promise<Classification> => {
      if (p.igPostId === 'P2') {
        return {
          relevant: true,
          type: 'evento',
          title: 'Asamblea',
          summary: 'Convocatoria',
          when: null,
          where: 'CDMX',
          tags: ['cdmx'],
        };
      }
      return {
        relevant: false,
        type: 'otro',
        title: '',
        summary: '',
        when: null,
        where: null,
        tags: [],
      };
    });
    const publish = vi.fn(async (): Promise<PublishResult> => ({ ok: true, messageId: 'M1' }));

    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P2'), post('P1'), post('P0')] }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify,
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    expect(classify).toHaveBeenCalledTimes(2); // P1, P2 — not P0 (anchor)
    expect(publish).toHaveBeenCalledTimes(1);
    const publishedShortcodes = publish.mock.calls.map((c) => (c[3] as RecentPost).shortcode);
    expect(publishedShortcodes).toEqual(['P2']);
    expect(store.hasSeen(CHAN, 'P1')).toBe(true);
    expect(store.hasSeen(CHAN, 'P2')).toBe(true);
    expect(store.getAccount('foo')?.last_post_id).toBe('P2');
    expect(store.recentPushed(CHAN, 10).map((s) => s.ig_post_id)).toEqual(['P2']);
    mem.close();
  });

  test('processes posts oldest-first so Discord sees them in posted order', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');

    const order: string[] = [];
    const realPublish = vi.fn(async (
      _client: Client,
      _channelId: string,
      _account: string,
      p: RecentPost,
    ): Promise<PublishResult> => {
      order.push(p.shortcode);
      return { ok: true, messageId: 'm' };
    });

    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P3'), post('P2'), post('P1'), post('P0')] }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish: realPublish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(order).toEqual(['P1', 'P2', 'P3']);
    mem.close();
  });

  test('pinned posts (returned first, out of order) do not freeze detection', async () => {
    // Instagram returns pinned posts at the top of the array regardless of age.
    // The dedup anchor here IS the pinned post. The scheduler must sort by
    // takenAtMs and still detect the chronologically-newest post sitting below
    // the pins, instead of breaking immediately on the anchor at index 0.
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    // Anchor = the pinned post 'PIN'.
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'PIN');

    const publish = vi.fn(async (
      _client: Client,
      _channelId: string,
      _account: string,
      p: RecentPost,
    ): Promise<PublishResult> => ({ ok: true, messageId: p.igPostId }));

    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({
        foo: [
          post('PIN', { takenAtMs: 2_000 }), // pinned, returned first, but OLD
          post('NEW', { takenAtMs: 3_000 }), // genuinely newest, sits below pin
          post('OLD', { takenAtMs: 1_000 }),
        ],
      }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    // Only NEW is published; PIN (the anchor) stops the walk, OLD is older.
    expect(publish).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0][3] as RecentPost).igPostId).toBe('NEW');
    // Anchor advances to the time-newest post, not the pinned one.
    expect(store.getAccount('foo')?.last_post_id).toBe('NEW');
    mem.close();
  });

  test('marks failure + advances backoff on fetch error', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const broken: InstagramFetcher = {
      source: () => 'direct',
      async fetchRecentPosts() {
        throw new Error('429 from IG');
      },
    };
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: broken,
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: false,
        type: 'otro',
        title: '',
        summary: '',
        when: null,
        where: null,
        tags: [],
      }),
      publish: async () => ({ ok: false, messageId: null }),
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    const a = store.getAccount('foo')!;
    expect(a.consecutive_failures).toBe(1);
    expect(a.last_polled_at).not.toBeNull();
    mem.close();
  });

  test('auth error is caught, records a failure, and publishes nothing', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');
    const fetcher: InstagramFetcher = {
      source: () => 'direct',
      async fetchRecentPosts() {
        throw new InstagramAuthError('session expired');
      },
    };
    const publish = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher,
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: false,
        type: 'otro',
        title: '',
        summary: '',
        when: null,
        where: null,
        tags: [],
      }),
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(store.getAccount('foo')!.consecutive_failures).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    mem.close();
  });

  test('caps pushes per account per tick per channel', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');

    const posts: RecentPost[] = [];
    for (let i = 10; i > 0; i--) posts.push(post(`P${i}`));
    posts.push(post('P0'));

    const publish = vi.fn(async () => ({ ok: true, messageId: 'm' } as PublishResult));
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: posts }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    // Cap is 5 pushes per (account × channel) per tick.
    expect(publish).toHaveBeenCalledTimes(5);
    for (let i = 1; i <= 10; i++) expect(store.hasSeen(CHAN, `P${i}`)).toBe(true);
    expect(store.getAccount('foo')?.last_post_id).toBe('P10');
    mem.close();
  });

  test('fans out new posts to every channel currently bound to the capability', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');

    const publishedTo: Array<{ channelId: string; postId: string }> = [];
    const publish = vi.fn(async (
      _client: Client,
      channelId: string,
      _account: string,
      p: RecentPost,
    ): Promise<PublishResult> => {
      publishedTo.push({ channelId, postId: p.igPostId });
      return { ok: true, messageId: 'm' };
    });

    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P2'), post('P1'), post('P0')] }),
      client: fakeClient,
      getBoundChannels: TWO_CHANNELS,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    // 2 new posts × 2 channels = 4 push attempts.
    expect(publish).toHaveBeenCalledTimes(4);
    // Each channel got both posts, in chronological order.
    expect(publishedTo).toEqual([
      { channelId: CHAN, postId: 'P1' },
      { channelId: CHAN_B, postId: 'P1' },
      { channelId: CHAN, postId: 'P2' },
      { channelId: CHAN_B, postId: 'P2' },
    ]);
    expect(store.hasSeen(CHAN, 'P1')).toBe(true);
    expect(store.hasSeen(CHAN, 'P2')).toBe(true);
    expect(store.hasSeen(CHAN_B, 'P1')).toBe(true);
    expect(store.hasSeen(CHAN_B, 'P2')).toBe(true);
    mem.close();
  });

  test('zero bound channels: advances anchor without publishing or classifying', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount('foo')!.id, 1, 'P0');

    const publish = vi.fn();
    const classify = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P3'), post('P2'), post('P1'), post('P0')] }),
      client: fakeClient,
      getBoundChannels: NO_CHANNELS,
      classify,
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // Anchor still moves so a future channel binding doesn't backfill.
    expect(store.getAccount('foo')?.last_post_id).toBe('P3');
    mem.close();
  });

  test('new channel binding gets no backfill — only posts detected after the bind', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });

    // Round 1: only channel A is bound. Post P1 arrives.
    let boundChannels = [CHAN];
    const publish = vi.fn(async (
      _client: Client,
      channelId: string,
      _account: string,
      p: RecentPost,
    ): Promise<PublishResult> => ({ ok: true, messageId: `${channelId}:${p.igPostId}` }));
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P1')] }),
      client: fakeClient,
      getBoundChannels: () => boundChannels,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish,
      fetchCover: async () => null,
    });
    // First poll: seed anchor only (no publish).
    await sch.tickOnce();
    expect(publish).toHaveBeenCalledTimes(0);

    // Channel B binds *after* the first poll. Then a new post P2 arrives.
    boundChannels = [CHAN, CHAN_B];
    // Force the account to be due immediately and supply the new feed.
    store.markPollSuccess(store.getAccount('foo')!.id, 0, 'P1');
    (sch as unknown as { deps: { fetcher: InstagramFetcher } }).deps.fetcher = fakeFetcher({
      foo: [post('P2'), post('P1')],
    });
    await sch.tickOnce();

    // Only P2 should have been published, and to BOTH channels (no P1 backfill).
    expect(publish).toHaveBeenCalledTimes(2);
    const got = publish.mock.calls.map((c) => `${c[1]}:${(c[3] as RecentPost).igPostId}`).sort();
    expect(got).toEqual([`${CHAN}:P2`, `${CHAN_B}:P2`]);
    expect(store.hasSeen(CHAN_B, 'P1')).toBe(false);
    expect(store.hasSeen(CHAN_B, 'P2')).toBe(true);
    mem.close();
  });

  test('anchor missing from a stale window does NOT backfill older posts', async () => {
    // Regression: IG occasionally returns a feed window that omits the most
    // recent post (eventual consistency / pagination). The old id-walk never
    // found the anchor, classified the whole (older) batch as new, and
    // backfilled weeks-old posts. With a recorded anchor time, the time-gate
    // must reject everything at/older than the anchor.
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const id = store.getAccount('foo')!.id;
    // Anchor = a recent post at t=5000 that is NOT in the upcoming batch.
    store.markPollSuccess(id, 1, 'ANCHOR', 5_000);

    const publish = vi.fn(async () => ({ ok: true, messageId: 'm' } as PublishResult));
    const classify = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({
        foo: [
          post('OLD3', { takenAtMs: 4_000 }),
          post('OLD2', { takenAtMs: 3_000 }),
          post('OLD1', { takenAtMs: 2_000 }),
        ],
      }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify,
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // Anchor must NOT regress to the older batch's newest.
    expect(store.getAccount('foo')?.last_post_id).toBe('ANCHOR');
    expect(store.getAccount('foo')?.last_post_at).toBe(5_000);
    mem.close();
  });

  test('anchor missing but genuinely-newer posts present: time-gate publishes them', async () => {
    // The other half of "anchor absent": the account posted enough that the
    // anchor scrolled off the window, but the batch is genuinely newer. The
    // time-gate must still surface posts captured after the anchor time.
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const id = store.getAccount('foo')!.id;
    store.markPollSuccess(id, 1, 'ANCHOR', 5_000);

    const publish = vi.fn(async (
      _client: Client,
      _channelId: string,
      _account: string,
      p: RecentPost,
    ): Promise<PublishResult> => ({ ok: true, messageId: p.igPostId }));
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({
        foo: [
          post('NEW2', { takenAtMs: 7_000 }),
          post('NEW1', { takenAtMs: 6_000 }),
          post('SAME', { takenAtMs: 5_000 }), // exactly at anchor time → excluded
        ],
      }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({
        relevant: true,
        type: 'evento',
        title: 't',
        summary: 's',
        when: null,
        where: null,
        tags: [],
      }),
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    // Only the two strictly-newer posts, oldest-first; SAME (== anchor time) excluded.
    expect(publish.mock.calls.map((c) => (c[3] as RecentPost).igPostId)).toEqual(['NEW1', 'NEW2']);
    expect(store.getAccount('foo')?.last_post_id).toBe('NEW2');
    expect(store.getAccount('foo')?.last_post_at).toBe(7_000);
    mem.close();
  });

  test('seeding records the anchor capture time', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({
        foo: [post('P2', { takenAtMs: 9_000 }), post('P1', { takenAtMs: 8_000 })],
      }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(store.getAccount('foo')?.last_post_id).toBe('P2');
    expect(store.getAccount('foo')?.last_post_at).toBe(9_000);
    mem.close();
  });
});
