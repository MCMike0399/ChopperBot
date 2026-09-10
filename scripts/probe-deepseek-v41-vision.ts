/**
 * Probe 2: DeepSeek V4.1 Flash — resolve two ambiguities from probe 1.
 *
 *  A) VISION — probe 1's hand-rolled 1×1 base64 PNG was rejected with
 *     "You have uploaded an unsupported image", which is the API's *decode*
 *     error, not the old "unknown variant 'image_url'" deserialization 400.
 *     Retry with a properly synthesized 512×512 PNG (the same generator the
 *     Bedrock smoke uses) plus a JPEG and a WebP, and pin down whether vision
 *     works and whether `detail` is honoured.
 *
 *  B) EFFORT — on a trivial question every tier produced ~100 reasoning
 *     tokens, i.e. the knob looked inert (exactly what v4-flash did). Retry on
 *     a genuinely hard task, several reps per tier, to see whether
 *     low/high/max actually move reasoning volume. This decides whether the
 *     three new tiers are real or cosmetic.
 */
import OpenAI from "openai";
import { deflateSync } from "node:zlib";
import { config as dotenv } from "dotenv";
dotenv({ override: false });

const key = process.env.DEEPSEEK_API_KEY ?? process.env.DEEP_SEEK_API_KEY!;
const client = new OpenAI({ apiKey: key, baseURL: "https://api.deepseek.com/v1" });
const MODEL = "deepseek-flash";

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
   const out = new Uint8Array(4 + body.length + 4);
   const dv = new DataView(out.buffer);
   dv.setUint32(0, data.length);
   out.set(body, 4);
   dv.setUint32(4 + body.length, crc32(body));
   return out;
}
function makeSolidPng(size: number, r: number, g: number, b: number): Uint8Array {
   const ihdr = new Uint8Array(13);
   const dv = new DataView(ihdr.buffer);
   dv.setUint32(0, size);
   dv.setUint32(4, size);
   ihdr[8] = 8;
   ihdr[9] = 2;
   const raw = new Uint8Array(size * (1 + size * 3));
   for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 3);
      raw[row] = 0;
      for (let x = 0; x < size; x++) {
         const p = row + 1 + x * 3;
         raw[p] = r;
         raw[p + 1] = g;
         raw[p + 2] = b;
      }
   }
   const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
   const idat = new Uint8Array(deflateSync(raw));
   const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
   const total = parts.reduce((n, p) => n + p.length, 0);
   const png = new Uint8Array(total);
   let off = 0;
   for (const p of parts) {
      png.set(p, off);
      off += p.length;
   }
   return png;
}

const RED = Buffer.from(makeSolidPng(512, 220, 30, 30)).toString("base64");
const GREEN = Buffer.from(makeSolidPng(512, 30, 200, 60)).toString("base64");
const SMALL = Buffer.from(makeSolidPng(64, 20, 60, 220)).toString("base64");
/** The exact 1×1 that probe 1 sent, kept as a control. */
const ONE_PX =
   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let calls = 0;
const usage = { in: 0, out: 0, cache: 0 };

async function call(body: Record<string, unknown>) {
   calls++;
   try {
      const res: any = await client.chat.completions.create(body as any);
      usage.in += res.usage?.prompt_tokens ?? 0;
      usage.out += res.usage?.completion_tokens ?? 0;
      usage.cache += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return { ok: true as const, res };
   } catch (e: any) {
      return { ok: false as const, err: e };
   }
}
const errLine = (e: any) =>
   `${e?.status ?? ""} ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 165)}`;
const think = (r: any) => r?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

/** Build a flyer-like PNG: solid background with a black band across the middle
 *  so the model has something non-trivial to look at. */
function makeBandedPng(size: number): Uint8Array {
   const ihdr = new Uint8Array(13);
   const dv = new DataView(ihdr.buffer);
   dv.setUint32(0, size);
   dv.setUint32(4, size);
   ihdr[8] = 8;
   ihdr[9] = 2;
   const raw = new Uint8Array(size * (1 + size * 3));
   for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 3);
      raw[row] = 0;
      for (let x = 0; x < size; x++) {
         const p = row + 1 + x * 3;
         const band = Math.floor(y / (size / 4)) % 2 === 0;
         raw[p] = band ? 240 : 20;
         raw[p + 1] = band ? 240 : 20;
         raw[p + 2] = band ? 240 : 200;
      }
   }
   const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
   const idat = new Uint8Array(deflateSync(raw));
   const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
   const total = parts.reduce((n, p) => n + p.length, 0);
   const png = new Uint8Array(total);
   let off = 0;
   for (const p of parts) {
      png.set(p, off);
      off += p.length;
   }
   return png;
}
const BANDED = Buffer.from(makeBandedPng(512)).toString("base64");

