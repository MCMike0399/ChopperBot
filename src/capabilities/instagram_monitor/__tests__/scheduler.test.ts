import { describe, test, expect, vi } from 'vitest';
import type { Client } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { InstagramMonitorStore, INSTAGRAM_MONITOR_MIGRATIONS } from '../store.js';
import { InstagramMonitorScheduler } from '../scheduler.js';
import {
  InstagramAuthError,
  InstagramRateLimitError,
  type InstagramFetcher,
  type RecentPost,
} from '../fetcher.js';
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
  return {    async fetchRecentPosts(u) {
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
    const broken: InstagramFetcher = {      async fetchRecentPosts() {
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
    const fetcher: InstagramFetcher = {      async fetchRecentPosts() {
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

  test('inconsistent row (anchor id older than anchor time) does not backfill', async () => {
    // The v3 migration backfills last_post_at = MAX(seen posted_at) without
    // touching last_post_id, so a row that was mid-bug can end up with
    // last_post_id pointing at a post OLDER than last_post_at. If that old
    // anchor post reappears in the window with posts between it and the anchor
    // time, the time-floor must still suppress them.
    const { store, mem } = await newStore();
    store.upsertAccount({ username: 'foo', added_by: 'U' });
    const id = store.getAccount('foo')!.id;
    // Anchor id points at t=2000, but recorded anchor time is t=5000.
    store.markPollSuccess(id, 1, 'OLDANCHOR', 5_000);

    const publish = vi.fn(async () => ({ ok: true, messageId: 'm' } as PublishResult));
    const classify = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({
        foo: [
          post('MID2', { takenAtMs: 4_000 }), // between anchor id and anchor time
          post('MID1', { takenAtMs: 3_000 }),
          post('OLDANCHOR', { takenAtMs: 2_000 }), // anchor present, but old
        ],
      }),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify,
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    // MID1/MID2 are above the anchor id but <= anchor time → suppressed.
    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.getAccount('foo')?.last_post_at).toBe(5_000);
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

describe('InstagramMonitorScheduler — guardrails', () => {
  /** A fetcher that counts calls and can throw a chosen error. */
  function spyFetcher(err?: Error): InstagramFetcher & { calls: () => number } {
    let n = 0;
    return {      calls: () => n,
      async fetchRecentPosts() {
        n++;
        if (err) throw err;
        return [];
      },
    };
  }

  test('global_stop halts the tick entirely — nothing is fetched', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'P0');
    store.tripGlobalStop('flagged earlier', Date.now());
    const fetcher = spyFetcher();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher,
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(fetcher.calls()).toBe(0);
    mem.close();
  });

  test('a single 429 sets a cooldown that halts the next tick (other accounts spared)', async () => {
    const { store, mem } = await newStore();
    const now = Date.now();
    const a = store.upsertAccount({ username: 'aaa', added_by: 'U' });
    const b = store.upsertAccount({ username: 'bbb', added_by: 'U' });
    // aaa is the oldest poll → picked first (ACCOUNTS_PER_TICK=1).
    store.markPollSuccess(a.account.id, now - 20 * 60 * 60 * 1000, 'A0');
    store.markPollSuccess(b.account.id, now - 19 * 60 * 60 * 1000, 'B0');

    const publish = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      // aaa throttles; bbb would return a post if it were ever polled.
      fetcher: {        async fetchRecentPosts(u: string) {
          if (u === 'aaa') throw new InstagramRateLimitError('throttled (HTTP 429)');
          return [post('B1')];
        },
      },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({ relevant: true, type: 'evento', title: 't', summary: 's', when: null, where: null, tags: [] }),
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce(); // polls aaa → 429 → global cooldown
    await sch.tickOnce(); // skipped by cooldown → bbb never polled

    expect(publish).not.toHaveBeenCalled();
    expect(store.getAccount('bbb')?.last_post_id).toBe('B0'); // untouched
    // One throttle isn't enough to trip the persistent breaker.
    expect(store.isGlobalStopped()).toBe(false);
    mem.close();
  });

  test('a second 429 within the window trips the persistent breaker', async () => {
    const { store, mem } = await newStore();
    const now = Date.now();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, now - 20 * 60 * 60 * 1000, 'P0');
    store.record429Event(now - 60_000); // one prior throttle in the window
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: spyFetcher(new InstagramRateLimitError('throttled (HTTP 429)')),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(store.isGlobalStopped()).toBe(true);
    mem.close();
  });

  test('a session-level auth failure (checkpoint) trips the breaker immediately', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'P0');
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: spyFetcher(
        new InstagramAuthError('Instagram rejected ...', 'HTTP 400 checkpoint_required'),
      ),
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(store.isGlobalStopped()).toBe(true);
    mem.close();
  });

  test('an account-specific 401 does NOT trip the breaker or halt other accounts', async () => {
    // Regression: a bare 401/403 on one restricted handle must not be treated as
    // session death — it would stop the whole monitor. It just auto-pauses that
    // one account via the per-account auth counter.
    const { store, mem } = await newStore();
    const now = Date.now();
    const bad = store.upsertAccount({ username: 'restricted', added_by: 'U' });
    const good = store.upsertAccount({ username: 'healthy', added_by: 'U' });
    store.markPollSuccess(bad.account.id, now - 20 * 60 * 60 * 1000, 'R0');
    // Anchor H0 present in the window (with a recorded time) so the new post
    // above it publishes normally.
    store.markPollSuccess(good.account.id, now - 19 * 60 * 60 * 1000, 'H0', 1_000);

    const publish = vi.fn(async () => ({ ok: true, messageId: 'm' } as PublishResult));
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: {        async fetchRecentPosts(u: string) {
          if (u === 'restricted') {
            throw new InstagramAuthError('rejected feed (HTTP 401)', 'HTTP 401');
          }
          return [post('H1', { takenAtMs: 2_000 }), post('H0', { takenAtMs: 1_000 })];
        },
      },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => ({ relevant: true, type: 'evento', title: 't', summary: 's', when: null, where: null, tags: [] }),
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce(); // polls 'restricted' (oldest) → bare 401, isolated
    expect(store.isGlobalStopped()).toBe(false);
    expect(store.getAccount('restricted')?.consecutive_auth_failures).toBe(1);
    await sch.tickOnce(); // NOT in an auth cooldown → 'healthy' polls normally
    expect(publish).toHaveBeenCalled();
    mem.close();
  });

  test('the daily request budget soft-pauses the next tick and alerts once', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'P0');

    // Fetcher that reports 2 outbound HTTP requests per poll via the observer.
    let cb = () => {};
    const fetcher: InstagramFetcher = {      observeRequests(c) { cb = c; },
      async fetchRecentPosts() { cb(); cb(); return []; },
    };
    const notifyBudgetExhausted = vi.fn(async () => {});
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher,
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
      dailyRequestBudget: 2,
      notifyBudgetExhausted,
    });
    await sch.tickOnce(); // polls once → 2 requests recorded
    await sch.tickOnce(); // 2 >= budget(2) → soft-pause + alert
    expect(notifyBudgetExhausted).toHaveBeenCalledTimes(1);
    expect(notifyBudgetExhausted).toHaveBeenCalledWith({ requests24h: 2, budget: 2 });
    mem.close();
  });
});

