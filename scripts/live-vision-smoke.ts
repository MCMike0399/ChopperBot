/**
 * Live end-to-end smoke of the NEW vision path — DeepSeek V4.1 Flash.
 *
 * Before the 2026-09-14 v4.1 migration this file smoked the Amazon Bedrock/Nova
 * vision path. Both are gone: V4.1 Flash is natively multimodal and is the ONLY
 * backend, so an image rides the SAME chat-completions request as the tools —
 * no separate vision call, no two-stage "transcribe first, then decide". What it
 * proves, live:
 *
 *   1. src/llm/client.ts reaches DeepSeek (DEEPSEEK_API_KEY / DEEP_SEEK_API_KEY,
 *      DEEPSEEK_BASE_URL, model id `deepseek-flash`) and a plain no-tools turn
 *      returns text.
 *   2. A multi-step tool-calling turn: the model emits tool_calls, the loop runs
 *      the handler, appends the role:'tool' results, and the model synthesizes a
 *      final answer (the calendar/config agent loop in miniature).
 *   3. An `ImageAttachable` handed to ask() as a Turn attachment is actually
 *      SEEN — the model must name the colour of a synthesized solid PNG — and
 *      the tools are advertised in that same request, which is the whole point
 *      of the migration.
 *   4. The REAL IG post classifier (classifyPost) returns valid JSON for a
 *      relevant convocatoria and an irrelevant meme, with the cover image handed
 *      to the SAME single call that makes the relevance decision.
 *
 * Usage:  npx tsx scripts/live-vision-smoke.ts
 *
 * Does NOT run inside `pnpm test` (that suite mocks the LLM client). This script
 * makes real DeepSeek calls and spends a small amount of token budget.
 */
import "dotenv/config";
import { deflateSync } from "node:zlib";
import { textBackend } from "../src/config.js";
import { ask } from "../src/llm/client.js";
import { composeToolSources, type ToolSource } from "../src/tools/source.js";
import { ImageAttachable } from "../src/attachments/attachable.js";
import { classifyPost } from "../src/capabilities/instagram_monitor/classifier.js";
import type { RecentPost } from "../src/capabilities/instagram_monitor/fetcher.js";

// Build a valid solid-color RGB PNG of size×size. A degenerate 1×1 PNG is
// rejected by the provider's image decoder ("You have uploaded an unsupported
// image" — probed 2026-09-14, a decode error rather than a capability gap), so
// we synthesize a real one the way a downloaded IG flyer cover would look. A
// 64×64 solid PNG was probed live on `deepseek-flash` alongside 512×512 ones and
// reads fine.
function crc32(buf: Uint8Array): number {
   let c = 0xffffffff;
   for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
   }
   return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
   const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
   const body = new Uint8Array(typeBytes.length + data.length);
   body.set(typeBytes, 0);
   body.set(data, typeBytes.length);
   const len = data.length;
   const out = new Uint8Array(4 + body.length + 4);
   const dv = new DataView(out.buffer);
   dv.setUint32(0, len);
   out.set(body, 4);
   dv.setUint32(4 + body.length, crc32(body));
   return out;
}
function makeSolidPng(
   size: number,
   r: number,
   g: number,
   b: number,
): Uint8Array {
   const ihdr = new Uint8Array(13);
   const dv = new DataView(ihdr.buffer);
   dv.setUint32(0, size);
   dv.setUint32(4, size);
   ihdr[8] = 8; // bit depth
   ihdr[9] = 2; // color type RGB
   const raw = new Uint8Array(size * (1 + size * 3));
   for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 3);
      raw[row] = 0; // filter: none
      for (let x = 0; x < size; x++) {
         const p = row + 1 + x * 3;
         raw[p] = r;
         raw[p + 1] = g;
         raw[p + 2] = b;
      }
   }
   const sig = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
   ]);
   const idat = new Uint8Array(deflateSync(raw));
   const parts = [
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", new Uint8Array(0)),
   ];
   const total = parts.reduce((n, p) => n + p.length, 0);
   const png = new Uint8Array(total);
   let off = 0;
   for (const p of parts) {
      png.set(p, off);
      off += p.length;
   }
   return png;
}
/** Solid red, 220/30/30 — the colour step 3 requires the model to name. */
const RED_PNG = makeSolidPng(64, 220, 30, 30);

const greenCheck = "\x1b[32m✓\x1b[0m";
const redX = "\x1b[31m✗\x1b[0m";
let failures = 0;
function pass(label: string, detail?: string) {
   console.log(`${greenCheck} ${label}${detail ? "  " + detail : ""}`);
}
function fail(label: string, err: unknown) {
   failures++;
   console.log(`${redX} ${label}`);
   console.log("   ", err instanceof Error ? err.message : String(err));
}
const short = (s: string) => (s.length > 90 ? s.slice(0, 90) + "…" : s);

// A trivial echo tool to exercise the tool_call → role:'tool' round-trip.
const echoSource: ToolSource = {
   name: "echo",
   async systemPromptSection() {
      return "You have an `echo` tool that returns the string you pass to it.";
   },
   tools() {
      return [
         {
            name: "echo",
            description:
               "Return the input text unchanged. Call this when the user asks to echo a literal value.",
            inputSchema: {
               type: "object",
               properties: {
                  text: {
                     type: "string",
                     description: "The text to echo back.",
                  },
               },
               required: ["text"],
            },
         },
      ];
   },
   async handle(_name, input) {
      const obj = input as { text?: unknown };
      if (typeof obj?.text !== "string")
         return {
            status: "error",
            payload: { error: "text must be a string" },
         };
      return { status: "success", payload: { echoed: obj.text } };
   },
};

