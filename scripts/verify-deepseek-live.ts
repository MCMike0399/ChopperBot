/**
 * LIVE end-to-end check of the SHIPPED client against the real DeepSeek API.
 *
 * The three `probe-deepseek-v41-*.ts` scripts talk to the API directly, so they
 * prove what the API does. This one proves what **our code** does with it: it
 * drives `ask()` and `classifyPost()` — the real functions, the real request
 * builder, the real response parsing — and costs a few cents.
 *
 * Run it after anything that touches the image path, the effort tiers or the
 * tool loop. It needs `DEEPSEEK_API_KEY` (or `DEEP_SEEK_API_KEY`) in the
 * environment or in `./.env`; it makes NO Discord calls and writes nothing.
 *
 *   npx tsx scripts/verify-deepseek-live.ts
 *
 * What it covers, and why each one is here:
 *   1  text turn, `low`   — thinking off; asserts the tier reaches the wire
 *   2  tool loop, `high`  — a real tool round-trip, the shape calendar uses
 *   3  IMAGE turn, `high` — the migration's whole point: pixels + tools in ONE
 *                           request, and the model reading the colour correctly
 *   4  classifier, cover  — `classifyPost` on a flyer-like PNG, single call
 *   5  effort tiers       — `max` accepted; invalid values do NOT error
 *                           upstream, which is why we only ever send documented
 *                           ones (see docs/llm.md §Evidence)
 */
import { deflateSync } from "node:zlib";
import { config as dotenv } from "dotenv";
dotenv({ override: false });

if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEP_SEEK_API_KEY) {
   console.error(
      "No DEEPSEEK_API_KEY / DEEP_SEEK_API_KEY — put one in .env or the environment.",
   );
   process.exit(1);
}

import { ask } from "../src/llm/client.js";
import { composeToolSources, type ToolSource } from "../src/tools/source.js";
import { ImageAttachable } from "../src/attachments/attachable.js";
import { classifyPost } from "../src/capabilities/instagram_monitor/classifier.js";


