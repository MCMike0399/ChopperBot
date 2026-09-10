// End-to-end exercise of the content-filter recovery ladder in ask() against a
// provider that ALWAYS refuses.
//
// The 2026-08-06 rejection is probabilistic, so it can't be reproduced on demand
// against the real gateway — and DeepSeek does not even 4xx those prompts, it
// deflects in-band with HTTP 200 (see scripts/probe-content-filter.ts). This
// stands a local HTTP server in for the DeepSeek chat-completions endpoint,
// returning the verbatim Moonshot-style 400 body (`isContentFilterRejection`
// keys off exactly that "considered high risk" shape), and points
// DEEPSEEK_BASE_URL at it. Everything downstream is the real shipped path: the
// real askDeepSeek loop, the real retry decision, and the real llmHealth
// watchdog.
//
// The ladder today has exactly TWO legs — retry once, then the Spanish
// CONTENT_FILTER_FALLBACK. The old third leg (fail the turn over to Amazon Nova)
// was deleted with the Bedrock backend on 2026-09-14. This script asserts it is
// gone by requiring that Spanish message after exactly 2 upstream hits.
//
// Expected: 2 upstream hits (initial + one retry), then a Spanish answer, with
// llmHealth NOT degraded. It also proves that a 401 still propagates to the
// caller and that a rejection arriving AFTER a tool ran is never retried.
//
// Talks only to 127.0.0.1: no live API, no DeepSeek budget, no Discord. Needs no
// credentials. Posts nothing.
//
// Run:  npx tsx scripts/simulate-content-filter.ts
import { createServer } from "node:http";

/** The verbatim Moonshot body that started all this — still the shape
 * isContentFilterRejection recognises, and what a gateway moderation refusal
 * looks like. */
const HIGH_RISK_400 = {
   error: {
      message: "The request was rejected because it was considered high risk",
      type: "invalid_request_error",
      param: "prompt",
      code: 400,
   },
};

/** A deterministic DeepSeek-shaped auth failure: must NOT be recovered from. */
const AUTH_401 = {
   error: {
      message: "Authentication Fails, Your api key is invalid",
      type: "authentication_error",
      param: null,
      code: "invalid_request_error",
   },
};

type Mode = "reject" | "tool-then-reject" | "auth";

/** Scene 3 needs the model to ask for a tool so the loop executes one BEFORE
 * the rejection lands (that is what makes a retry unsafe). */
const TOOL_CALL_BODY = {
   id: "chatcmpl-fake-tool",
   object: "chat.completion",
   created: 0,
   model: "deepseek-flash",
   choices: [
      {
         index: 0,
         finish_reason: "tool_calls",
         message: {
            role: "assistant",
            content: null,
            tool_calls: [
               {
                  id: "call_fake_1",
                  type: "function",
                  function: { name: "echo", arguments: '{"text":"hola"}' },
               },
            ],
         },
      },
   ],
};

let mode: Mode = "reject";
let upstreamHits = 0;
let sceneHits = 0;

const server = createServer((req, res) => {
   upstreamHits += 1;
   sceneHits += 1;
   if (mode === "tool-then-reject" && sceneHits === 1) {
      console.log(
         `  ↳ upstream hit #${upstreamHits}: ${req.method} ${req.url} → 200 tool_call (echo)`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(TOOL_CALL_BODY));
      return;
   }
   if (mode === "auth") {
      console.log(
         `  ↳ upstream hit #${upstreamHits}: ${req.method} ${req.url} → 401 invalid api key`,
      );
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify(AUTH_401));
      return;
   }
   console.log(
      `  ↳ upstream hit #${upstreamHits}: ${req.method} ${req.url} → 400 high risk`,
   );
   res.writeHead(400, { "content-type": "application/json" });
   res.end(JSON.stringify(HIGH_RISK_400));
});

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
   console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
   if (!ok) failures++;
}

