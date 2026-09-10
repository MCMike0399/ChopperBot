/**
 * Probe 3: is the `reasoning_effort` knob REAL on `deepseek-flash`?
 *
 * Probe 2 was inconclusive: on one hard task `low` produced MORE reasoning than
 * `high` (30k vs 6k on one rep) while `max` sat between them — the exact
 * signature v4-flash showed when it ignored the parameter entirely. But those
 * were 3 single-shot reps of ONE task, so task-level variance dominates.
 *
 * This probe removes that confound: a batch of FIXED, deterministic puzzles
 * (same difficulty for every tier) and 6 reps per tier, reporting mean AND
 * median reasoning tokens. A real knob moves the means apart monotonically; an
 * ignored knob leaves them overlapping. Also fills the two gaps probe 2 left:
 *   - images + tools + thinking (probe 2 sent a malformed `data:image/png;base64:`
 *     URL — a client-side typo, not an API answer)
 *   - a bogus effort value as the control (must NOT error if accepted silently,
 *     which is the dangerous case this whole question is about)
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
/** A 3-band "flyer" so the vision task is not degenerate. */
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
         const band = Math.floor(y / (size / 3)) % 3;
         raw[p] = band === 0 ? 200 : band === 1 ? 250 : 20;
         raw[p + 1] = band === 0 ? 30 : band === 1 ? 250 : 20;
         raw[p + 2] = band === 0 ? 30 : band === 1 ? 250 : 200;
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
   `${e?.status ?? ""} ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160)}`;
const think = (r: any) => r?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

/** Six fixed puzzles of comparable difficulty — each needs real multi-step
 *  arithmetic, so if the tier controls depth it shows up as a consistent
 *  per-tier distribution across DIFFERENT tasks, not one task's luck. */
const PUZZLES = [
   "¿Cuántos enteros entre 1 y 1000 NO son divisibles ni por 3 ni por 5 ni por 7? Da el número exacto y el cálculo.",
   "Un reloj de manecillas marca las 3:47. ¿Cuál es el ángulo menor entre la manecilla de horas y la de minutos, en grados y minutos de arco?",
   "¿Cuántas cadenas de 6 dígitos (0-9, se permiten ceros a la izquierda) tienen exactamente dos dígitos repetidos y el resto distintos? Explica.",
   "Si 7 personas se sientan en círculo, ¿de cuántas formas pueden hacerlo de modo que Ana y Beto NO queden juntos? Da el número.",
   "¿Cuál es el resto de 7^2026 al dividirlo entre 100? Justifica con el ciclo.",
   "Una urna tiene 5 rojas y 3 azules. Se sacan 4 sin reemplazo. ¿Cuál es la probabilidad exacta (fracción) de sacar exactamente 2 rojas?",
];

