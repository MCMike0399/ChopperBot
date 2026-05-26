import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  LambdaInstagramFetcher,
  DirectInstagramFetcher,
  parseUserFeedBody,
  InstagramAuthError,
  type InstagramAuth,
} from '../fetcher.js';
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

const AUTH: InstagramAuth = {
  sessionid: 'sid',
  csrftoken: 'csrf',
  dsUserId: '999',
};

function feedItem(id: string, code: string): Record<string, unknown> {
  return {
    id: `${id}_999`,
    pk: Number(id),
    code,
    taken_at: 1_700_000_000,
    media_type: 1,
    caption: { text: 'hi' },
    image_versions2: { candidates: [{ url: `https://cdn/${code}.jpg` }] },
  };
}

describe('DirectInstagramFetcher (authenticated)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('resolves pk via web_profile_info then reads feed/user, caching the pk', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('web_profile_info')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: { user: { id: '5005' } } });
          },
        };
      }
      // feed/user
      expect(url).toContain('/feed/user/5005/');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ status: 'ok', items: [feedItem('3001', 'AAA')] });
        },
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const f = new DirectInstagramFetcher(AUTH);
    expect(f.authenticated()).toBe(true);

    const posts = await f.fetchRecentPosts('foo');
    expect(posts).toHaveLength(1);
    expect(posts[0].igPostId).toBe('3001');
    // First call: resolve pk + feed = 2 requests.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call reuses the cached pk: only the feed request fires.
    await f.fetchRecentPosts('foo');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('401 on the authed feed surfaces InstagramAuthError', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('web_profile_info')) {
        return { ok: true, status: 200, async text() {
          return JSON.stringify({ data: { user: { id: '5005' } } });
        } };
      }
      return { ok: false, status: 401, async text() { return 'login_required'; } };
    }) as unknown as typeof fetch;

    await expect(new DirectInstagramFetcher(AUTH).fetchRecentPosts('foo')).rejects.toBeInstanceOf(
      InstagramAuthError,
    );
  });

  test('require_login during pk resolution surfaces InstagramAuthError', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ require_login: true, status: 'fail' });
      },
    })) as unknown as typeof fetch;

    await expect(new DirectInstagramFetcher(AUTH).fetchRecentPosts('foo')).rejects.toBeInstanceOf(
      InstagramAuthError,
    );
  });
});

describe('parseUserFeedBody (private feed/user shape)', () => {
  test('recovers the exact bare pk from the string id (numeric pk is lossy)', () => {
    const body = JSON.stringify({
      status: 'ok',
      items: [
        {
          id: '3905752326674602653_62427593254',
          pk: 3905752326674602653,
          code: 'DY0BQwsGFqd',
          taken_at: 1779821981,
          media_type: 8,
          caption: { text: 'carrusel' },
          image_versions2: { candidates: [{ url: 'https://cdn/cover.jpg' }] },
          carousel_media: [
            { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/c1.jpg' }] } },
            {
              media_type: 2,
              image_versions2: { candidates: [{ url: 'https://cdn/c2.jpg' }] },
              video_versions: [{ url: 'https://cdn/c2.mp4' }],
            },
          ],
        },
        {
          id: '3904328634825703202_45758433140',
          pk: 3904328634825703202,
          code: 'DYu9jUVK_8i',
          taken_at: 1779652311,
          media_type: 2,
          caption: { text: 'video' },
          image_versions2: { candidates: [{ url: 'https://cdn/vcover.jpg' }] },
          video_versions: [{ url: 'https://cdn/v.mp4' }],
        },
        {
          id: '3897145926033003902_62427593254',
          code: 'DYVcZJfDtV-',
          taken_at: 1778796018,
          media_type: 1,
          caption: null,
          image_versions2: { candidates: [{ url: 'https://cdn/img.jpg' }] },
        },
      ],
    });
    const [carousel, video, image] = parseUserFeedBody(body);

    expect(carousel.igPostId).toBe('3905752326674602653');
    expect(carousel.mediaType).toBe('carousel');
    expect(carousel.takenAtMs).toBe(1779821981 * 1000);
    expect(carousel.carouselUrls).toEqual(['https://cdn/c1.jpg', 'https://cdn/c2.jpg']);
    expect(carousel.carouselVideoUrls).toEqual([null, 'https://cdn/c2.mp4']);

    expect(video.igPostId).toBe('3904328634825703202');
    expect(video.mediaType).toBe('video');
    expect(video.videoUrl).toBe('https://cdn/v.mp4');

    expect(image.igPostId).toBe('3897145926033003902');
    expect(image.mediaType).toBe('image');
    expect(image.caption).toBe('');
  });

  test('missing/empty items yields no posts; require_login throws', () => {
    expect(parseUserFeedBody(JSON.stringify({ status: 'ok' }))).toEqual([]);
    expect(parseUserFeedBody(JSON.stringify({ items: [] }))).toEqual([]);
    expect(() => parseUserFeedBody(JSON.stringify({ require_login: true }))).toThrow(
      InstagramAuthError,
    );
    expect(() => parseUserFeedBody('<html>')).toThrow(/non-JSON/);
  });
});
