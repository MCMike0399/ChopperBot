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

/** Logged-in Instagram session cookies. When present, direct fetches use them
 * to get higher rate limits than anonymous requests. */
export interface InstagramAuth {
  sessionid: string;
  csrftoken: string;
  dsUserId: string;
  mid?: string;
  igDid?: string;
}

/** Thrown when an *authenticated* request is rejected in a way that means the
 * IG session is invalid/expired (as opposed to plain anonymous throttling).
 * The scheduler turns this into an `instagram_monitor.auth.expired` log so the
 * watcher can alert the operator to refresh the cookies. */
export class InstagramAuthError extends Error {
  readonly authExpired = true;
  constructor(message: string) {
    super(message);
    this.name = 'InstagramAuthError';
  }
}

function authCookieHeaders(auth: InstagramAuth): Record<string, string> {
  const parts = [
    `sessionid=${auth.sessionid}`,
    `csrftoken=${auth.csrftoken}`,
    `ds_user_id=${auth.dsUserId}`,
  ];
  if (auth.mid) parts.push(`mid=${auth.mid}`);
  if (auth.igDid) parts.push(`ig_did=${auth.igDid}`);
  return { Cookie: parts.join('; '), 'x-csrftoken': auth.csrftoken };
}

const IG_URL = (u: string) =>
  `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;
const IG_FEED_URL = (pk: string, count = 12) =>
  `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(pk)}/?count=${count}`;

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

/** Direct fetch from the Node process. Used when LAMBDA_ARN is unset.
 *
 * Two modes:
 *  - **Anonymous** (no auth): hits the public `web_profile_info` GraphQL
 *    endpoint, which returns timeline media but is heavily IP-throttled.
 *  - **Authenticated** (session cookies present): resolves the account's
 *    numeric pk once (cached), then reads the private `feed/user/{pk}`
 *    endpoint that logged-in clients use. The authed `web_profile_info`
 *    returns an EMPTY timeline, so feed/user is required to actually see
 *    posts. Authed requests get far higher rate limits.
 */
export class DirectInstagramFetcher implements InstagramFetcher {
  private readonly pkCache = new Map<string, string>();

  constructor(private readonly auth: InstagramAuth | null = null) {}

  source(): 'direct' {
    return 'direct';
  }

  /** Whether this fetcher is sending logged-in session cookies. */
  authenticated(): boolean {
    return this.auth !== null;
  }

  async fetchRecentPosts(username: string): Promise<RecentPost[]> {
    if (this.auth) {
      const pk = await this.resolvePk(username, this.auth);
      return this.fetchAuthedFeed(pk, this.auth);
    }
    const res = await fetch(IG_URL(username), { headers: HEADERS });
    if (!res.ok) {
      throw new Error(`Instagram returned HTTP ${res.status} (direct)`);
    }
    return parseWebProfileBody(await res.text());
  }

  /** username → numeric pk, cached (pk is stable for the lifetime of a handle).
   * Uses the authed web_profile_info, which returns the profile (incl. id)
   * even though it omits timeline media. */
  private async resolvePk(username: string, auth: InstagramAuth): Promise<string> {
    const cached = this.pkCache.get(username);
    if (cached) return cached;
    const headers = { ...HEADERS, ...authCookieHeaders(auth) };
    const res = await fetch(IG_URL(username), { headers });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new InstagramAuthError(
          `Instagram rejected an authenticated profile lookup (HTTP ${res.status}) — session likely expired`,
        );
      }
      throw new Error(`Instagram returned HTTP ${res.status} resolving @${username} (direct)`);
    }
    let json: { data?: { user?: { id?: unknown } }; require_login?: unknown };
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new Error(`web_profile_info returned non-JSON resolving @${username}`);
    }
    if (json.require_login) {
      throw new InstagramAuthError('web_profile_info returned require_login — session expired');
    }
    const pk = json.data?.user?.id;
    if (typeof pk !== 'string' || pk.length === 0) {
      throw new Error(`Could not resolve pk for @${username}`);
    }
    this.pkCache.set(username, pk);
    return pk;
  }

  private async fetchAuthedFeed(pk: string, auth: InstagramAuth): Promise<RecentPost[]> {
    const headers = { ...HEADERS, ...authCookieHeaders(auth) };
    const res = await fetch(IG_FEED_URL(pk), { headers });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new InstagramAuthError(
          `Instagram rejected an authenticated feed request (HTTP ${res.status}) — session likely expired`,
        );
      }
      throw new Error(`Instagram returned HTTP ${res.status} on feed/user (direct)`);
    }
    return parseUserFeedBody(await res.text());
  }
}

/** Parses the private `feed/user/{pk}` response (REST item shape) into the
 * provider-neutral RecentPost. Distinct from the GraphQL `web_profile_info`
 * shape parsed by parseWebProfileBody. */
export function parseUserFeedBody(body: string): RecentPost[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `feed/user returned non-JSON: ${err instanceof Error ? err.message : String(err)} (body starts: ${body.slice(0, 80)})`,
    );
  }
  const obj = json as { require_login?: unknown; items?: unknown };
  if (obj.require_login) {
    throw new InstagramAuthError('feed/user returned require_login — session expired');
  }
  if (!Array.isArray(obj.items)) return [];
  const out: RecentPost[] = [];
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') continue;
    try {
      out.push(normalizeFeedItem(it as Record<string, unknown>));
    } catch (err) {
      log.warn({ err }, 'Skipping malformed IG feed item');
    }
  }
  return out;
}

function bestImageUrl(node: Record<string, unknown>): string {
  const candidates = (node.image_versions2 as { candidates?: { url?: unknown }[] } | undefined)
    ?.candidates;
  const url = candidates?.[0]?.url;
  if (typeof url === 'string' && url.length > 0) return url;
  throw new Error('feed item missing image_versions2.candidates[0].url');
}

function firstVideoUrl(node: Record<string, unknown>): string | undefined {
  const url = (node.video_versions as { url?: unknown }[] | undefined)?.[0]?.url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

function normalizeFeedItem(it: Record<string, unknown>): RecentPost {
  // it.pk is a number > Number.MAX_SAFE_INTEGER, so JSON parsing loses
  // precision. The string `it.id` is "{pk}_{owner}" — split it to recover the
  // exact bare pk, which matches the ids stored by the old GraphQL path.
  const idStr = asString(it.id, 'id');
  const igPostId = idStr.split('_')[0];
  const shortcode = asString(it.code, 'code');
  const takenAtSec = asNumber(it.taken_at, 'taken_at');
  const mt = asNumber(it.media_type, 'media_type');
  const captionText = (it.caption as { text?: unknown } | null | undefined)?.text;
  const caption = typeof captionText === 'string' ? captionText : '';

  let mediaType: RecentPost['mediaType'];
  let carouselUrls: string[] | undefined;
  let carouselVideoUrls: (string | null)[] | undefined;
  let videoUrl: string | undefined;

  if (mt === 8) {
    mediaType = 'carousel';
    const children =
      (it.carousel_media as Record<string, unknown>[] | undefined) ?? [];
    carouselUrls = [];
    carouselVideoUrls = [];
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      try {
        carouselUrls.push(bestImageUrl(child));
      } catch {
        continue;
      }
      carouselVideoUrls.push(child.media_type === 2 ? (firstVideoUrl(child) ?? null) : null);
    }
  } else if (mt === 2) {
    mediaType = 'video';
    videoUrl = firstVideoUrl(it);
  } else {
    mediaType = 'image';
  }

  return {
    igPostId,
    shortcode,
    caption,
    takenAtMs: takenAtSec * 1000,
    mediaType,
    displayUrl: bestImageUrl(it),
    videoUrl,
    carouselUrls,
    carouselVideoUrls,
  };
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
