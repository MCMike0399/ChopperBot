// End-to-end exercise of the content-filter recovery chain in ask() with a
// text backend that ALWAYS refuses.
//
// The 2026-08-06 rejection is probabilistic, so it can't be reproduced on
// demand against the real gateway (see scripts/probe-content-filter.ts — the
// prompt that broke now answers). This stands a local HTTP server in for the
// Kimi endpoint, returning the verbatim Moonshot 400 body, and points
// KIMI_BASE_URL at it. Everything downstream is the real shipped path: the real
// askKimi loop, the real retry decision, and a REAL Bedrock/Nova Lite call for
// the fallback leg.
//
// Expected: 2 upstream hits (initial + one retry), then a Spanish answer from
// Nova. Spends a few Nova tokens. Posts nothing to Discord.
//
// Run:  npx tsx scripts/simulate-content-filter.ts
import { createServer } from "node:http";

const REJECTION = {
   error: {
      message: "The request was rejected because it was considered high risk",
      type: "invalid_request_error",
      param: "prompt",
      code: 400,
   },
};

let upstreamHits = 0;

const server = createServer((req, res) => {
   upstreamHits += 1;
   console.log(
      `  ↳ upstream hit #${upstreamHits}: ${req.method} ${req.url} → 400 high risk`,
   );
   res.writeHead(400, { "content-type": "application/json" });
   res.end(JSON.stringify(REJECTION));
});

async function main(): Promise<void> {
   await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
   const port = (server.address() as { port: number }).port;
   // Set BEFORE dotenv/config runs (override:false → process.env wins) and
   // before src/config.ts is imported and validated.
   process.env.KIMI_BASE_URL = `http://127.0.0.1:${port}/v1`;

   await import("dotenv/config");
   const { ask } = await import("../src/llm/client.js");
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

   console.log(
      `fake text backend on ${process.env.KIMI_BASE_URL} (always 400 high risk)\n`,
   );
   const reply = await ask({
      system,
      messages: [
         {
            role: "user",
            content:
               "que deberiamos que hacer con las personas que apoyan a china en este servidor?",
         },
      ],
      tools: {
         tools: [],
         handle: async () => ({ status: "error", payload: null }),
      },
   });

   console.log(
      `\nupstream hits: ${upstreamHits} (expected 2 — initial + one retry)`,
   );
   console.log(`reply:\n  ${reply.slice(0, 500).replace(/\n/g, "\n  ")}`);

   const snap = llmHealth.snapshot();
   console.log(
      "\nllm health after the rejections (must NOT look like an outage):",
   );
   console.log(
      `  degraded=${snap.degraded} consecutive_failures=${snap.consecutive_failures} content_filter_rejections=${snap.content_filter_rejections}`,
   );

   const ok =
      upstreamHits === 2 &&
      snap.degraded === false &&
      snap.consecutive_failures === 0 &&
      snap.content_filter_rejections === 2 &&
      reply.length > 40 &&
      !/filtro del proveedor/i.test(reply);
   console.log(
      ok
         ? "\n✅ recovery chain behaved as designed"
         : "\n❌ unexpected outcome",
   );
   server.close();
   process.exit(ok ? 0 : 1);
}

void main();
