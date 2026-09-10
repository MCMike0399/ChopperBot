// End-to-end proof for the browser fetch path (IG_FETCH_MODE=browser).
//
// Verifies, against the REAL account and the REAL DeepSeek backend:
//   1. the browser fetcher returns posts for a handle,
//   2. the cover image for the newest post downloads from the IG CDN,
//   3. sniffImageFormat identifies it,
//   4. the vision classifier reads the image + caption in one call and returns a
//      parseable verdict.
//
// Step 4 spends a small amount of DeepSeek budget (one `effort: 'low'` call) —
// it exists because "the fetch works" and "the image path works" are different
// claims, and the 2026-09-02 break proved that assuming the second from the
// first is how a monitor goes silently blind.
//
// Run: npx tsx scripts/verify-ig-browser-fetch.ts [username]
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import {
   BrowserInstagramFetcher,
   resolveBrowserExecutable,
} from "../src/capabilities/instagram_monitor/browser-fetcher.js";
import type { InstagramAuth } from "../src/capabilities/instagram_monitor/fetcher.js";
import { classifyPost } from "../src/capabilities/instagram_monitor/classifier.js";
import {
   configureIgCdn,
   fetchCover,
   publishPost,
} from "../src/capabilities/instagram_monitor/publisher.js";
import { sniffImageFormat } from "../src/attachments/attachable.js";

const username = process.argv[2] ?? "revueltasperiodico";
const skipVision = process.argv.includes("--no-vision");

const auth: InstagramAuth | null =
   config.IG_SESSIONID && config.IG_CSRFTOKEN && config.IG_DS_USER_ID
      ? {
           sessionid: config.IG_SESSIONID,
           csrftoken: config.IG_CSRFTOKEN,
           dsUserId: config.IG_DS_USER_ID,
           mid: config.IG_MID,
           igDid: config.IG_DID,
        }
      : null;

console.log(`fetch mode : ${config.IG_FETCH_MODE}`);
console.log(`chromium   : ${resolveBrowserExecutable() ?? "(none found!)"}`);
console.log(`account    : @${username}`);
console.log(`auth       : ${auth ? "AUTHENTICATED" : "ANONYMOUS"}`);
console.log("");

// The CDN cover fetch borrows the fetcher's browser-matching headers in
// production; mirror that here so step 2 tests the real thing.
configureIgCdn({
   headers: () => ({
      "User-Agent": config.IG_USER_AGENT ?? "",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: "https://www.instagram.com/",
   }),
});

const fetcher = new BrowserInstagramFetcher(auth, config.IG_USER_AGENT);
let failures = 0;

try {
   console.log("1) browser fetch …");
   const t0 = Date.now();
   const posts = await fetcher.fetchRecentPosts(username);
   console.log(`   ok: ${posts.length} posts in ${Date.now() - t0}ms`);
   if (posts.length === 0) throw new Error("fetcher returned zero posts");
   for (const p of posts.slice(0, 3)) {
      const age = ((Date.now() - p.takenAtMs) / 3_600_000).toFixed(1);
      console.log(
         `   - ${p.igPostId} ${p.shortcode} ${p.mediaType} ${age}h old ` +
            `carousel=${p.carouselUrls?.length ?? 0} cap="${p.caption.slice(0, 40).replace(/\n/g, " ")}"`,
      );
   }
   // Dedup continuity: every stored id is bare, so a "_" here would re-push the feed.
   const composite = posts.filter((p) => p.igPostId.includes("_"));
   if (composite.length > 0) {
      throw new Error(
         `${composite.length} posts have a composite id (should be the bare pk) — dedup would break`,
      );
   }

   const newest = posts.find((p) => p.displayUrl.length > 0);
   if (!newest) throw new Error("no post carried a displayUrl");

   console.log(`\n2) cover image (post ${newest.shortcode}) …`);
   const bytes = await fetchCover(newest.displayUrl);
   if (!bytes || bytes.length === 0) throw new Error("fetchCover returned nothing");
   console.log(`   ok: ${bytes.length} bytes`);

   console.log("\n3) image format sniff …");
   const format = sniffImageFormat(bytes);
   if (!format) throw new Error("sniffImageFormat could not identify the cover");
   console.log(`   ok: ${format}`);
   failures = 0;

   let verdict: Awaited<ReturnType<typeof classifyPost>> | null = null;
   if (skipVision) {
      console.log("\n4) vision classify … SKIPPED (--no-vision)");
   } else {
      console.log("\n4) vision classify (one real LLM call) …");
      const mimeType = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      verdict = await classifyPost(username, newest, {
         cover: { bytes, mimeType, format },
         nowMs: Date.now(),
      });
      console.log(`   ok: relevant=${verdict.relevant} type=${verdict.type ?? "-"}`);
      console.log(`   summary: ${(verdict.summary ?? "").slice(0, 140)}`);
      if (typeof verdict.relevant !== "boolean") {
         throw new Error("classifier did not return a boolean relevance verdict");
      }
   }

   // 5) Optional: exercise the real Discord card render + send. Pass an ADMIN
   // channel id, never a community one — this posts a genuine-looking card and
   // is meant to prove the last link of the chain without pinging the server.
   const publishTo = process.argv
      .find((a) => a.startsWith("--publish-to="))
      ?.split("=")[1];
   if (publishTo) {
      if (!verdict) throw new Error("--publish-to needs the vision step (drop --no-vision)");
      console.log(`\n5) publish card to channel ${publishTo} …`);
      const client = new Client({
         intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      });
      await new Promise<void>((res, rej) => {
         client.once("clientReady", () => res());
         client.once("error", rej);
         void client.login(config.DISCORD_TOKEN).catch(rej);
      });
      const result = await publishPost(client, publishTo, username, newest, verdict, bytes);
      await client.destroy();
      console.log(`   ok: ${JSON.stringify(result)}`);
      if (!result.ok) throw new Error(`publishPost failed: ${result.reason}`);
   }

   console.log("\n✅ ALL CHECKS PASSED");
} catch (err) {
   failures = 1;
   console.error(`\n❌ FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
   await fetcher.dispose();
}

process.exit(failures);