async function main(): Promise<void> {
   await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
   const port = (server.address() as { port: number }).port;
   // Set BEFORE dotenv/config runs (override:false → process.env wins) and
   // before src/config.ts is imported and validated. This is the whole trick:
   // if this still pointed at the real endpoint the script would spend real
   // money on real refusals.
   process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/v1`;
   // The fake endpoint ignores the key, but src/config.ts REQUIRES a DeepSeek
   // key at import (it is the only backend now). Supply a placeholder when the
   // machine has no real one, so this simulation runs offline and free.
   if (!process.env.DEEPSEEK_API_KEY && !process.env.DEEP_SEEK_API_KEY)
      process.env.DEEPSEEK_API_KEY = "simulated-not-a-real-key";

   await import("dotenv/config");
   const { ask, CONTENT_FILTER_FALLBACK } =
      await import("../src/llm/client.js");
   const { llmHealth } = await import("../src/llm/health.js");
   const { guildProfileFor, REVZ_GUILD_ID } =
      await import("../src/capabilities/general_chat/profile.js");
   const { renderAssistantPrompt } =
      await import("../src/capabilities/general_chat/preamble.js");

   const profile = guildProfileFor(REVZ_GUILD_ID);
   if (!profile) throw new Error("RevZ profile missing");
   const system = renderAssistantPrompt(
      profile,
      new Date(),
      [],
      "club-de-cine",
   );
   const incident =
      "que deberiamos que hacer con las personas que apoyan a china en este servidor?";
   const noTools = {
      tools: [],
      handle: async () => ({ status: "error" as const, payload: null }),
   };

   // ── Scene 1: the ladder — retry once, then the Spanish fallback ───────────
   console.log(
      `\n── Escena 1: backend siempre-400 en ${process.env.DEEPSEEK_BASE_URL} ──`,
   );
   const reply = await ask({
      system,
      messages: [{ role: "user", content: incident }],
      tools: noTools,
   });
   console.log(`\nreply:\n  ${reply.replace(/\n/g, "\n  ")}`);
   check(
      sceneHits === 2,
      "2 hits upstream (inicial + un reintento)",
      `hits=${sceneHits}`,
   );
   check(
      reply === CONTENT_FILTER_FALLBACK,
      "respondió el mensaje español de CONTENT_FILTER_FALLBACK",
      reply === CONTENT_FILTER_FALLBACK ? "" : "no es el fallback esperado",
   );

   const snap = llmHealth.snapshot();
   console.log(
      `\nllm health (must NOT look like an outage):\n  degraded=${snap.degraded} consecutive_failures=${snap.consecutive_failures} content_filter_rejections=${snap.content_filter_rejections}`,
   );
   check(!snap.degraded, "health NO quedó degradado");
   check(
      snap.consecutive_failures === 0,
      "0 fallos consecutivos contados",
      `consecutive_failures=${snap.consecutive_failures}`,
   );
   check(
      snap.content_filter_rejections === 2,
      "los 2 rechazos se contaron aparte",
      `content_filter_rejections=${snap.content_filter_rejections}`,
   );

   // ── Scene 2: a 401 is still a real error and must propagate ──────────────
   console.log("\n── Escena 2: 401 (api key inválida) — no es un filtro ──");
   mode = "auth";
   sceneHits = 0;
   let propagated: unknown = null;
   try {
      await ask({
         system,
         messages: [{ role: "user", content: incident }],
         tools: noTools,
      });
   } catch (err) {
      propagated = err;
   }
   if (propagated === null) {
      check(false, "ask() NO lanzó el 401 — debió propagarlo, no responderlo");
   } else {
      const status = (propagated as { status?: number }).status;
      check(true, "ask() propagó el error", `status=${status}`);
      check(status === 401, "el error conserva el status 401");
      check(
         sceneHits === 1,
         "no reintentó un 401 determinista",
         `hits=${sceneHits}`,
      );
   }

   // ── Scene 3: a rejection AFTER a tool ran must not be retried ────────────
   console.log(
      "\n── Escena 3: el rechazo llega DESPUÉS de ejecutar una herramienta ──",
   );
   mode = "tool-then-reject";
   sceneHits = 0;
   let toolRan = false;
   const replyAfterTool = await ask({
      system,
      messages: [{ role: "user", content: incident }],
      tools: {
         tools: [],
         handle: async () => {
            toolRan = true;
            return { status: "success", payload: { echoed: "hola" } };
         },
      },
   });
   check(toolRan, "la herramienta se ejecutó antes del rechazo");
   check(
      sceneHits === 2,
      "2 hits: tool_call + rechazo, SIN reintento",
      `hits=${sceneHits}`,
   );
   check(
      replyAfterTool === CONTENT_FILTER_FALLBACK,
      "respondió el fallback en vez de reintentar (no duplica el efecto)",
   );

   const final = llmHealth.snapshot();
   console.log(
      `\nfinal health: degraded=${final.degraded} consecutive_failures=${final.consecutive_failures} content_filter_rejections=${final.content_filter_rejections}`,
   );
   console.log(
      "  (scene 2's 401 armed a deterministic alert — degraded=true at that moment; scene 3's\n" +
         "   successful tool_call response then cleared it through the normal recovery notice)\n",
   );

   console.log(
      failures === 0
         ? "✅ recovery ladder behaved as designed"
         : `❌ ${failures} check(s) failed`,
   );
   server.close();
   process.exit(failures === 0 ? 0 : 1);
}

void main();
