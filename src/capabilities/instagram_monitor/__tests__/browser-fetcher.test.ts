import { describe, expect, it } from "vitest";
import {
   BROWSER_REQUESTS_PER_POLL,
   authCookies,
   extractTimelineConnection,
   mapTimelineToRecentPosts,
   resolveBrowserExecutable,
} from "../browser-fetcher.js";

/** Trimmed from a real `graphql/query` payload captured off the Pi on
 * 2026-09-10 (profile @revueltasperiodico). The `pk`/`id` split is the
 * load-bearing detail: `id` carries the OWNER, which for a collaboration post
 * is the co-author, not the monitored account. */
const timelinePayload = {
   data: {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
         edges: [
            {
               node: {
                  id: "3983345283860244336_59707196430",
                  pk: "3983345283860244336",
                  code: "DdHr25WN6dw",
                  taken_at: 1789071798,
                  media_type: 1,
                  caption: { text: "Denunciamos la persecución política" },
                  image_versions2: {
                     candidates: [{ url: "https://instagram.fmex22-1.fna.fbcdn.net/a.jpg" }],
                  },
               },
            },
            {
               node: {
                  id: "3983166717631056488_62427593254",
                  pk: "3983166717631056488",
                  code: "DdHDQaljspo",
                  taken_at: 1789050496,
                  media_type: 8,
                  caption: { text: "Condiciones de la pista" },
                  image_versions2: {
                     candidates: [{ url: "https://instagram.fmex23-1.fna.fbcdn.net/cover.jpg" }],
                  },
                  carousel_media: [
                     {
                        media_type: 1,
                        image_versions2: {
                           candidates: [{ url: "https://instagram.fmex23-1.fna.fbcdn.net/1.jpg" }],
                        },
                     },
                     {
                        media_type: 2,
                        image_versions2: {
                           candidates: [{ url: "https://instagram.fmex24-1.fna.fbcdn.net/2.jpg" }],
                        },
                        video_versions: [{ url: "https://instagram.fmex24-1.fna.fbcdn.net/2.mp4" }],
                     },
                  ],
               },
            },
            {
               node: {
                  pk: "3982852594831759579",
                  code: "DdEWAQeDraP",
                  taken_at: 1788959662,
                  media_type: 2,
                  caption: { text: "Video denuncia" },
                  image_versions2: {
                     candidates: [{ url: "https://instagram.fmex28-1.fna.fbcdn.net/v.jpg" }],
                  },
                  video_versions: [{ url: "https://instagram.fmex28-1.fna.fbcdn.net/v.mp4" }],
               },
            },
         ],
         page_info: { has_next_page: true },
      },
      xdt_viewer: { user: { pk: "31267874076" } },
   },
};

describe("extractTimelineConnection", () => {
   it("finds the timeline connection inside a real payload", () => {
      const conn = extractTimelineConnection(timelinePayload);
      expect(conn?.edges).toHaveLength(3);
   });

   it("returns null for unrelated GraphQL payloads", () => {
      expect(extractTimelineConnection({ data: { xdt_viewer: {} } })).toBeNull();
      expect(extractTimelineConnection({ data: null })).toBeNull();
      expect(extractTimelineConnection(null)).toBeNull();
      expect(extractTimelineConnection("nope")).toBeNull();
   });
});