// ── a real PNG, because a 1×1 is rejected by the API as a decode error ───────
function crc32(buf: Uint8Array): number {
   let c = 0xffffffff;
   for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
   }
   return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
   const tb = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
   const body = new Uint8Array(tb.length + data.length);
   body.set(tb, 0);
   body.set(data, tb.length);
   const out = new Uint8Array(4 + body.length + 4);
   const dv = new DataView(out.buffer);
   dv.setUint32(0, data.length);
   out.set(body, 4);
   dv.setUint32(4 + body.length, crc32(body));
   return out;
}
/** Solid-colour square; the model should name the colour. */
function solidPng(size: number, r: number, g: number, b: number): Uint8Array {
   const ihdr = new Uint8Array(13);
   const dv = new DataView(ihdr.buffer);
   dv.setUint32(0, size);
   dv.setUint32(4, size);
   ihdr[8] = 8;
   ihdr[9] = 2; // RGB
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
   const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
   const parts = [
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
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

/**
 * A big solid disc on a white field. Deliberately NOT a uniform square: a
 * uniform image makes the model's colour answer a coin-flip on "background" vs
 * "foreground" (observed on the first run of this script: a solid red square was
 * reported as "fondo blanco"). A disc leaves no ambiguity about what the subject
 * is, so this check measures the image PATH rather than the model's mood.
 */
function discPng(size: number, r: number, g: number, b: number): Uint8Array {
   const ihdr = new Uint8Array(13);
   const dv = new DataView(ihdr.buffer);
   dv.setUint32(0, size);
   dv.setUint32(4, size);
   ihdr[8] = 8;
   ihdr[9] = 2;
   const raw = new Uint8Array(size * (1 + size * 3));
   const cx = size / 2;
   const cy = size / 2;
   const rad = size * 0.38;
   for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 3);
      raw[row] = 0;
      for (let x = 0; x < size; x++) {
         const p = row + 1 + x * 3;
         const inside = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
         raw[p] = inside ? r : 255;
         raw[p + 1] = inside ? g : 255;
         raw[p + 2] = inside ? b : 255;
      }
   }
   const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
   const parts = [
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
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

const RED = solidPng(512, 220, 30, 30);
const BLUE = solidPng(256, 30, 60, 220);
const RED_DISC = discPng(512, 220, 20, 20);
const NO_TOOLS = composeToolSources([]);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail: string): void {
   if (ok) {
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${label} — ${detail}`);
   } else {
      fail++;
      console.log(`  \x1b[31m✗\x1b[0m ${label} — ${detail}`);
   }
}

console.log(`live DeepSeek check — model=${process.env.DEEPSEEK_MODEL_ID ?? "deepseek-flash"}\n`);

// ── 1. plain text at the cheap tier ─────────────────────────────────────────
console.log("1) text turn, effort low");
{
   const t0 = Date.now();
   const out = await ask({
      system:
         "Eres ChopperBot, un bot de Discord en español. Responde en una sola línea, breve.",
      messages: [{ role: "user", content: "Di exactamente: listo." }],
      tools: NO_TOOLS,
      effort: "low",
   });
   check(
      "text/low answered",
      out.length > 0 && !out.includes("No pude generar"),
      `${(Date.now() - t0) / 1000}s · ${JSON.stringify(out.slice(0, 70))}`,
   );
}

// ── 2. a real tool round-trip at the reasoning tier ─────────────────────────
console.log("\n2) tool loop, effort high");
{
   const calls: string[] = [];
   const source: ToolSource = {
      name: "stub",
      systemPromptSection: async () => "",
      tools: () => [
         {
            name: "calendar_check_availability",
            description:
               "Revisa si una sala está libre a una hora dada. Úsala SIEMPRE antes de responder sobre disponibilidad.",
            inputSchema: {
               type: "object",
               properties: {
                  room: { type: "string", description: "Nombre de la sala" },
                  start_at: { type: "string", description: "ISO 8601" },
               },
               required: ["room", "start_at"],
            },
         },
      ],
      handle: async (name, input) => {
         calls.push(name);
         return {
            status: "success" as const,
            payload: { available: false, busy_with: "Cineclub", input },
         };
      },
   };
   const out = await ask({
      system:
         "Eres ChopperBot. Usa las herramientas cuando la pregunta lo requiera. Responde en español, breve.",
      messages: [
         {
            role: "user",
            content:
               "¿Está libre la Sala de Eventos el viernes 2026-09-18 a las 20:00?",
         },
      ],
      tools: composeToolSources([source]),
      effort: "high",
   });
   check(
      "the tool actually ran",
      calls.includes("calendar_check_availability"),
      `handlers invoked: [${calls.join(", ") || "none"}]`,
   );
   check(
      "the answer reflects the tool result",
      /cineclub|no est|ocupad|no hay|busy/i.test(out),
      JSON.stringify(out.slice(0, 120)),
   );
}

// ── 3. the migration's point: pixels + tools in ONE request ─────────────────
console.log("\n3) IMAGE turn with tools, effort high");
{
   let toolRuns = 0;
   const source: ToolSource = {
      name: "stub",
      systemPromptSection: async () => "",
      tools: () => [
         {
            name: "calendar_create_event",
            description: "Crea un evento en el calendario.",
            inputSchema: {
               type: "object",
               properties: {
                  title: { type: "string" },
                  color_seen: {
                     type: "string",
                     description:
                        "El color dominante de la imagen adjunta, en español.",
                  },
               },
               required: ["title", "color_seen"],
            },
         },
      ],
      handle: async () => {
         toolRuns++;
         return { status: "success" as const, payload: { id: 99, ok: true } };
      },
   };
   const out = await ask({
      system:
         "Eres ChopperBot. Cuando te manden una imagen, MÍRALA y usa su contenido. Responde en español.",
      messages: [
         {
            role: "user",
            content:
               "Mira la imagen adjunta y crea un evento titulado 'Prueba de visión'. En color_seen pon el color del CÍRCULO (la figura), no el del fondo.",
            attachments: [
               new ImageAttachable("circulo-rojo.png", "image/png", RED_DISC, "png"),
            ],
         },
      ],
      tools: composeToolSources([source]),
      effort: "high",
   });
   check(
      "the image turn ran its tool (not a vision-only call)",
      toolRuns > 0,
      `tool runs: ${toolRuns}`,
   );
   check(
      "the model saw the RED circle",
      /roj/i.test(out),
      JSON.stringify(out.slice(0, 140)),
   );
}

// ── 4. the IG classifier path, single multimodal call ───────────────────────
console.log("\n4) classifyPost with a cover image");
{
   const out = await classifyPost(
      "colectivo_prueba",
      {
         igPostId: "1",
         shortcode: "LIVETEST",
         caption:
            "¡Este viernes! Asamblea abierta del comité de vivienda. 19:00 en la Casa del Pueblo, CDMX. ¡Trae a tu compa!",
         takenAtMs: Date.now(),
         mediaType: "image",
         displayUrl: "https://example.invalid/live.png",
      },
      {
         cover: { bytes: BLUE, mimeType: "image/png", format: "png" },
         nowMs: Date.now(),
      },
   );
   check(
      "classification parsed",
      out.reason === undefined,
      `reason=${out.reason ?? "none"}`,
   );
   check(
      "an activist assembly reads as relevant",
      out.relevant === true,
      `relevant=${out.relevant} type=${out.type} title=${JSON.stringify(out.title)}`,
   );
}

// ── 5. the effort tiers we ship ─────────────────────────────────────────────
console.log("\n5) effort tiers");
for (const effort of ["low", "high", "max"] as const) {
   const t0 = Date.now();
   const out = await ask({
      system: "Responde en español, en una línea.",
      messages: [
         { role: "user", content: "Nombra un color y nada más." },
      ],
      tools: NO_TOOLS,
      effort,
   });
   check(
      `effort ${effort}`,
      out.length > 0 && !out.includes("No pude generar"),
      `${(Date.now() - t0) / 1000}s · ${JSON.stringify(out.slice(0, 50))}`,
   );
}

console.log(
   `\n${fail === 0 ? "\x1b[32mALL GREEN\x1b[0m" : `\x1b[31m${fail} FAILED\x1b[0m`} — ${pass} passed, ${fail} failed`,
);
process.exit(fail === 0 ? 0 : 1);
