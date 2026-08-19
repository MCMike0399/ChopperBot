import { Agent } from 'undici';
import { log } from '../../log.js';

// Instagram serves `i.instagram.com` over HTTP/2 and returns 429 to plain
// HTTP/1.1 requests from some egress IPs (observed on the Raspberry Pi's
// residential connection: curl --http2 → 200, curl --http1.1 → 429, identical
// cookies/headers). Node's global `fetch` (undici) defaults to HTTP/1.1, so we
// route IG requests through a shared agent with HTTP/2 enabled. The dispatcher
// is passed via fetch's (undici-specific, untyped) `dispatcher` init option.
const igDispatcher = new Agent({ allowH2: true });
const withH2 = (init: RequestInit): RequestInit =>
  ({ ...init, dispatcher: igDispatcher }) as RequestInit;

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
  /**
   * Optional: register a callback invoked once per outbound IG HTTP request
   * (warmup, pk-resolve, feed). The scheduler uses this to maintain a rolling
   * 24h request count for the daily-budget guardrail. Safe to leave unset.
   */
  observeRequests?(cb: () => void): void;
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
  /**
   * Short machine-readable cause, used by the scheduler to tell a SESSION-level
   * failure (the cookies are dead / the account is challenged — affects every
   * account) from an account-specific rejection (a bare 401/403 on one private
   * or restricted handle). Session-level: `require_login`, `checkpoint_required`,
   * `challenge_required`, `consent_required`. Account-specific: `HTTP 401` /
   * `HTTP 403` with no body marker. Defaults to `unknown`.
   */
  readonly reason: string;
  constructor(message: string, reason = 'unknown') {
    super(message);
    this.name = 'InstagramAuthError';
    this.reason = reason;
  }

  /** True when the cause implies the SESSION (not just one account) is bad. */
  get sessionLevel(): boolean {
    return /checkpoint|challenge|require_login|consent/i.test(this.reason);
  }
}

/** Thrown when IG throttles the request (HTTP 429 / "please wait a few minutes").
 * Distinct from {@link InstagramAuthError}: the session is still valid, IG is
 * just rate-limiting us. The scheduler treats this as a *soft block* and halts
 * ALL polling for an escalating cooldown — continuing to poll while throttled
 * is exactly the pattern that escalates a throttle into a ban, which is
 * catastrophic on a personal account. */
export class InstagramRateLimitError extends Error {
  readonly rateLimited = true;
  /** Parsed from the `Retry-After` header when present (ms), else undefined. */
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'InstagramRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when IG rejects a request for ONE account in a deterministic,
 * non-retryable way (see {@link detectHardAccountBlock}) — e.g. the 2026-07-18
 * `laser.provider ... has been deleted` 400 that made pk resolution fail for
 * 100% of polls on 5 accounts for weeks. Retrying that class of error forever
 * is pure anti-detection surface (a scraper hammering dead endpoints) for zero
 * yield, so the scheduler counts these separately and auto-pauses the account
 * at {@link HARD_PAUSE_THRESHOLD}. Distinct from {@link InstagramAuthError}
 * (session/account auth) and transient failures (network, 5xx, IG blips). */
export class InstagramHardAccountError extends Error {
  readonly hardAccountFailure = true;
  /** Short machine-readable cause (the matched marker), for logs/alerts. */
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'InstagramHardAccountError';
    this.reason = reason;
  }
}

/**
 * Body markers IG returns alongside a throttle. The status code (429) is the
 * primary signal; these catch cases where IG returns 200/400 with a "slow
 * down" body instead of a clean 429.
 */
const RATE_LIMIT_MARKERS = [
  'please wait a few minutes',
  'rate limited',
  'ratelimit',
  'too many requests',
];

/**
 * Returns true if the (status, body) pair indicates IG is throttling us (as
 * opposed to an auth/session problem — see {@link detectAuthBlock} — or an
 * ordinary error). 429 always counts; otherwise we look for an explicit
 * "slow down" marker in the body.
 */
export function detectRateLimit(status: number, body: string): boolean {
  if (status === 429) return true;
  const lower = body.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => lower.includes(m));
}