function fakePost(over: Partial<RecentPost> = {}): RecentPost {
   return {
      igPostId: "1",
      shortcode: "ABC123",
      caption: "",
      takenAtMs: Date.parse("2026-06-20T18:00:00Z"),
      mediaType: "image",
      displayUrl: "https://example.com/x.jpg",
      ...over,
   };
}

async function main() {
   console.log("=== Live DeepSeek V4.1 Flash vision smoke ===");
   console.log("Provider:", textBackend.provider);
   console.log("Model:   ", textBackend.modelId);
   console.log("Base URL:", textBackend.baseUrl);
   console.log(
      "Key:     ",
      textBackend.apiKey ? textBackend.apiKey.slice(0, 6) + "…" : "(MISSING)",
   );
   console.log();

   // 1. Plain text round-trip.
   try {
      const out = await ask({
         system: "You are a terse assistant. Reply in fewer than 15 words.",
         messages: [
            {
               role: "user",
               content: 'Say "deepseek smoke ok" verbatim, then stop.',
            },
         ],
         tools: composeToolSources([]),
      });
      out.toLowerCase().includes("deepseek smoke ok")
         ? pass("plain text turn", short(out))
         : fail("plain text turn — marker missing", out);
   } catch (err) {
      fail("plain text turn", err);
   }

   // 2. Tool-calling round-trip.
   try {
      const out = await ask({
         system:
            "You have an `echo` tool. When asked to echo something, call `echo` with the exact text, then report what it returned.",
         messages: [
            {
               role: "user",
               content:
                  'Use the echo tool to echo "deepseek-tool-ok" exactly, then tell me what it returned.',
            },
         ],
         tools: composeToolSources([echoSource]),
      });
      out.toLowerCase().includes("deepseek-tool-ok")
         ? pass("tool-calling turn", short(out))
         : fail("tool-calling turn — echoed string missing", out);
   } catch (err) {
      fail("tool-calling turn", err);
   }

   // 3. Image attachment (vision). The echo tool is advertised in this SAME
   // request on purpose: the migration's claim is that the image and the tools
   // ride one call, so this is the shape that must keep working.
   try {
      const img = new ImageAttachable("red.png", "image/png", RED_PNG, "png");
      const out = await ask({
         system:
            "You can see images. Be terse. You may answer with no tool call at all.",
         messages: [
            {
               role: "user",
               content:
                  "What is the dominant color of the attached image? Reply with one word.",
               attachments: [img],
            },
         ],
         tools: composeToolSources([echoSource]),
      });
      // The assertion is the colour, not merely "some text came back": an
      // answer that ignores the image is the regression this catches.
      /\bred\b|\brojo\b/i.test(out)
         ? pass("image attachment turn (named the colour)", short(out))
         : fail("image attachment turn — did not name the red colour", out);
   } catch (err) {
      fail("image attachment turn", err);
   }

   // 4. The REAL IG classifier — relevant convocatoria, cover image attached to
   // the single deciding call (it used to be a separate transcription stage).
   try {
      const c = await classifyPost(
         "colectiva_demo",
         fakePost({
            caption:
               "📣 CONVOCATORIA: Asamblea feminista este sábado 21 de junio, 17:00 hrs en el Zócalo de la CDMX. Trae pancartas. ¡Te esperamos!",
         }),
         {
            nowMs: Date.parse("2026-06-19T12:00:00Z"),
            cover: { bytes: RED_PNG, mimeType: "image/png", format: "png" },
         },
      );
      if (c.reason) fail("classifier (convocatoria)", new Error(c.reason));
      else if (c.relevant && (c.type === "convocatoria" || c.type === "evento"))
         pass(
            "classifier (convocatoria + cover)",
            `type=${c.type} when=${c.when ?? "∅"} where=${short(c.where ?? "∅")}`,
         );
      else
         fail(
            "classifier (convocatoria + cover) — expected relevant convocatoria/evento",
            JSON.stringify(c),
         );
   } catch (err) {
      fail("classifier (convocatoria)", err);
   }

   // 4b. The REAL IG classifier — irrelevant meme (same cover, so an image
   // alone must not turn a meme into a relevant post).
   try {
      const c = await classifyPost(
         "colectiva_demo",
         fakePost({
            shortcode: "MEME1",
            caption: "jajaja buen lunes 😂😂 #meme #frase",
         }),
         {
            nowMs: Date.parse("2026-06-19T12:00:00Z"),
            cover: { bytes: RED_PNG, mimeType: "image/png", format: "png" },
         },
      );
      if (c.reason) fail("classifier (meme)", new Error(c.reason));
      else if (!c.relevant)
         pass("classifier (meme)", `correctly not relevant (type=${c.type})`);
      else fail("classifier (meme) — expected not relevant", JSON.stringify(c));
   } catch (err) {
      fail("classifier (meme)", err);
   }

   console.log();
   if (failures === 0) {
      console.log(
         `${greenCheck} All live DeepSeek vision smoke checks passed.`,
      );
      process.exit(0);
   } else {
      console.log(`${redX} ${failures} check(s) failed.`);
      process.exit(1);
   }
}

main().catch((err) => {
   console.error("Smoke test crashed:", err);
   process.exit(1);
});