const REL = {
  relevant: true,
  type: 'evento',
  title: 't',
  summary: 's',
  when: null,
  where: null,
  tags: [],
} as const;

describe('InstagramMonitorScheduler — resume alerts', () => {
  test('fires once when polling resumes after the budget window drains', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'P0');
    let cb = () => {};
    const fetcher: InstagramFetcher = {      observeRequests(c) {
        cb = c;
      },
      async fetchRecentPosts() {
        cb();
        cb();
        return [];
      },
    };
    const notifyResumed = vi.fn(async () => {});
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher,
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
      dailyRequestBudget: 2,
      notifyResumed,
      resumeDebounceMs: 0,
      resumeCooldownMs: 0,
    });
    await sch.tickOnce(); // polls foo → 2 requests
    await sch.tickOnce(); // budget hit → blocked('budget')
    expect(notifyResumed).not.toHaveBeenCalled();
    // Drain the rolling-24h window so the budget recovers.
    (sch as unknown as { requestTimestamps: number[] }).requestTimestamps = [];
    await sch.tickOnce(); // budget ok → resume announced
    expect(notifyResumed).toHaveBeenCalledTimes(1);
    expect(notifyResumed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'budget' }),
    );
    mem.close();
  });

  test('fires once when the kill-switch is cleared (running process)', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'P0');
    store.tripGlobalStop('flagged', Date.now());
    const notifyResumed = vi.fn(async () => {});
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: { async fetchRecentPosts() { return []; } },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
      notifyResumed,
      resumeDebounceMs: 0,
      resumeCooldownMs: 0,
    });
    await sch.tickOnce(); // global_stop → blocked('killswitch')
    expect(notifyResumed).not.toHaveBeenCalled();
    store.clearGlobalStop();
    await sch.tickOnce(); // resume announced
    await sch.tickOnce(); // already 'none' → not announced again
    expect(notifyResumed).toHaveBeenCalledTimes(1);
    expect(notifyResumed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'killswitch' }),
    );
    mem.close();
  });

  test('quiet hours do NOT trigger a resume alert', async () => {
    vi.useFakeTimers();
    try {
      const { store, mem } = await newStore();
      const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
      store.markPollSuccess(a.account.id, 0, 'P0');
      const notifyResumed = vi.fn(async () => {});
      const sch = new InstagramMonitorScheduler({
        store,
        fetcher: { async fetchRecentPosts() { return []; } },
        client: fakeClient,
        getBoundChannels: ONE_CHANNEL,
        classify: vi.fn(),
        publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
        fetchCover: async () => null,
        notifyResumed,
        resumeDebounceMs: 0,
        resumeCooldownMs: 0,
      });
      // 04:00 in Mexico City (10:00 UTC) — inside quiet hours.
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 30, 10, 0, 0)));
      await sch.tickOnce(); // returns at the quiet-hours gate, no block recorded
      // 12:00 in Mexico City (18:00 UTC) — active again.
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 30, 18, 0, 0)));
      await sch.tickOnce(); // proceeds, but was never abnormally blocked
      expect(notifyResumed).not.toHaveBeenCalled();
      mem.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InstagramMonitorScheduler — adaptive cadence wiring', () => {
  /** Pre-seed `count` already-seen posts spanning > 3 days so cadence is trustable. */
  function seedHistory(
    store: InstagramMonitorStore,
    username: string,
    baseT: number,
    count: number,
    gapMs: number,
  ): void {
    for (let i = 0; i < count; i++) {
      store.recordSeen({
        channel_id: CHAN,
        ig_post_id: `H${i}`,
        account_username: username,
        caption: null,
        media_type: 'image',
        posted_at: baseT - i * gapMs,
        classification_json: null,
        pushed: true,
        discord_message_id: null,
      });
    }
  }

  test('opportunistic recompute fires when new posts are detected', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    const T = Date.now() - 60 * 60 * 1000;
    seedHistory(store, 'foo', T, 14, 7 * 60 * 60 * 1000); // 14 posts, ~91h span
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'H0', T);
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: {        async fetchRecentPosts() {
          return [post('NEW', { takenAtMs: T + 3_600_000 }), post('H0', { takenAtMs: T })];
        },
      },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: async () => REL,
      publish: (async () => ({ ok: true, messageId: 'm' })) as unknown as (
        ...args: unknown[]
      ) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    // Suppress the daily sweep so we're observing ONLY the opportunistic recompute.
    (sch as unknown as { lastCadenceSweepAtMs: number }).lastCadenceSweepAtMs = Date.now();
    await sch.tickOnce();
    const acc = store.getAccount('foo')!;
    expect(acc.poll_interval_ms).not.toBeNull();
    expect(acc.cadence_updated_at).not.toBeNull();
    mem.close();
  });

  test('no opportunistic recompute when a poll finds nothing new', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    const T = Date.now() - 60 * 60 * 1000;
    seedHistory(store, 'foo', T, 14, 7 * 60 * 60 * 1000);
    store.markPollSuccess(a.account.id, Date.now() - 20 * 60 * 60 * 1000, 'H0', T);
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: {        async fetchRecentPosts() {
          return [post('H0', { takenAtMs: T })]; // only the anchor → nothing newer
        },
      },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    (sch as unknown as { lastCadenceSweepAtMs: number }).lastCadenceSweepAtMs = Date.now();
    await sch.tickOnce();
    expect(store.getAccount('foo')!.cadence_updated_at).toBeNull();
    mem.close();
  });

  test('daily sweep runs once per TTL (from the finally block)', async () => {
    const { store, mem } = await newStore();
    const a = store.upsertAccount({ username: 'foo', added_by: 'U' });
    // Not due (just polled) → no polling/opportunistic work; only the sweep can run.
    store.markPollSuccess(a.account.id, Date.now(), 'P0');
    const spy = vi.spyOn(store, 'recomputeAllCadence');
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: { async fetchRecentPosts() { return []; } },
      client: fakeClient,
      getBoundChannels: ONE_CHANNEL,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    await sch.tickOnce(); // immediate → within TTL → must not re-sweep
    expect(spy).toHaveBeenCalledTimes(1);
    mem.close();
  });
});

