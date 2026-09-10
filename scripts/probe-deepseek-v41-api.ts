/**
 * Probe: DeepSeek V4.1 Flash (`deepseek-flash`) — the 2026-09-10 release.
 *
 * Answers the questions the migration depends on, each of which the docs leave
 * ambiguous or which previous probes answered for the RETIRED v4-flash model:
 *
 *   §1  model name + base_url shape (`/v1` vs bare) — legacy names still routed?
 *   §2  effort control: `thinking.reasoning_effort` vs top-level `reasoning_effort`
 *   §3  does each effort actually change reasoning-token volume? (the old
 *       v4-flash ignored `reasoning_effort` entirely — "banana" returned 200)
 *   §4  VISION: images really accepted now? (v4-flash 400'd on `image_url`)
 *   §5  tool round-trip in thinking mode: must `reasoning_content` be echoed
 *       back, and does omitting it really 400?
 *   §6  max_tokens default vs the 16k the bot currently sends
 */
import OpenAI from "openai";
import { config as dotenv } from "dotenv";
dotenv({ override: false });

const key = process.env.DEEPSEEK_API_KEY ?? process.env.DEEP_SEEK_API_KEY!;
const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = "deepseek-flash";

const client = new OpenAI({ apiKey: key, baseURL: BASE });

/** 1x1 red PNG — smallest valid image that exercises the vision decoder. */
const PNG_B64 =
   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let calls = 0;
async function call(
   label: string,
   body: Record<string, unknown>,
   baseUrl = BASE,
): Promise<{ ok: boolean; res?: any; err?: any }> {
   const c = baseUrl === BASE ? client : new OpenAI({ apiKey: key, baseURL: baseUrl });
   calls++;
   try {
      const res: any = await c.chat.completions.create(body as any);
      return { ok: true, res };
   } catch (e: any) {
      return { ok: false, err: e };
   }
}

function errLine(err: any): string {
   const status = err?.status ?? "";
   const msg = String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 170);
   return `${status} ${msg}`;
}

function think(res: any): number {
   return res?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
}
function outTok(res: any): number {
   return res?.usage?.completion_tokens ?? 0;
}

const TOOLS = [
   {
      type: "function" as const,
      function: {
         name: "calendar_create_event",
         description: "Crea un evento en el calendario.",
         parameters: {
            type: "object",
            properties: {
               title: { type: "string" },
               start_at: { type: "string", description: "ISO 8601" },
            },
            required: ["title", "start_at"],
         },
      },
   },
];

const TASK =
   "Agenda el Círculo de estudios el próximo jueves a las 20:00 en la Casa del Pueblo. Hoy es lunes 2026-09-14.";

async function s1_modelAndBaseUrl() {
   console.log("\n§1 model name + base_url");
   for (const [label, base] of [
      ["bare https://api.deepseek.com", "https://api.deepseek.com"],
      ["/v1  https://api.deepseek.com/v1", "https://api.deepseek.com/v1"],
   ] as const) {
      const r = await call("s1", {
         model: MODEL,
         messages: [{ role: "user", content: "di ok" }],
         max_tokens: 16,
         thinking: { type: "disabled" },
      }, base);
      console.log(
         `   ${label.padEnd(34)} ${r.ok ? `OK model=${r.res.model}` : `ERR ${errLine(r.err)}`}`,
      );
   }
   for (const legacy of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      const r = await call("s1", {
         model: legacy,
         messages: [{ role: "user", content: "di ok" }],
         max_tokens: 16,
         thinking: { type: "disabled" },
      });
      console.log(
         `   legacy ${legacy.padEnd(32 - 7)} ${r.ok ? `OK served-as=${r.res.model}` : `ERR ${errLine(r.err)}`}`,
      );
   }
   console.log(
      `   bogus model control                  ` +
         (await call("s1", {
            model: "deepseek-nope",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 8,
         })
            .then((r) => (r.ok ? "OK (!! silently accepted)" : `ERR ${errLine(r.err)}`))),
   );
}

/** One sample per effort variant, plus a repeat of the no-knob baseline to see
 *  whether the default is thinking-on/high (docs) and whether `low` really is
 *  cheaper than `high`/`max` (the old v4-flash did NOT honour this). */