describe("mapTimelineToRecentPosts", () => {
   const posts = mapTimelineToRecentPosts(extractTimelineConnection(timelinePayload)!);

   it("maps an image post", () => {
      const p = posts[0]!;
      // MUST be the bare pk: every pre-existing seen_posts row is bare, and the
      // retired API path derived the same value by splitting item.id on "_".
      expect(p.igPostId).toBe("3983345283860244336");
      expect(p.igPostId).not.toContain("_");
      expect(p.shortcode).toBe("DdHr25WN6dw");
      expect(p.takenAtMs).toBe(1789071798 * 1000);
      expect(p.mediaType).toBe("image");
      expect(p.caption).toContain("persecución");
      expect(p.displayUrl).toContain("fbcdn.net");
      expect(p.videoUrl).toBeUndefined();
   });

   it("keeps the bare pk even when the post owner is a co-author", () => {
      // Node 0's `id` suffix (59707196430) is NOT the monitored account
      // (62427593254). Deriving the id from `id` would corrupt dedup anchors.
      expect(posts[0]!.igPostId).toBe("3983345283860244336");
   });

   it("maps a carousel with parallel image/video arrays", () => {
      const p = posts[1]!;
      expect(p.mediaType).toBe("carousel");
      expect(p.carouselUrls).toHaveLength(2);
      expect(p.carouselVideoUrls).toEqual([
         null,
         "https://instagram.fmex24-1.fna.fbcdn.net/2.mp4",
      ]);
      expect(p.displayUrl).toBe("https://instagram.fmex23-1.fna.fbcdn.net/cover.jpg");
   });

   it("maps a video post", () => {
      const p = posts[2]!;
      expect(p.mediaType).toBe("video");
      expect(p.videoUrl).toBe("https://instagram.fmex28-1.fna.fbcdn.net/v.mp4");
   });

   it("skips nodes without a usable id or timestamp", () => {
      const mapped = mapTimelineToRecentPosts({
         edges: [
            { node: { code: "x", taken_at: 1 } },
            { node: { pk: "123", code: "y" } },
            { node: { pk: "456", code: "z", taken_at: 1700000000, media_type: 1 } },
            {},
         ],
      });
      expect(mapped).toHaveLength(1);
      expect(mapped[0]!.igPostId).toBe("456");
      expect(mapped[0]!.caption).toBe("");
   });

   it("tolerates a missing edges array", () => {
      expect(mapTimelineToRecentPosts({})).toEqual([]);
   });
});

describe("authCookies", () => {
   it("maps only the five required cookies and marks sessionid httpOnly", () => {
      const cookies = authCookies({
         sessionid: "s",
         csrftoken: "c",
         dsUserId: "1",
         mid: "m",
         igDid: "d",
      });
      expect(cookies.map((c) => c.name)).toEqual([
         "sessionid",
         "csrftoken",
         "ds_user_id",
         "mid",
         "ig_did",
      ]);
      expect(cookies[0]!.httpOnly).toBe(true);
      expect(cookies.every((c) => c.domain === ".instagram.com")).toBe(true);
   });

   it("omits optional cookies and returns [] when anonymous", () => {
      expect(authCookies({ sessionid: "s", csrftoken: "c", dsUserId: "1" })).toHaveLength(3);
      expect(authCookies(null)).toEqual([]);
   });
});

describe("resolveBrowserExecutable", () => {
   it("prefers an explicit IG_BROWSER_EXECUTABLE_PATH", () => {
      const prev = process.env.IG_BROWSER_EXECUTABLE_PATH;
      process.env.IG_BROWSER_EXECUTABLE_PATH = "/opt/mychrome";
      try {
         expect(resolveBrowserExecutable((p) => p === "/opt/mychrome")).toBe("/opt/mychrome");
      } finally {
         if (prev === undefined) delete process.env.IG_BROWSER_EXECUTABLE_PATH;
         else process.env.IG_BROWSER_EXECUTABLE_PATH = prev;
      }
   });

   it("ignores an explicit path that does not exist and falls through", () => {
      const prev = process.env.IG_BROWSER_EXECUTABLE_PATH;
      process.env.IG_BROWSER_EXECUTABLE_PATH = "/opt/missing";
      try {
         expect(resolveBrowserExecutable((p) => p === "/usr/bin/chromium")).toBe(
            "/usr/bin/chromium",
         );
      } finally {
         if (prev === undefined) delete process.env.IG_BROWSER_EXECUTABLE_PATH;
         else process.env.IG_BROWSER_EXECUTABLE_PATH = prev;
      }
   });

   it("returns null when nothing exists", () => {
      expect(resolveBrowserExecutable(() => false)).toBeNull();
   });
});

describe("budget accounting", () => {
   it("charges a browser poll the legacy API equivalent, not per sub-resource", () => {
      // Guards the guardrail: if this drops to 1 the governor permits ~2x the
      // profile loads the daily budget was tuned for.
      expect(BROWSER_REQUESTS_PER_POLL).toBe(2);
   });
});
