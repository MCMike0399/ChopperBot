import { log } from '../../log.js';
import type { LambdaRelay } from './lambda-relay-client.js';

export interface RecentPost {
  igPostId: string;
  shortcode: string;
  caption: string;
  takenAtMs: number;
  mediaType: 'image' | 'video' | 'carousel';
  /** Best single image to use for previews / classification (cover frame). */
  displayUrl: string;
  /** Set when the top-level media is a video. */
  videoUrl?: string;
  /** Set when the top-level media is a carousel: image URLs in display order. */
  carouselUrls?: string[];
  /** Set when items in a carousel are videos (parallel to carouselUrls; null if image). */
  carouselVideoUrls?: (string | null)[];
}

export interface InstagramFetcher {
  fetchRecentPosts(username: string): Promise<RecentPost[]>;
  /** Where this fetcher gets its data — useful for logs and admin reports. */
  source(): 'lambda' | 'direct';
}

const IG_URL = (u: string) =>
  `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;

// Node's undici fetch auto-sends `sec-fetch-site: cross-site` for requests
// to i.instagram.com. Instagram rejects that with HTTP 400 "SecFetch Policy
// violation" — even though curl works fine, because curl doesn't send any
// sec-fetch-* headers. We override them to look like a same-site XHR fired
// from www.instagram.com.
const HEADERS: Record<string, string> = {
  'x-ig-app-id': '936619743392459',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.instagram.com/',
  Origin: 'https://www.instagram.com',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

/** Wraps an injected LambdaRelay. Production path. */
export class LambdaInstagramFetcher implements InstagramFetcher {
  constructor(private readonly relay: LambdaRelay) {}

  source(): 'lambda' {
    return 'lambda';
  }

  async fetchRecentPosts(username: string): Promise<RecentPost[]> {
    const res = await this.relay.fetchWebProfile(username);
    if (res.statusCode !== 200) {
      throw new Error(`Instagram returned HTTP ${res.statusCode} (via Lambda)`);
    }
    return parseWebProfileBody(res.body);
  }
}

/** Direct fetch from the Node process. Used in dev when LAMBDA_ARN is unset. */
export class DirectInstagramFetcher implements InstagramFetcher {
  source(): 'direct' {
    return 'direct';
  }

  async fetchRecentPosts(username: string): Promise<RecentPost[]> {
    const res = await fetch(IG_URL(username), { headers: HEADERS });
    if (!res.ok) {
      throw new Error(`Instagram returned HTTP ${res.status} (direct)`);
    }
    const body = await res.text();
    return parseWebProfileBody(body);
  }
}

function parseWebProfileBody(body: string): RecentPost[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `web_profile_info returned non-JSON: ${err instanceof Error ? err.message : String(err)} (body starts: ${body.slice(0, 80)})`,
    );
  }
  const user = (json as { data?: { user?: unknown } }).data?.user;
  if (!user || typeof user !== 'object') {
    throw new Error('web_profile_info response missing data.user');
  }
  const edges = (user as {
    edge_owner_to_timeline_media?: { edges?: unknown[] };
  }).edge_owner_to_timeline_media?.edges;
  if (!Array.isArray(edges)) return [];

  const out: RecentPost[] = [];
  for (const e of edges) {
    const node = (e as { node?: unknown }).node;
    if (!node || typeof node !== 'object') continue;
    try {
      out.push(normalizeNode(node as Record<string, unknown>));
    } catch (err) {
      log.warn({ err }, 'Skipping malformed IG media node');
    }
  }
  return out;
}

function normalizeNode(node: Record<string, unknown>): RecentPost {
  const id = asString(node.id, 'id');
  const shortcode = asString(node.shortcode, 'shortcode');
  const takenAtSec = asNumber(node.taken_at_timestamp, 'taken_at_timestamp');
  const isVideo = node.is_video === true;
  const typeName = asString(node.__typename, '__typename', false) ?? '';
  const isCarousel = typeName === 'GraphSidecar';
  const displayUrl = asString(node.display_url, 'display_url');
  const videoUrl = node.video_url !== undefined ? asString(node.video_url, 'video_url') : undefined;

  const captionEdges =
    (node.edge_media_to_caption as { edges?: { node?: { text?: unknown } }[] } | undefined)?.edges ??
    [];
  const caption =
    captionEdges.length > 0 && typeof captionEdges[0].node?.text === 'string'
      ? (captionEdges[0].node.text as string)
      : '';

  let mediaType: RecentPost['mediaType'];
  let carouselUrls: string[] | undefined;
  let carouselVideoUrls: (string | null)[] | undefined;
  if (isCarousel) {
    mediaType = 'carousel';
    const children =
      (node.edge_sidecar_to_children as { edges?: { node?: Record<string, unknown> }[] } | undefined)
        ?.edges ?? [];
    carouselUrls = [];
    carouselVideoUrls = [];
    for (const childEdge of children) {
      const child = childEdge.node;
      if (!child) continue;
      const childDisplay = asString(child.display_url, 'sidecar.display_url', false);
      if (childDisplay) carouselUrls.push(childDisplay);
      const childIsVideo = child.is_video === true;
      const childVideo = childIsVideo
        ? asString(child.video_url, 'sidecar.video_url', false) ?? null
        : null;
      carouselVideoUrls.push(childVideo);
    }
  } else if (isVideo) {
    mediaType = 'video';
  } else {
    mediaType = 'image';
  }

  return {
    igPostId: id,
    shortcode,
    caption,
    takenAtMs: takenAtSec * 1000,
    mediaType,
    displayUrl,
    videoUrl,
    carouselUrls,
    carouselVideoUrls,
  };
}

function asString(v: unknown, field: string, required = true): string {
  if (typeof v === 'string' && v.length > 0) return v;
  if (!required) return '';
  throw new Error(`Expected string at "${field}", got ${typeof v}`);
}

function asNumber(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`Expected number at "${field}", got ${typeof v}`);
}