/** Parse a `Retry-After` header (seconds, or an HTTP-date) into ms. Defensive:
 * test fetch mocks often omit `headers`, so this tolerates a missing getter. */
function parseRetryAfterMs(res: { headers?: { get?: (k: string) => string | null } }): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  return undefined;
}

/**
 * Body markers IG returns when an authenticated request is rejected for
 * auth/lockout/challenge reasons. The interesting non-obvious case is
 * HTTP **400** with `"message":"checkpoint_required"` — IG's "your account
 * was flagged, complete a challenge in the web UI" wall. Before we matched
 * this, those 400s fell through to the generic "HTTP 400" branch and the
 * scheduler kept hammering the dead session.
 */
const AUTH_BLOCK_MARKERS = [
  'checkpoint_required',
  'challenge_required',
  'login_required',
  'require_login',
  'consent_required',
];

/**
 * Returns a short reason if the (status, body) pair indicates the IG session
 * is bad (auth-class failure), null for ordinary errors / throttling. 401/403
 * always count; 400 only counts when the body explicitly says so — IG
 * legitimately returns 400 for malformed requests too, so we don't want to
 * treat every 400 as session-dead.
 */
export function detectAuthBlock(status: number, body: string): string | null {
  if (status === 401 || status === 403) return `HTTP ${status}`;
  if (status === 400) {
    for (const marker of AUTH_BLOCK_MARKERS) {
      if (body.includes(marker)) return `HTTP 400 ${marker}`;
    }
  }
  return null;
}

/**
 * Body markers IG returns on DETERMINISTIC, account-specific, non-retryable
 * failures — the response will be the same on every retry until something
 * changes server-side. First observed 2026-07-18: HTTP 400
 * `{"message":"Asset asset://laser.provider/ig_business_category_subvertical
 * has been deleted. You cannot use this schema","status":"fail"}` resolving
 * the pk of 5 accounts, which then failed 100% of polls for weeks.
 */
const HARD_ACCOUNT_MARKERS = ['laser.provider', 'you cannot use this schema'];

/**
 * Returns the matched marker if the (status, body) pair is a deterministic
 * per-account failure (→ {@link InstagramHardAccountError}), null otherwise.
 * Checked AFTER {@link detectAuthBlock} and {@link detectRateLimit} so a
 * session/throttle signal always wins; 400-only, matching the observed class
 * (other 4xx/5xx stay on the generic transient path).
 */
