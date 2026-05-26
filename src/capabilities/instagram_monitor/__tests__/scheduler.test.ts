import { describe, test, expect, vi } from 'vitest';
import type { Client } from 'discord.js';
import { SqliteMemoryStore, NamespacedMemory } from '../../../memory/store.js';
import { InstagramMonitorStore, INSTAGRAM_MONITOR_MIGRATIONS } from '../store.js';
import { InstagramMonitorScheduler } from '../scheduler.js';
import type { InstagramFetcher, RecentPost } from '../fetcher.js';
import type { Classification } from '../classifier.js';
import type { PublishResult } from '../publisher.js';

const CHAN = '111111111111111111';

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
    store.upsertAccount({ channel_id: CHAN, username: 'foo', added_by: 'U' });
    const publish = vi.fn();
    const classify = vi.fn();
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: [post('P3'), post('P2'), post('P1')] }),
      client: fakeClient,
      classify,
      publish: publish as unknown as (...args: unknown[]) => Promise<PublishResult>,
      fetchCover: async () => null,
    });
    await sch.tickOnce();
    expect(classify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.getAccount(CHAN, 'foo')?.last_post_id).toBe('P3');
    mem.close();
  });

  test('publishes only LLM-relevant posts; records pushed=0 for skipped', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: CHAN, username: 'foo', added_by: 'U' });
    // Seed so it's not the first poll.
    store.markPollSuccess(store.getAccount(CHAN, 'foo')!.id, 1, 'P0');
    // Force due immediately.
    store.resetLastPost(CHAN, 'foo');
    store.markPollSuccess(store.getAccount(CHAN, 'foo')!.id, 1, 'P0');

    const classify = vi.fn(async (_account: string, p: RecentPost): Promise<Classification> => {
      // P2 = relevant evento; P1 = skip
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
      classify,
      publish,
      fetchCover: async () => null,
    });
    await sch.tickOnce();

    expect(classify).toHaveBeenCalledTimes(2); // P1, P2 — not P0 (anchor)
    expect(publish).toHaveBeenCalledTimes(1);
    const publishedShortcodes = publish.mock.calls.map((c) => (c[3] as RecentPost).shortcode);
    expect(publishedShortcodes).toEqual(['P2']);
    // Both seen rows written. Anchor moved to P2.
    expect(store.hasSeen(CHAN, 'P1')).toBe(true);
    expect(store.hasSeen(CHAN, 'P2')).toBe(true);
    expect(store.getAccount(CHAN, 'foo')?.last_post_id).toBe('P2');
    // Only the pushed post shows up in recentPushed.
    expect(store.recentPushed(CHAN, 10).map((s) => s.ig_post_id)).toEqual(['P2']);
    mem.close();
  });

  test('processes posts oldest-first so Discord sees them in posted order', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: CHAN, username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount(CHAN, 'foo')!.id, 1, 'P0');

    const order: string[] = [];
    const publish = vi.fn(async (..._args) => {
      const p = arguments[3] as RecentPost; // placeholder, replaced below
      return { ok: true, messageId: 'm' } as PublishResult;
    });
    // Replace publish with a properly typed capture
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
    // P1, P2, P3 were new (P0 is the anchor). Should be published in
    // chronological order: P1 → P2 → P3.
    expect(order).toEqual(['P1', 'P2', 'P3']);
    mem.close();
    // Silence unused
    void publish;
  });

  test('marks failure + advances backoff on fetch error', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: CHAN, username: 'foo', added_by: 'U' });
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
    const a = store.getAccount(CHAN, 'foo')!;
    expect(a.consecutive_failures).toBe(1);
    expect(a.last_polled_at).not.toBeNull();
    mem.close();
  });

  test('caps pushes per account per tick', async () => {
    const { store, mem } = await newStore();
    store.upsertAccount({ channel_id: CHAN, username: 'foo', added_by: 'U' });
    store.markPollSuccess(store.getAccount(CHAN, 'foo')!.id, 1, 'P0');

    const posts: RecentPost[] = [];
    for (let i = 10; i > 0; i--) posts.push(post(`P${i}`));
    posts.push(post('P0'));

    const publish = vi.fn(async () => ({ ok: true, messageId: 'm' } as PublishResult));
    const sch = new InstagramMonitorScheduler({
      store,
      fetcher: fakeFetcher({ foo: posts }),
      client: fakeClient,
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
    // Cap is 5 pushes per account per tick — older overflowed posts are
    // recorded with pushed=0 and skipped reason.
    expect(publish).toHaveBeenCalledTimes(5);
    // All 10 new posts should be marked seen, plus the 5 non-pushed get the
    // rate-limited reason.
    for (let i = 1; i <= 10; i++) expect(store.hasSeen(CHAN, `P${i}`)).toBe(true);
    expect(store.getAccount(CHAN, 'foo')?.last_post_id).toBe('P10');
    mem.close();
  });
});
