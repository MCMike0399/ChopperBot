import { describe, test, expect, vi, afterEach } from 'vitest';
import { LambdaInstagramFetcher, DirectInstagramFetcher } from '../fetcher.js';
import type { LambdaRelay } from '../lambda-relay-client.js';

function buildIgResponse(items: Array<Partial<Record<string, unknown>>>): string {
  return JSON.stringify({
    data: {
      user: {
        edge_owner_to_timeline_media: {
          edges: items.map((node) => ({ node })),
        },
      },
    },
  });
}

const SAMPLE_NODE = {
  id: '3001',
  shortcode: 'AAA',
  display_url: 'https://cdn.example/image.jpg',
  is_video: false,
  taken_at_timestamp: 1_700_000_000,
  __typename: 'GraphImage',
  edge_media_to_caption: { edges: [{ node: { text: 'caption text' } }] },
};

describe('LambdaInstagramFetcher', () => {
  test('parses normalized RecentPost from a single-image response', async () => {
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return { statusCode: 200, body: buildIgResponse([SAMPLE_NODE]) };
      },
    };
    const f = new LambdaInstagramFetcher(relay);
    const posts = await f.fetchRecentPosts('foo');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      igPostId: '3001',
      shortcode: 'AAA',
      caption: 'caption text',
      mediaType: 'image',
      takenAtMs: 1_700_000_000_000,
      displayUrl: 'https://cdn.example/image.jpg',
    });
    expect(f.source()).toBe('lambda');
  });

  test('throws on non-200 Lambda response', async () => {
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return { statusCode: 401, body: 'rate limited' };
      },
    };
    const f = new LambdaInstagramFetcher(relay);
    await expect(f.fetchRecentPosts('foo')).rejects.toThrow(/HTTP 401/);
  });

  test('parses video node with video_url', async () => {
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return {
          statusCode: 200,
          body: buildIgResponse([
            {
              ...SAMPLE_NODE,
              id: 'v1',
              shortcode: 'VVV',
              is_video: true,
              video_url: 'https://cdn.example/v.mp4',
              __typename: 'GraphVideo',
            },
          ]),
        };
      },
    };
    const f = new LambdaInstagramFetcher(relay);
    const [p] = await f.fetchRecentPosts('foo');
    expect(p.mediaType).toBe('video');
    expect(p.videoUrl).toBe('https://cdn.example/v.mp4');
  });

  test('parses carousel with multiple image children', async () => {
    const carouselNode = {
      ...SAMPLE_NODE,
      id: 'c1',
      shortcode: 'CCC',
      __typename: 'GraphSidecar',
      edge_sidecar_to_children: {
        edges: [
          { node: { display_url: 'https://cdn.example/c1.jpg', is_video: false } },
          { node: { display_url: 'https://cdn.example/c2.jpg', is_video: false } },
        ],
      },
    };
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return { statusCode: 200, body: buildIgResponse([carouselNode]) };
      },
    };
    const [p] = await new LambdaInstagramFetcher(relay).fetchRecentPosts('foo');
    expect(p.mediaType).toBe('carousel');
    expect(p.carouselUrls).toEqual([
      'https://cdn.example/c1.jpg',
      'https://cdn.example/c2.jpg',
    ]);
  });

  test('skips malformed nodes but returns the rest', async () => {
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return {
          statusCode: 200,
          body: buildIgResponse([SAMPLE_NODE, { id: 'broken' }]),
        };
      },
    };
    const posts = await new LambdaInstagramFetcher(relay).fetchRecentPosts('foo');
    expect(posts).toHaveLength(1);
    expect(posts[0].igPostId).toBe('3001');
  });

  test('throws on non-JSON body', async () => {
    const relay: LambdaRelay = {
      async fetchWebProfile() {
        return { statusCode: 200, body: '<html>blocked</html>' };
      },
    };
    await expect(
      new LambdaInstagramFetcher(relay).fetchRecentPosts('foo'),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe('DirectInstagramFetcher', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('uses global fetch and parses body', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return buildIgResponse([SAMPLE_NODE]);
      },
    })) as unknown as typeof fetch;
    const f = new DirectInstagramFetcher();
    expect(f.source()).toBe('direct');
    const posts = await f.fetchRecentPosts('foo');
    expect(posts).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test('throws on non-200 from direct fetch', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      async text() {
        return 'rate limited';
      },
    })) as unknown as typeof fetch;
    await expect(new DirectInstagramFetcher().fetchRecentPosts('foo')).rejects.toThrow(
      /HTTP 429/,
    );
  });
});
