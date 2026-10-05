/**
 * Live A/B of the IG classifier on REAL past posts: cover-only vs cover + carousel
 * slides, both through the real `classifyPost` (one DeepSeek V4.1 Flash call each,
 * JSON mode). Answers "does reading the slides actually extract more event
 * dates/places?" with data instead of a guess.
 *
 * Source images come from DISCORD, never Instagram: every pushed carousel card
 * already re-uploaded the cover + up to 3 slides as attachments. So this makes
 * ZERO Instagram requests (no IG budget, no automation signal) — it reads
 * `instagram_monitor_seen_posts` for recent pushed carousels, fetches each card
 * via the Discord REST API with the bot token, and replays the classifier.
 *
 * NOT a test, and it is billed: 2 DeepSeek calls per post (~$0.001 each at
 * current V4.1 Flash prices). Run deliberately, never in a loop or from CI.
 *
 * Usage:  npx tsx scripts/eval-ig-classifier-slides.ts [--limit=20]
 */
import Database from "better-sqlite3";
import { config as dotenv } from "dotenv";
dotenv({ override: false });

const { classifyPost } =
   await import("../src/capabilities/instagram_monitor/classifier.js");
const { sniffImageFormat } = await import("../src/attachments/attachable.js");
type ClassifierImage =
   import("../src/capabilities/instagram_monitor/classifier.js").ClassifierImage;
type Classification =
   import("../src/capabilities/instagram_monitor/classifier.js").Classification;

const limit = Number(
   process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 20,
);
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is not set");

const db = new Database("data/chopperbot.db", { readonly: true });
const rows = db
   .prepare(
      `SELECT ig_post_id, account_username, channel_id, caption, posted_at,
              classification_json, discord_message_id
         FROM instagram_monitor_seen_posts
        WHERE pushed = 1 AND media_type = 'carousel'
          AND discord_message_id IS NOT NULL
          AND detected_at >= strftime('%s','2026-09-10')*1000
        GROUP BY ig_post_id
        ORDER BY detected_at DESC
        LIMIT ?`,
   )
   .all(limit) as Array<{
   ig_post_id: string;
   account_username: string;
   channel_id: string;
   caption: string | null;
   posted_at: number;
   classification_json: string;
   discord_message_id: string;
}>;

async function discordAttachments(
   channelId: string,
   messageId: string,
): Promise<ClassifierImage[]> {
   const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { headers: { Authorization: `Bot ${token}` } },
   );
   if (!res.ok) throw new Error(`discord ${res.status}`);
   const msg = (await res.json()) as {
      attachments: Array<{ filename: string; url: string }>;
   };
   const out: ClassifierImage[] = [];
   for (const a of msg.attachments) {
      if (!/\.(jpe?g|png|webp)$/i.test(a.filename)) continue;
      const bytes = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
      const format = sniffImageFormat(bytes);
      if (format) out.push({ bytes, mimeType: `image/${format}`, format });
   }
   return out;
}

const show = (c: Classification) =>
   `${c.relevant ? "REL" : "no "} ${c.type.padEnd(13)} when=${c.when ?? "—"} where=${c.where ?? "—"}${c.undecided ? ` UNDECIDED(${c.reason})` : ""}`;

let n = 0;
let whenA = 0;
let whenB = 0;
let whereA = 0;
let whereB = 0;
let relAgree = 0;
let undecided = 0;
const wins: string[] = [];
for (const r of rows) {
   let images: ClassifierImage[];
   try {
      images = await discordAttachments(r.channel_id, r.discord_message_id);
   } catch (err) {
      console.log(`skip ${r.ig_post_id}: ${String(err)}`);
      continue;
   }
   if (images.length < 2) continue; // need at least one slide beyond the cover
   const post = {
      igPostId: r.ig_post_id,
      shortcode: r.ig_post_id,
      caption: r.caption ?? "",
      takenAtMs: r.posted_at,
      mediaType: "carousel" as const,
      displayUrl: "",
   };
   const [cover, ...slides] = images;
   const a = await classifyPost(r.account_username, post, {
      cover,
      nowMs: Date.now(),
   });
   const b = await classifyPost(r.account_username, post, {
      cover,
      slides,
      nowMs: Date.now(),
   });
   n++;
   if (a.undecided || b.undecided) undecided++;
   if (a.when) whenA++;
   if (b.when) whenB++;
   if (a.where) whereA++;
   if (b.where) whereB++;
   if (a.relevant === b.relevant) relAgree++;
   if (!a.when && b.when)
      wins.push(`@${r.account_username}: ${b.when} — ${b.title}`);
   console.log(
      `\n@${r.account_username} ${r.ig_post_id} (${images.length} imgs)`,
   );
   console.log(`  cover only : ${show(a)}`);
   console.log(`  + slides   : ${show(b)}`);
}

console.log("\n=== summary ===");
console.log(`posts compared        : ${n}`);
console.log(
   `event date extracted  : cover-only ${whenA}/${n} → with slides ${whenB}/${n}`,
);
console.log(
   `place extracted       : cover-only ${whereA}/${n} → with slides ${whereB}/${n}`,
);
console.log(`relevance agreement   : ${relAgree}/${n}`);
console.log(`undecided (any side)  : ${undecided}`);
if (wins.length)
   console.log(`dates ONLY found via slides:\n  ${wins.join("\n  ")}`);