describe('InstagramMonitorScheduler — status digest', () => {
  function digestScheduler(store: InstagramMonitorStore, notifyStatusDigest: () => Promise<void>) {
    return new InstagramMonitorScheduler({
      store,
      fetcher: { async fetchRecentPosts() { return []; } },
      client: fakeClient,
      getBoundChannels: NO_CHANNELS,
      classify: vi.fn(),
      publish: vi.fn() as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
      notifyStatusDigest,
    });
  }

  test('posts once per local day at the digest hour, and again the next day', async () => {
    vi.useFakeTimers();
    try {
      const { store, mem } = await newStore();
      const notifyStatusDigest = vi.fn(async () => {});
      const sch = digestScheduler(store, notifyStatusDigest);
      // 21:00 America/Mexico_City = 03:00 UTC the next calendar day.
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 31, 3, 0, 0)));
      await sch.tickOnce();
      await sch.tickOnce(); // same hour, same day → no second post
      expect(notifyStatusDigest).toHaveBeenCalledTimes(1);
      // Next day, same hour → posts again.
      vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 3, 0, 0)));
      await sch.tickOnce();
      expect(notifyStatusDigest).toHaveBeenCalledTimes(2);
      mem.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not post outside the digest hour', async () => {
    vi.useFakeTimers();
    try {
      const { store, mem } = await newStore();
      const notifyStatusDigest = vi.fn(async () => {});
      const sch = digestScheduler(store, notifyStatusDigest);
      // 19:00 Mexico City (01:00 UTC next day) — not the digest hour.
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 31, 1, 0, 0)));
      await sch.tickOnce();
      expect(notifyStatusDigest).not.toHaveBeenCalled();
      mem.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