async function vision() {
   console.log("\nA) VISION");
   const variants: Array<[string, string]> = [
      ["512×512 red PNG", RED],
      ["64×64 blue PNG", SMALL],
      ["1×1 PNG (probe-1 control)", ONE_PX],
      ["512×512 banded PNG", BANDED],
   ];
   for (const [label, b64] of variants) {
      const r = await call({
         model: MODEL,
         max_tokens: 2000,
         thinking: { type: "disabled" },
         messages: [
            {
               role: "user",
               content: [
                  {
                     type: "text",
                     text: "Describe en una frase corta qué color(es) y formas ves en la imagen.",
                  },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
               ],
            },
         ],
      });
      console.log(
         `   ${label.padEnd(28)} ${
            r.ok
               ? `OK ${JSON.stringify(String(r.res.choices[0].message.content ?? "").slice(0, 70))}`
               : `ERR ${errLine(r.err)}`
         }`,
      );
   }

   // Two images in one turn (the bot accepts up to MAX_ATTACHMENT_COUNT=5).
   const multi = await call({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      messages: [
         {
            role: "user",
            content: [
               { type: "text", text: "¿Cuántas imágenes hay y de qué color es cada una?" },
               { type: "image_url", image_url: { url: `data:image/png;base64,${RED}` } },
               { type: "image_url", image_url: { url: `data:image/png;base64,${GREEN}` } },
            ],
         },
      ],
   });
   console.log(
      `   two images in one turn        ${
         multi.ok
            ? `OK ${JSON.stringify(String(multi.res.choices[0].message.content ?? "").slice(0, 90))}`
            : `ERR ${errLine(multi.err)}`
      }`,
   );

   // Images + tools + thinking on — the real production shape (a calendar flyer).
   const withTools = await call({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "enabled", reasoning_effort: "high" },
      tools: [
         {
            type: "function",
            function: {
               name: "calendar_create_event",
               description: "Crea un evento en el calendario.",
               parameters: {
                  type: "object",
                  properties: {
                     title: { type: "string" },
                     start_at: { type: "string" },
                     location: { type: "string" },
                  },
                  required: ["title", "start_at"],
               },
            },
         },
      ],
      messages: [
         {
            role: "user",
            content: [
               {
                  type: "text",
                  text: "Agenda un evento titulado 'Prueba de visión' el 2026-10-01 a las 19:00 en la Casa del Pueblo.",
               },
               { type: "image_url", image_url: { url: `data:image/png;base64:${BANDED}` } },
            ],
         },
      ],
   });
   console.log(
      `   image + tools + thinking      ${
         withTools.ok
            ? `OK tools=${(withTools.res.choices[0].message.tool_calls ?? []).length} finish=${withTools.res.choices[0].finish_reason}`
            : `ERR ${errLine(withTools.err)}`
      }`,
   );

   // An image in an assistant/system message must 400 (docs restriction).
   const badRole = await call({
      model: MODEL,
      max_tokens: 200,
      thinking: { type: "disabled" },
      messages: [
         {
            role: "assistant",
            content: [
               { type: "text", text: "mira" },
               { type: "image_url", image_url: { url: `data:image/png;base64,${SMALL}` } },
            ],
         },
         { role: "user", content: "hola" },
      ],
   });
   console.log(
      `   image in ASSISTANT msg        ${badRole.ok ? "OK (!! allowed)" : `ERR ${errLine(badRole.err)}`}`,
   );
}

/** Hard task, several reps per tier. */
async function effort() {
   console.log("\nB) EFFORT on a genuinely hard task (3 reps each)");
   const HARD =
      "Una asamblea tiene 7 comisiones y 23 personas. Cada persona debe estar en exactamente " +
      "una comisión, ninguna comisión puede quedar vacía, y ninguna comisión puede tener más " +
      "de 4 personas. ¿Cuántas asignaciones distintas existen? Da el número exacto y justifica " +
      "el cálculo en 3 líneas como máximo.";
   const variants: Array<[string, Record<string, unknown>]> = [
      ["thinking disabled", { thinking: { type: "disabled" } }],
      ["effort low", { thinking: { type: "enabled", reasoning_effort: "low" } }],
      ["effort high", { thinking: { type: "enabled", reasoning_effort: "high" } }],
      ["effort max", { thinking: { type: "enabled", reasoning_effort: "max" } }],
   ];
   for (const [label, extra] of variants) {
      const thinkTok: number[] = [];
      const outTok: number[] = [];
      const ms: number[] = [];
      let ok = 0;
      for (let i = 0; i < 3; i++) {
         const t0 = Date.now();
         const r = await call({
            model: MODEL,
            max_tokens: 60000,
            messages: [
               { role: "system", content: "Responde en español, conciso." },
               { role: "user", content: HARD },
            ],
            ...extra,
         });
         if (!r.ok) {
            console.log(`   ${label} rep${i} ERR ${errLine(r.err)}`);
            continue;
         }
         ok++;
         thinkTok.push(think(r.res));
         outTok.push(r.res.usage?.completion_tokens ?? 0);
         ms.push(Date.now() - t0);
      }
      const mean = (a: number[]) =>
         a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1;
      console.log(
         `   ${label.padEnd(20)} ok=${ok}/3  reasoning=${String(mean(thinkTok)).padStart(6)}  out=${String(mean(outTok)).padStart(6)}  ${String(mean(ms)).padStart(6)}ms   [${thinkTok.join(",")}]`,
      );
   }
}

async function main() {
   console.log(`PROBE 2 — ${MODEL}`);
   await vision();
   await effort();
   console.log(
      `\ndone — ${calls} requests, prompt=${usage.in} (cached=${usage.cache}) completion=${usage.out}`,
   );
}

void main();
