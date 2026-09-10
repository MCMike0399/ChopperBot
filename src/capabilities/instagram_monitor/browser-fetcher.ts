import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
   chromium,
   type Browser,
   type BrowserContext,
   type Page,
   type Response as PlaywrightResponse,
} from "playwright-core";
import { log } from "../../log.js";
import {
   InstagramAuthError,
   type InstagramAuth,
   type InstagramFetcher,
   type RecentPost,
} from "./fetcher.js";

/**
 * Browser-backed Instagram fetcher — the replacement for the HTTP API path.
 *
 * **Why this exists (2026-09-10).** Instagram changed its web API on
 * 2026-09-02 and killed the read path the API fetcher depends on: every
 * `i.instagram.com/api/v1/feed/user/…` call 302s to the host root and
 * `web_profile_info` answers 429 to the first request of a fresh session, from
 * any IP and over both HTTP/1.1 and HTTP/2. Those breakages are reproduced by
 * third parties (instaloader #2726, gallery-dl #8714/#8978, yt-dlp #17278).
 * `www.instagram.com/api/v1/users/{pk}/info/` still answers, but it returns no
 * posts, and every timeline route (including `POST /api/graphql` with a valid
 * `doc_id` and a harvested `x-ig-www-claim`) serves the SPA shell instead of
 * JSON. The one thing that demonstrably still works is a **real browser**.
 *
 * **How it works.** We drive Chromium over CDP, load the public profile page
 * with the session cookies, and *read the response the page itself makes* —
 * `data.xdt_api__v1__feed__user_timeline_graphql_connection` off
 * `https://www.instagram.com/graphql/query`. Nothing is spoofed at the HTTP
 * layer: the browser produces its own TLS fingerprint, its own headers and its
 * own www-claim, which is exactly what the API fetcher could not fake. It also
 * means the HTML-warmup-then-XHR shape is genuine rather than imitated.
 *
 * **A browser poll is not an API call.** The scheduler's daily budget and the
 * budget governor are calibrated in "calls per poll" (the API path measured
 * ≈2.0: warmup + feed). A browser poll issues dozens of sub-resource requests,
 * which must NOT be counted individually or the 90/day budget would trip on the
 * first poll. We therefore report {@link BROWSER_REQUESTS_PER_POLL} units per
 * poll — the legacy equivalent — so the governor's headroom projection and the
 * tuned daily budget keep meaning what they meant before. Changing this constant
 * silently changes how much traffic the fleet is allowed.
 */

/**
 * Budget units charged per browser poll. Deliberately equal to the API path's
 * measured `callsPerPoll` (warmup + feed ≈ 2.0) so that switching fetch modes
 * does not change the number of polls/day the governor permits.
 */
export const BROWSER_REQUESTS_PER_POLL = 2;

// `page.evaluate` callbacks execute inside the page, not in Node, and this
// project's tsconfig deliberately omits the DOM lib — declare just the globals
// those callbacks touch.
declare const document: { documentElement: { className: string } };
declare const location: { href: string };

/** Close an idle browser after this long; relaunched on the next poll. */
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
/** How long to wait for the page's own timeline XHR after the HTML lands. */
const DEFAULT_TIMELINE_TIMEOUT_MS = 20_000;

const PROFILE_URL = (username: string): string =>
   `https://www.instagram.com/${encodeURIComponent(username)}/`;

/**
 * Resolve a Chromium/Chrome binary, in priority order:
 * explicit env override → newest Playwright-cached chromium → system chromium
 * → macOS Chrome (local dev).
 *
 * The cache is searched because the cached revision and the installed
 * `playwright-core` do not always agree (`playwright-core` 1.63 wants
 * chromium-1243 while the Pi's cache holds 1228); driving the cached binary
 * explicitly is what makes the version mismatch harmless. `exists` is
 * injectable so the ordering is unit-testable without touching the filesystem.
 */
export function resolveBrowserExecutable(
   exists: (p: string) => boolean = existsSync,
): string | null {
   const explicit = process.env.IG_BROWSER_EXECUTABLE_PATH?.trim();
   if (explicit && exists(explicit)) return explicit;

   const cacheRoot =
      process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
      join(homedir(), ".cache", "ms-playwright");
   try {
      const revisions = readdirSync(cacheRoot)
         .filter((d) => /^chromium-\d+$/.test(d))
         .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
      for (const rev of revisions) {
         for (const rel of [
            "chrome-linux/chrome",
            "chrome-linux-arm64/chrome",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
            "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
         ]) {
            const candidate = join(cacheRoot, rev, rel);
            if (exists(candidate)) return candidate;
         }
      }
   } catch {
      // Cache directory absent — fall through to system browsers.
   }

   for (const candidate of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
   ]) {
      if (exists(candidate)) return candidate;
   }
   return null;
}

/** Cookies the page needs. Only the five the session actually requires — IG
 * rotates/absorbs `rur`, `datr`, `wd`, … by itself once the browser is running. */