async function effortStats() {
   console.log("B) effort stats — 6 different puzzles × 6 reps per tier");
   const variants: Array<[string, Record<string, unknown>]> = [
      ["disabled", { thinking: { type: "disabled" } }],
      ["low", { thinking: { type: "enabled", reasoning_effort: "low" } }],
      ["high", { thinking: { type: "enabled", reasoning_effort: "high" } }],
      ["max", { thinking: { type: "enabled", reasoning_effort: "max" } }],
   ];
   const REP = 6;
   for (const [label, extra] of variants) {
      const thinkTok: number[] = [];
      const outTok: number[] = [];
      const ms: number[] = [];
      for (let i = 0; i < REP; i++) {
         const t0 = Date.now();
         const r = await call({
            model: MODEL,
            max_tokens: 60000,
            messages: [
               { role: "system", content: "Responde en español, conciso." },
               { role: "user", content: PUZZLES[i % PUZZLES.length] },
            ],
            ...extra,
         });
         if (!r.ok) {
            console.log(`   ${label} rep${i} ERR ${errLine(r.err)}`);
            continue;
         }
         thinkTok.push(think(r.res));
         outTok.push(r.res.usage?.completion_tokens ?? 0);
         ms.push(Date.now() - t0);
      }
      const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1);
      const median = (a: number[]) => {
         if (!a.length) return -1;
         const s = [...a].sort((x, y) => x - y);
         return s[Math.floor(s.length / 2)];
      };
      console.log(
         `   ${label.padEnd(9)} n=${thinkTok.length}  reasoning mean=${String(mean(thinkTok)).padStart(6)} median=${String(median(thinkTok)).padStart(6)}` +
            `  out mean=${String(mean(outTok)).padStart(6)}  ${String(mean(ms)).padStart(6)}ms  [${thinkTok.join(",")}]`,
      );
   }
   // Control: a value the docs do NOT list. If this 200s, an unknown effort is
   // silently accepted — the exact trap the old v4-flash fell into.
   const bogus = await call({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "enabled", reasoning_effort: "banana" },
      messages: [{ role: "user", content: "di ok" }],
   });
   console.log(
      `   control "banana"  ${bogus.ok ? `ACCEPTED SILENTLY (reasoning=${think(bogus.res)})` : `rejected: ${errLine(bogus.err)}`}`,
   );
   const minimal = await call({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "enabled", reasoning_effort: "minimal" },
      messages: [{ role: "user", content: "di ok" }],
   });
   console.log(
      `   "minimal" (docs: → low)  ${minimal.ok ? `OK reasoning=${think(minimal.res)}` : `rejected: ${errLine(minimal.err)}`}`,
   );
}

async function visionWithTools() {
   console.log("\nA) image + tools + thinking (probe 2 had a malformed data URL)");
   const r = await call({
      model: MODEL,
      max_tokens: 3000,
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
                  text: "Mira el flyer adjunto y agenda el evento que anuncia. Si no dice título, usa 'Evento del flyer'.",
               },
               { type: "image_url", image_url: { url: `data:image/png;base64,${BANDED}` } },
            ],
         },
      ],
   });
   if (!r.ok) {
      console.log(`   image + tools   ERR ${errLine(r.err)}`);
      return;
   }
   const m = r.res.choices[0].message;
   console.log(
      `   image + tools   OK tool_calls=${(m.tool_calls ?? []).length} names=${(m.tool_calls ?? []).map((c: any) => c.function?.name).join(",") || "—"} reasoning=${String(m.reasoning_content ?? "").length}ch`,
   );

   // Full round-trip with an image in history at effort=max, mirroring a real
   // multi-iteration calendar turn.
   const tc = (m.tool_calls ?? [])[0];
   if (!tc) return;
   const second = await call({
      model: MODEL,
      max_tokens: 3000,
      thinking: { type: "enabled", reasoning_effort: "max" },
      tools: [
         {
            type: "function",
            function: {
               name: "calendar_create_event",
               description: "Crea un evento en el calendario.",
               parameters: {
                  type: "object",
                  properties: { title: { type: "string" }, start_at: { type: "string" } },
                  required: ["title", "start_at"],
               },
            },
         },
      ],
      messages: [
         {
            role: "user",
            content: [
               { type: "text", text: "Mira el flyer adjunto y agenda el evento que anuncia." },
               { type: "image_url", image_url: { url: `data:image/png;base64,${BANDED}` } },
            ],
         },
         m,
         { role: "tool", tool_call_id: tc.id, content: '{"ok":true,"id":"evt_9"}' },
      ],
   });
   console.log(
      `   round-trip@max  ${
         second.ok
            ? `OK content=${JSON.stringify(String(second.res.choices[0].message.content ?? "").slice(0, 60))} finish=${second.res.choices[0].finish_reason}`
            : `ERR ${errLine(second.err)}`
      }`,
   );
}

async function main() {
   console.log(`PROBE 3 — ${MODEL}`);
   await visionWithTools();
   await effortStats();
   console.log(
      `\ndone — ${calls} requests, prompt=${usage.in} (cached=${usage.cache}) completion=${usage.out}`,
   );
}

void main();