async function s2_effort() {
   console.log("\n§2/§3 effort control (reasoning tokens = billed output)");
   const variants: Array<[string, Record<string, unknown>]> = [
      ["no knob (docs: thinking on/high)", {}],
      ["thinking disabled", { thinking: { type: "disabled" } }],
      ["thinking.reasoning_effort=low", { thinking: { type: "enabled", reasoning_effort: "low" } }],
      ["thinking.reasoning_effort=high", { thinking: { type: "enabled", reasoning_effort: "high" } }],
      ["thinking.reasoning_effort=max", { thinking: { type: "enabled", reasoning_effort: "max" } }],
      ["top-level reasoning_effort=low", { reasoning_effort: "low" }],
      ["top-level reasoning_effort=max", { reasoning_effort: "max" }],
      ["bogus knob (control)", { thinking: { type: "enabled", reasoning_effort: "banana" } }],
   ];
   for (const [label, extra] of variants) {
      const r = await call("s2", {
         model: MODEL,
         max_tokens: 4000,
         messages: [
            { role: "system", content: "Responde en español, breve." },
            { role: "user", content: "¿Cuántos primos hay entre 1 y 100? Da la lista y el total." },
         ],
         ...extra,
      });
      console.log(
         `   ${label.padEnd(34)} ${
            r.ok
               ? `reasoning=${String(think(r.res)).padStart(5)}  out=${String(outTok(r.res)).padStart(5)}  finish=${r.res.choices?.[0]?.finish_reason}`
               : `ERR ${errLine(r.err)}`
         }`,
      );
   }
}