export function authCookies(
   auth: InstagramAuth | null,
): Array<{
   name: string;
   value: string;
   domain: string;
   path: string;
   secure: boolean;
   httpOnly: boolean;
   sameSite: "Lax";
}> {
   if (!auth) return [];
   const pairs: Array<[string, string]> = [
      ["sessionid", auth.sessionid],
      ["csrftoken", auth.csrftoken],
      ["ds_user_id", auth.dsUserId],
   ];
   if (auth.mid) pairs.push(["mid", auth.mid]);
   if (auth.igDid) pairs.push(["ig_did", auth.igDid]);
   return pairs.map(([name, value]) => ({
      name,
      value,
      domain: ".instagram.com",
      path: "/",
      secure: true,
      httpOnly: name === "sessionid",
      sameSite: "Lax" as const,
   }));
}

/** Shape of one timeline edge node, as far as we consume it. */
interface TimelineNode {
   pk?: unknown;
   code?: unknown;
   taken_at?: unknown;
   media_type?: unknown;
   caption?: { text?: unknown } | null;
   image_versions2?: { candidates?: Array<{ url?: unknown }> } | null;
   video_versions?: Array<{ url?: unknown }> | null;
   carousel_media?: TimelineNode[] | null;
}

const firstImageUrl = (node: TimelineNode | null | undefined): string | undefined => {
   const url = node?.image_versions2?.candidates?.[0]?.url;
   return typeof url === "string" && url.length > 0 ? url : undefined;
};

const firstVideoUrl = (node: TimelineNode | null | undefined): string | undefined => {
   const url = node?.video_versions?.[0]?.url;
   return typeof url === "string" && url.length > 0 ? url : undefined;
};

/**
 * Pull the profile-timeline connection out of any GraphQL payload the page
 * produced. Pure, so the payload contract is unit-tested against a captured
 * fixture rather than a live browser.
 */
export function extractTimelineConnection(
   payload: unknown,
): { edges?: Array<{ node?: TimelineNode }> } | null {
   if (!payload || typeof payload !== "object") return null;
   const data = (payload as { data?: unknown }).data;
   if (!data || typeof data !== "object") return null;
   const conn = (data as Record<string, unknown>)[
      "xdt_api__v1__feed__user_timeline_graphql_connection"
   ];
   if (!conn || typeof conn !== "object") return null;
   return conn as { edges?: Array<{ node?: TimelineNode }> };
}

/**
 * Map the page's timeline payload onto the scheduler's {@link RecentPost}.
 *
 * `igPostId` is the **bare** `node.pk`. That is load-bearing: the retired API
 * path derived the same bare id by splitting `item.id` (`"{pk}_{owner}"`), and
 * all pre-existing `instagram_monitor_seen_posts` rows are in that form. Using
 * `node.id` instead would append `_{owner}` and make every post look unseen,
 * re-pushing the entire feed. `pk` also stays correct for collaboration posts,
 * whose owner half belongs to the co-author, not the monitored account.
 */
export function mapTimelineToRecentPosts(connection: {
   edges?: Array<{ node?: TimelineNode }>;
}): RecentPost[] {
   const out: RecentPost[] = [];
   for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      if (!node) continue;
      const pk = node.pk;
      const takenAt = node.taken_at;
      if (typeof pk !== "string" || pk.length === 0) continue;
      if (typeof takenAt !== "number" || !Number.isFinite(takenAt)) continue;

      const rawType = typeof node.media_type === "number" ? node.media_type : undefined;
      const carousel = Array.isArray(node.carousel_media) ? node.carousel_media : undefined;
      const videoUrl = firstVideoUrl(node);

      const mediaType: RecentPost["mediaType"] =
         rawType === 8 || (carousel && carousel.length > 0)
            ? "carousel"
            : rawType === 2 || videoUrl
              ? "video"
              : "image";

      const captionText = node.caption?.text;
      const post: RecentPost = {
         igPostId: pk,
         shortcode: typeof node.code === "string" ? node.code : "",
         caption: typeof captionText === "string" ? captionText : "",
         takenAtMs: takenAt * 1000,
         mediaType,
         displayUrl: firstImageUrl(node) ?? carousel?.map(firstImageUrl).find(Boolean) ?? "",
      };
      if (mediaType === "video" && videoUrl) post.videoUrl = videoUrl;
      if (mediaType === "carousel" && carousel) {
         post.carouselUrls = carousel
            .map((m) => firstImageUrl(m))
            .filter((u): u is string => typeof u === "string");
         post.carouselVideoUrls = carousel.map((m) => firstVideoUrl(m) ?? null);
      }
      out.push(post);
   }
   return out;
}

export interface BrowserFetcherOptions {
   idleShutdownMs?: number;
   navigationTimeoutMs?: number;
   timelineTimeoutMs?: number;
}

/**
 * Chromium-backed {@link InstagramFetcher}. One browser + context is kept alive
 * across polls (launching Chromium per poll would be wasteful on a Pi) and torn
 * down after {@link BrowserFetcherOptions.idleShutdownMs} of inactivity, so an
 * idle bot does not hold ~200 MB of renderer processes.
 */