export function detectHardAccountBlock(status: number, body: string): string | null {
  if (status !== 400) return null;
  const lower = body.toLowerCase();
  for (const marker of HARD_ACCOUNT_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

/** Optional durable cache for pk / username-feed decisions. Production wires
 * this to SQLite so a restart doesn't re-probe; tests leave it unset and get
 * the in-memory default (same process-local stickiness as before). */
export interface InstagramFetchHints {
  getPk(username: string): string | undefined;
  rememberPk(username: string, pk: string): void;
  prefersUsernameFeed(username: string, nowMs?: number): boolean;
  rememberUsernameFeed(username: string, nowMs?: number): void;
}

/** Process-local hints (the pre-v9 behavior). Exported for tests. */
export function memoryFetchHints(): InstagramFetchHints {
  const pk = new Map<string, string>();
  const usernameOnly = new Map<string, number>();
  return {
    getPk: (u) => pk.get(u),
    rememberPk: (u, id) => {
      pk.set(u, id);
      usernameOnly.delete(u);
    },
    prefersUsernameFeed: (u) => usernameOnly.has(u),
    rememberUsernameFeed: (u, nowMs = Date.now()) => {
      usernameOnly.set(u, nowMs);
    },
  };
}

const AUTH_COOKIE_NAMES = new Set(['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did']);

function authCookiePairs(auth: InstagramAuth): string[] {
  const parts = [
    `sessionid=${auth.sessionid}`,
    `csrftoken=${auth.csrftoken}`,
    `ds_user_id=${auth.dsUserId}`,
  ];
  if (auth.mid) parts.push(`mid=${auth.mid}`);
  if (auth.igDid) parts.push(`ig_did=${auth.igDid}`);
  return parts;
}

/** Chrome Client Hints derived from a desktop Chrome UA. Real Chrome 120+
 * always sends these on HTTPS to instagram.com; a UA that claims Chrome but
 * omits them is a well-known non-browser tell. No hints when the UA isn't
 * Chrome (tests, odd custom strings). */
export function clientHintsFromUserAgent(userAgent: string): Record<string, string> {
  const m = userAgent.match(/Chrome\/(\d+)/);
  if (!m) return {};
  const v = m[1];
  const platform = userAgent.includes('Macintosh')
    ? '"macOS"'
    : userAgent.includes('Windows')
      ? '"Windows"'
      : '"Linux"';
  return {
    'sec-ch-ua': `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not-A.Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
  };
}

function parseSetCookieNames(res: {
  headers?: { getSetCookie?: () => string[]; get?: (k: string) => string | null };
}): Array<[string, string]> {
  const raw: string[] = [];
  if (typeof res.headers?.getSetCookie === 'function') {
    raw.push(...res.headers.getSetCookie());
  } else {
    const single = res.headers?.get?.('set-cookie');
    if (single) raw.push(single);
  }
  const out: Array<[string, string]> = [];
  for (const c of raw) {
    const nv = c.split(';', 1)[0];
    const eq = nv.indexOf('=');
    if (eq <= 0) continue;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!name || AUTH_COOKIE_NAMES.has(name)) continue;
    out.push([name, value]);
  }
  return out;
}

const IG_URL = (u: string) =>
  `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;
const IG_FEED_URL = (pk: string, count = 12) =>
  `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(pk)}/?count=${count}`;
// Same private feed endpoint, keyed by username instead of numeric pk —
// bypasses web_profile_info entirely (see fetchAuthedFeedByUsername).
const IG_FEED_BY_USERNAME_URL = (username: string, count = 12) =>
  `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=${count}`;

/** Random feed page size in [10..16] (was a constant 12) so the request
 * signature isn't byte-identical every poll. */
function randomFeedCount(): number {
  return 10 + Math.floor(Math.random() * 7);
}

/** Default desktop-Chrome UA. Overridable via the `IG_USER_AGENT` env so the
 * value can be made to MATCH the browser the session cookies were extracted
 * from — a session driven from a UA different than the one that created it is a
 * fingerprint signal, which matters a lot more on a personal account. */
export const DEFAULT_IG_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** Shared HTTP/2 dispatcher — CDN media fetches must use the same one as the
 * API so we don't present two protocol fingerprints (Node HTTP/1.1 vs H2). */
export function withIgDispatcher(init: RequestInit): RequestInit {
  return withH2(init);
}

// Node's undici fetch auto-sends `sec-fetch-site: cross-site` for requests
// to i.instagram.com. Instagram rejects that with HTTP 400 "SecFetch Policy
// violation" — even though curl works fine, because curl doesn't send any
// sec-fetch-* headers. We override them to look like a same-site XHR fired
// from www.instagram.com. The User-Agent is injected so every request in a
// session shares one consistent UA (see {@link DEFAULT_IG_USER_AGENT}).
function buildHeaders(userAgent: string): Record<string, string> {
  return {
    'x-ig-app-id': '936619743392459',
    'User-Agent': userAgent,
    Accept: '*/*',
    'Accept-Language': ACCEPT_LANGUAGE,
    Referer: 'https://www.instagram.com/',
    Origin: 'https://www.instagram.com',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'x-requested-with': 'XMLHttpRequest',
    ...clientHintsFromUserAgent(userAgent),
  };
}

/** Sleep a human-like interval. Uniform [min,max) is itself a bot signature
 * (real gaps are short-heavy with a long tail), so this skews toward min and
 * occasionally inserts a 2–7 s pause. */
function humanDelay(minMs = 400, maxMs = 1500): Promise<void> {
  const ms =
    Math.random() < 0.08
      ? 2000 + Math.floor(Math.random() * 5000)
      : minMs + Math.floor((maxMs - minMs) * Math.random() ** 2);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Direct fetch from the Node process — the only fetch path.
 *
 * Two modes:
 *  - **Anonymous** (no auth): hits the public `web_profile_info` GraphQL
 *    endpoint, which returns timeline media but is heavily IP-throttled.
 *  - **Authenticated** (session cookies present): resolves the account's
 *    numeric pk once (cached), then reads the private `feed/user/{pk}`
 *    endpoint that logged-in clients use. The authed `web_profile_info`
 *    returns an EMPTY timeline, so feed/user is required to actually see
 *    posts. Authed requests get far higher rate limits. When pk resolution
 *    fails with a deterministic per-account error ({@link
 *    InstagramHardAccountError}), falls back to the username-keyed
 *    `feed/user/{username}/username/` endpoint, which never touches
 *    web_profile_info. The pk and the username-feed decision are stored in
 *    {@link InstagramFetchHints} (SQLite in production) so a restart doesn't
 *    re-probe.
 */
export class DirectInstagramFetcher implements InstagramFetcher {
  private readonly hints: InstagramFetchHints;
  private readonly headers: Record<string, string>;
  /** Extra cookies absorbed from Set-Cookie (rur, ig_nrcb, wd, …). Auth
   * identity cookies stay pinned to the constructor values. */
  private readonly extraCookies = new Map<string, string>();
  /** From `x-ig-set-www-claim` on any IG response; sent as `x-ig-www-claim`. */
  private wwwClaim: string | null = null;
  /** Invoked once per outbound IG HTTP request (see {@link observeRequests}). */
  private onRequest: () => void = () => {};

  /**
   * @param auth Logged-in session cookies, or null for anonymous mode.
   * @param warmupProbability Chance per authed fetch of doing an HTML warmup
   *   first (see {@link maybeWarmup}). Defaults to 0.5 in this constructor;
   *   production passes 0.8. Tests should pass 0 to make request counts
   *   deterministic. Also gates the human-like inter-request delay so tests
   *   stay fast/deterministic.
   * @param userAgent UA sent on every request; should match the browser the
   *   session cookies were extracted from. Defaults to {@link DEFAULT_IG_USER_AGENT}.
   * @param hints Durable pk / username-feed cache. Unset → in-memory (tests).
   */
  constructor(
    private readonly auth: InstagramAuth | null = null,
    private readonly warmupProbability = 0.5,
    private readonly userAgent: string = DEFAULT_IG_USER_AGENT,
    hints?: InstagramFetchHints,
  ) {
    this.headers = buildHeaders(userAgent);
    this.hints = hints ?? memoryFetchHints();
  }

  observeRequests(cb: () => void): void {
    this.onRequest = cb;
  }

  /** Whether this fetcher is sending logged-in session cookies. */
  authenticated(): boolean {
    return this.auth !== null;
  }

  /** Headers for CDN media fetches: same UA, client hints, cookies and Referer
   * as the API session, so scontent.cdninstagram.com isn't a second, dumber
   * client. */
  cdnHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': ACCEPT_LANGUAGE,
      Referer: 'https://www.instagram.com/',
      ...clientHintsFromUserAgent(this.userAgent),
    };
    if (this.auth) Object.assign(headers, this.cookieHeaders(this.auth));
    return headers;
  }

  private cookieHeaders(auth: InstagramAuth): Record<string, string> {
    const parts = [...authCookiePairs(auth)];
    for (const [name, value] of this.extraCookies) {
      parts.push(`${name}=${value}`);
    }
    return { Cookie: parts.join('; '), 'x-csrftoken': auth.csrftoken };
  }

  private authedHeaders(auth: InstagramAuth): Record<string, string> {
    const headers = { ...this.headers, ...this.cookieHeaders(auth) };
    if (this.wwwClaim) headers['x-ig-www-claim'] = this.wwwClaim;
    return headers;
  }

  private absorbSession(res: {
    headers?: { get?: (k: string) => string | null; getSetCookie?: () => string[] };
  }): void {
    const claim =
      res.headers?.get?.('x-ig-set-www-claim') ?? res.headers?.get?.('X-IG-Set-WWW-Claim');
    if (claim && claim.length > 0) this.wwwClaim = claim;
    for (const [name, value] of parseSetCookieNames(res)) {
      this.extraCookies.set(name, value);
    }
  }

  async fetchRecentPosts(username: string): Promise<RecentPost[]> {
    if (this.auth) {
      await this.maybeWarmup(username, this.auth);
      if (this.hints.prefersUsernameFeed(username)) {
        return this.fetchAuthedFeedByUsername(username, this.auth);
      }
      let pk: string;
      try {
        pk = await this.resolvePk(username, this.auth);
      } catch (err) {
        if (!(err instanceof InstagramHardAccountError)) throw err;
        // pk resolution is deterministically broken for THIS account (e.g. the
        // 2026-07-18 laser.provider schema deletion 400ing web_profile_info on
        // business-category profiles). The username-keyed feed endpoint never
        // touches web_profile_info, so try it before writing the account off.
        log.warn(
          { username, reason: err.reason },
          'instagram_monitor.fetch.pk_resolve_hard_failed — trying feed-by-username fallback',
        );
        // The failed resolve still happened on the wire, so keep the same
        // human-like gap a browser would show before the feed XHR.
        if (this.warmupProbability > 0) await humanDelay();
        const posts = await this.fetchAuthedFeedByUsername(username, this.auth, err);
        this.hints.rememberUsernameFeed(username);
        log.info({ username }, 'instagram_monitor.fetch.feed_by_username_engaged');
        return posts;
      }
      // Real browsers don't fire the feed XHR the instant the profile resolves.
      // A short randomized gap (skipped in tests where warmup is disabled).
      if (this.warmupProbability > 0) await humanDelay();
      return this.fetchAuthedFeed(pk, this.auth);
    }
    this.onRequest();
    const res = await fetch(IG_URL(username), withH2({ headers: this.headers }));
    this.absorbSession(res);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (detectRateLimit(res.status, body)) {
        throw new InstagramRateLimitError(
          `Instagram throttled an anonymous request (HTTP ${res.status})`,
          parseRetryAfterMs(res),
        );
      }
      throw new Error(`Instagram returned HTTP ${res.status} (direct)`);
    }
    return parseWebProfileBody(await res.text());
  }

  /**
   * Roughly half the time, "warm up" by fetching the public HTML profile page
   * (`instagram.com/<handle>/`) with the session cookies and a navigate
   * sec-fetch profile, then pause 1–3 s before the API call. This mimics how a
   * real browser session opens the profile page first (HTML, document
   * destination, sec-fetch-site=none) and only then fires the XHR/feed
   * requests — IG's automation heuristics flag clients that only ever hit
   * `api/v1/...` with no preceding page load. The added request volume is
   * trivial vs. the visibility win.
   */
  private async maybeWarmup(username: string, auth: InstagramAuth): Promise<void> {
    if (this.warmupProbability <= 0 || Math.random() >= this.warmupProbability) return;
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': ACCEPT_LANGUAGE,
      Referer: 'https://www.instagram.com/',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      ...clientHintsFromUserAgent(this.userAgent),
      ...this.cookieHeaders(auth),
    };
    try {
      this.onRequest();
      const res = await fetch(
        `https://www.instagram.com/${encodeURIComponent(username)}/`,
        withH2({ headers }),
      );
      this.absorbSession(res);
      // Drain to release the connection back to the keep-alive pool.
      await res.text().catch(() => '');
    } catch {
      // Warmup is best-effort — the real fetch will surface any real error.
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 800 + Math.floor(2200 * Math.random() ** 2)),
    );
  }

  /** username → numeric pk, cached (pk is stable for the lifetime of a handle).
   * Uses the authed web_profile_info, which returns the profile (incl. id)
   * even though it omits timeline media. */
  private async resolvePk(username: string, auth: InstagramAuth): Promise<string> {
    const cached = this.hints.getPk(username);
    if (cached) return cached;
    const headers = this.authedHeaders(auth);
    this.onRequest();
    const res = await fetch(IG_URL(username), withH2({ headers }));
    this.absorbSession(res);
    const body = await res.text();
    if (!res.ok) {
      const authReason = detectAuthBlock(res.status, body);
      if (authReason) {
        throw new InstagramAuthError(
          `Instagram rejected an authenticated profile lookup (${authReason}) — session/account likely expired or flagged for a challenge`,
          authReason,
        );
      }
      if (detectRateLimit(res.status, body)) {
        throw new InstagramRateLimitError(
          `Instagram throttled an authenticated profile lookup (HTTP ${res.status}) resolving @${username}`,
          parseRetryAfterMs(res),
        );
      }
      const hardReason = detectHardAccountBlock(res.status, body);
      if (hardReason) {
        throw new InstagramHardAccountError(
          `Instagram returned a deterministic ${res.status} resolving @${username} (${hardReason}) — retrying is futile until IG changes server-side`,
          hardReason,
        );
      }
      throw new Error(
        `Instagram returned HTTP ${res.status} resolving @${username} (direct)${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }
    let json: { data?: { user?: { id?: unknown } }; require_login?: unknown };
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`web_profile_info returned non-JSON resolving @${username}`);
    }
    if (json.require_login) {
      throw new InstagramAuthError(
        'web_profile_info returned require_login — session expired',
        'require_login',
      );
    }
    const pk = json.data?.user?.id;
    if (typeof pk !== 'string' || pk.length === 0) {
      throw new Error(`Could not resolve pk for @${username}`);
    }
    this.hints.rememberPk(username, pk);
    return pk;
  }

  private fetchAuthedFeed(pk: string, auth: InstagramAuth): Promise<RecentPost[]> {
    return this.requestAuthedFeed(IG_FEED_URL(pk, randomFeedCount()), `feed/user/${pk}`, auth);
  }

  /**
   * Username-keyed variant of the private feed endpoint — the fallback for
   * accounts whose pk resolution is deterministically broken
   * ({@link InstagramHardAccountError}). Same response shape, same parser.
   *
   * Failure semantics: auth / rate-limit / hard-marker failures propagate
   * as-is (session and throttle signals must win, and a hard failure on BOTH
   * paths is genuinely non-retryable). Any OTHER failure here re-throws the
   * original `cause` when present: a transient (or "endpoint gone") fallback
   * failure must not downgrade the account to the infinite-retry transient
   * path — that's the exact hammering-a-dead-endpoint pattern the hard gate
   * exists to stop.
   */
  private async fetchAuthedFeedByUsername(
    username: string,
    auth: InstagramAuth,
    cause?: InstagramHardAccountError,
  ): Promise<RecentPost[]> {
    try {
      return await this.requestAuthedFeed(
        IG_FEED_BY_USERNAME_URL(username, randomFeedCount()),
        `feed/user/${username}/username`,
        auth,
      );
    } catch (err) {
      if (
        err instanceof InstagramAuthError ||
        err instanceof InstagramRateLimitError ||
        err instanceof InstagramHardAccountError
      ) {
        throw err;
      }
      throw cause ?? err;
    }
  }

  private async requestAuthedFeed(
    url: string,
    label: string,
    auth: InstagramAuth,
  ): Promise<RecentPost[]> {
    const headers = this.authedHeaders(auth);
    this.onRequest();
    const res = await fetch(url, withH2({ headers }));
    this.absorbSession(res);
    const body = await res.text();
    if (!res.ok) {
      const authReason = detectAuthBlock(res.status, body);
      if (authReason) {
        throw new InstagramAuthError(
          `Instagram rejected an authenticated feed request (${authReason}) — session/account likely expired or flagged for a challenge`,
          authReason,
        );
      }
      if (detectRateLimit(res.status, body)) {
        throw new InstagramRateLimitError(
          `Instagram throttled an authenticated feed request (HTTP ${res.status})`,
          parseRetryAfterMs(res),
        );
      }
      const hardReason = detectHardAccountBlock(res.status, body);
      if (hardReason) {
        throw new InstagramHardAccountError(
          `Instagram returned a deterministic ${res.status} on ${label} (${hardReason}) — retrying is futile until IG changes server-side`,
          hardReason,
        );
      }
      throw new Error(
        `Instagram returned HTTP ${res.status} on ${label} (direct)${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }
    return parseUserFeedBody(body);
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
    throw new InstagramAuthError(
      'feed/user returned require_login — session expired',
      'require_login',
    );
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

export function parseWebProfileBody(body: string): RecentPost[] {
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