async function s4_vision() {
   console.log("\n§4 vision (v4-flash used to 400 here)");
   const dataUrl = `data:image/png;base64,${PNG_B64}`;
   const variants: Array<[string, Record<string, unknown>]> = [
      [
         "image_url data-url (thinking off)",
         {
            thinking: { type: "disabled" },
            messages: [
               {
                  role: "user",
                  content: [
                     { type: "text", text: "¿Qué color ves? Una palabra." },
                     { type: "image_url", image_url: { url: dataUrl } },
                  ],
               },
            ],
         },
      ],
      [
         "image_url data-url (thinking on)",
         {
            thinking: { type: "enabled", reasoning_effort: "low" },
            messages: [
               {
                  role: "user",
                  content: [
                     { type: "text", text: "¿Qué color ves? Una palabra." },
                     { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
                  ],
               },
            ],
         },
      ],
      [
         "file block inline file_data",
         {
            thinking: { type: "disabled" },
            messages: [
               {
                  role: "user",
                  content: [
                     { type: "text", text: "¿Qué color ves?" },
                     { type: "file", file_data: dataUrl, filename: "px.png" },
                  ],
               },
            ],
         },
      ],
      [
         "image_url inside TOOLS turn",
         {
            thinking: { type: "enabled", reasoning_effort: "high" },
            tools: TOOLS,
            messages: [
               {
                  role: "user",
                  content: [
                     { type: "text", text: "Lee la imagen y agenda lo que diga. La imagen es roja." },
                     { type: "image_url", image_url: { url: dataUrl } },
                  ],
               },
            ],
         },
      ],
   ];
   for (const [label, extra] of variants) {
      const r = await call("s4", { model: MODEL, max_tokens: 2000, ...extra });
      const choice = r.res?.choices?.[0];
      console.log(
         `   ${label.padEnd(34)} ${
            r.ok
               ? `OK content=${JSON.stringify(String(choice?.message?.content ?? "").slice(0, 40))} tools=${(choice?.message?.tool_calls ?? []).length}`
               : `ERR ${errLine(r.err)}`
         }`,
      );
   }
}

/** The load-bearing one: the docs say that WHEN `tools` is present, every
 *  prior assistant turn's `reasoning_content` must be echoed back or the API
 *  400s. The bot already echoes it (Kimi needed the same), but that behaviour
 *  is now a hard correctness requirement rather than a gateway quirk — and the
 *  forcing pass (no `tools`) must NOT carry it. */
async function s5_toolRoundTrip() {
   console.log("\n§5 tool round-trip in thinking mode");
   // 5a: WITH reasoning_content echoed back.
   const first: any = await call("s5", {
      model: MODEL,
      max_tokens: 3000,
      tools: TOOLS,
      thinking: { type: "enabled", reasoning_effort: "high" },
      messages: [{ role: "user", content: TASK }],
   });
   if (!first.ok) {
      console.log(`   5a initial call ERR ${errLine(first.err)}`);
      return;
   }
   const msg = first.res.choices[0].message;
   const tc = msg.tool_calls?.[0];
   console.log(
      `   5a initial    OK tool_calls=${(msg.tool_calls ?? []).length} reasoning_chars=${String(msg.reasoning_content ?? "").length} finish=${first.res.choices[0].finish_reason}`,
   );
   if (!tc) return;

   const withReasoning = await call("s5", {
      model: MODEL,
      max_tokens: 2000,
      tools: TOOLS,
      thinking: { type: "enabled", reasoning_effort: "high" },
      messages: [
         { role: "user", content: TASK },
         msg,
         { role: "tool", tool_call_id: tc.id, content: '{"ok":true,"id":"evt_1"}' },
      ],
   });
   console.log(
      `   5b echo reasoning_content back  ${
         withReasoning.ok
            ? `OK content=${JSON.stringify(String(withReasoning.res.choices[0].message.content ?? "").slice(0, 50))}`
            : `ERR ${errLine(withReasoning.err)}`
      }`,
   );

   const withoutReasoning = await call("s5", {
      model: MODEL,
      max_tokens: 2000,
      tools: TOOLS,
      thinking: { type: "enabled", reasoning_effort: "high" },
      messages: [
         { role: "user", content: TASK },
         {
            role: "assistant",
            content: msg.content ?? null,
            tool_calls: msg.tool_calls,
         },
         { role: "tool", tool_call_id: tc.id, content: '{"ok":true,"id":"evt_1"}' },
      ],
   });
   console.log(
      `   5c OMIT reasoning_content       ${
         withoutReasoning.ok
            ? `OK (docs' 400 did NOT fire) content=${JSON.stringify(String(withoutReasoning.res.choices[0].message.content ?? "").slice(0, 40))}`
            : `ERR ${errLine(withoutReasoning.err)}`
      }`,
   );

   // 5d: the forcing pass — history still HAS the reasoning + tool_calls, but the
   // request carries no `tools`. Docs §Multi-turn: reasoning is ignored without
   // tools. Does the tool_calls in history still validate?
   const forcing = await call("s5", {
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "enabled", reasoning_effort: "high" },
      messages: [
         { role: "user", content: TASK },
         msg,
         { role: "tool", tool_call_id: tc.id, content: '{"ok":true,"id":"evt_1"}' },
         { role: "user", content: "Responde AHORA en prosa, sin herramientas." },
      ],
   });
   console.log(
      `   5d forcing pass (no tools)      ${
         forcing.ok
            ? `OK content=${JSON.stringify(String(forcing.res.choices[0].message.content ?? "").slice(0, 50))}`
            : `ERR ${errLine(forcing.err)}`
      }`,
   );

   // 5e: thinking disabled + tool round-trip (the medium/low tiers do this).
   const off: any = await call("s5", {
      model: MODEL,
      max_tokens: 1000,
      tools: TOOLS,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: TASK }],
   });
   console.log(
      `   5e thinking disabled + tools    ${
         off.ok
            ? `OK tool_calls=${(off.res.choices[0].message.tool_calls ?? []).length} finish=${off.res.choices[0].finish_reason}`
            : `ERR ${errLine(off.err)}`
      }`,
   );
}

async function s6_maxTokens() {
   console.log("\n§6 max_tokens headroom (bot currently sends KIMI_MAX_OUTPUT_TOKENS=16384)");
   for (const effort of ["low", "high", "max"] as const) {
      const r = await call("s6", {
         model: MODEL,
         thinking: { type: "enabled", reasoning_effort: effort },
         max_tokens: 64000,
         messages: [{ role: "user", content: "Di exactamente: listo." }],
      });
      console.log(
         `   max_tokens=64000 effort=${effort.padEnd(4)} ${
            r.ok ? `OK out=${outTok(r.res)} finish=${r.res.choices?.[0]?.finish_reason}` : `ERR ${errLine(r.err)}`
         }`,
      );
   }
   const over = await call("s6", {
      model: MODEL,
      max_tokens: 500_000,
      messages: [{ role: "user", content: "hola" }],
   });
   console.log(
      `   max_tokens=500000 (over limit)  ${over.ok ? "OK (!! no cap)" : `ERR ${errLine(over.err)}`}`,
   );
}

async function main() {
   console.log(`PROBE deepseek V4.1 Flash — base=${BASE} model=${MODEL}`);
   await s1_modelAndBaseUrl();
   await s2_effort();
   await s4_vision();
   await s5_toolRoundTrip();
   await s6_maxTokens();
   console.log(`\ndone — ${calls} requests`);
}

void main();