export class BrowserInstagramFetcher implements InstagramFetcher {
   private readonly auth: InstagramAuth | null;
   private readonly userAgent: string | undefined;
   private readonly executablePath: string | null;
   private readonly idleShutdownMs: number;
   private readonly navigationTimeoutMs: number;
   private readonly timelineTimeoutMs: number;

   private browser: Browser | null = null;
   private context: BrowserContext | null = null;
   private idleTimer: NodeJS.Timeout | null = null;
   /** Serialises polls — the scheduler polls one account per tick, but a second
    * caller must never race on the shared page/context. */
   private queue: Promise<unknown> = Promise.resolve();
   private onRequest: () => void = () => {};

   constructor(
      auth: InstagramAuth | null,
      userAgent?: string,
      options: BrowserFetcherOptions = {},
   ) {
      this.auth = auth;
      this.userAgent = userAgent;
      this.executablePath = resolveBrowserExecutable();
      this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
      this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
      this.timelineTimeoutMs = options.timelineTimeoutMs ?? DEFAULT_TIMELINE_TIMEOUT_MS;
   }

   observeRequests(cb: () => void): void {
      this.onRequest = cb;
   }

   async fetchRecentPosts(username: string): Promise<RecentPost[]> {
      const run = this.queue.then(
         () => this.fetchOnce(username),
         () => this.fetchOnce(username),
      );
      this.queue = run.catch(() => {});
      try {
         return await run;
      } finally {
         this.scheduleIdleShutdown();
      }
   }

   /** Tear the browser down (called on scheduler dispose / capability stop). */
   async dispose(): Promise<void> {
      if (this.idleTimer) {
         clearTimeout(this.idleTimer);
         this.idleTimer = null;
      }
      const browser = this.browser;
      this.browser = null;
      this.context = null;
      if (browser) await browser.close().catch(() => {});
   }

   private scheduleIdleShutdown(): void {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
         void this.dispose();
      }, this.idleShutdownMs);
      // Never keep the process alive just to close an idle browser.
      this.idleTimer.unref?.();
   }

   private async ensureContext(): Promise<BrowserContext> {
      if (this.context && this.browser?.isConnected()) return this.context;
      if (!this.executablePath) {
         throw new Error(
            "No Chromium executable found for the Instagram browser fetcher. Install chromium " +
               "or set IG_BROWSER_EXECUTABLE_PATH.",
         );
      }
      const launched = await chromium.launch({
         executablePath: this.executablePath,
         headless: true,
         args: [
            // The service runs as an unprivileged user without user namespaces on
            // the Pi; the browser only ever renders instagram.com.
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
         ],
      });
      this.browser = launched;
      const context = await launched.newContext({
         userAgent: this.userAgent,
         viewport: { width: 1456, height: 902 },
         locale: "en-US",
         timezoneId: "America/Mexico_City",
      });
      await context.addInitScript(() => {
         Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await context.addCookies(authCookies(this.auth));
      log.info(
         { executablePath: this.executablePath, authed: this.auth !== null },
         "instagram_monitor.browser.launched",
      );
      this.context = context;
      return context;
   }

   private async fetchOnce(username: string): Promise<RecentPost[]> {
      const context = await this.ensureContext();
      const page = await context.newPage();
      try {
         const timeline = new Promise<ReturnType<typeof extractTimelineConnection>>((resolve) => {
            const handler = async (res: PlaywrightResponse): Promise<void> => {
               if (!/instagram\.com\/(graphql|api\/v1\/feed)/.test(res.url())) return;
               try {
                  const found = extractTimelineConnection(await res.json());
                  if (found?.edges?.length) {
                     page.off("response", handler);
                     resolve(found);
                  }
               } catch {
                  // Non-JSON or already-consumed body — ignore.
               }
            };
            page.on("response", handler);
         });

         await page.goto(PROFILE_URL(username), {
            waitUntil: "domcontentloaded",
            timeout: this.navigationTimeoutMs,
         });
         this.onRequest();
         this.onRequest();

         const connection = await Promise.race([
            timeline,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), this.timelineTimeoutMs)),
         ]);

         if (!connection) {
            // No timeline came back. Distinguish "Instagram logged us out" (a real
            // session failure worth tripping the kill-switch over) from a page that
            // merely did not render — the latter must stay on the retry path.
            const state = await page
               .evaluate(() => ({
                  classes: document.documentElement.className,
                  href: location.href,
               }))
               .catch(() => ({ classes: "", href: page.url() }));
            if (/not-logged-in/.test(state.classes) || /\/accounts\/login/.test(state.href)) {
               throw new InstagramAuthError(
                  `Instagram served the logged-out shell for @${username} — session expired`,
                  "require_login",
               );
            }
            throw new Error(
               `Instagram page for @${username} produced no timeline payload within ` +
                  `${this.timelineTimeoutMs}ms (final url: ${state.href})`,
            );
         }

         const posts = mapTimelineToRecentPosts(connection);
         log.info(
            { username, posts: posts.length },
            "instagram_monitor.browser.fetch.ok",
         );
         return posts;
      } finally {
         await page.close().catch(() => {});
      }
   }
}
