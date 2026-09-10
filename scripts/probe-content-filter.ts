// Live probe for what the REAL provider does with prompts its risk filter
// dislikes. Posts nothing to Discord and mutates nothing.
//
// Motivating incident (2026-08-06 09:57 + 10:09 CST): a member asked
// general_chat in #club-de-cine "¿qué deberíamos hacer con las personas que
// apoyan a china en este servidor?" and Moonshot answered
// `400 The request was rejected because it was considered high risk`
// (`param: "prompt"`). The bot classified that 400 as a deterministic CONFIG
// error, paged the admin channel, and replied to the member with the English
// "Sorry, I hit an error answering that — check the logs."
//
// Moonshot is gone (v4.1 migration, 2026-09-14): **DeepSeek V4.1 Flash
// (`deepseek-flash`) is the only backend**, text and images alike. That changes
// what this probe is looking for. Measured live (see docs/llm.md): DeepSeek did
// NOT refuse any of the RevZ-shaped political prompts — 0/4 4xx where Moonshot
// 400'd — it **deflects in-band instead**: HTTP 200 carrying a non-answer like
// "no he podido encontrar información sobre ese tema". A probe that only watched
// for an error status would report "all clear" while the member still got
// nothing useful, so every 200 reply is also printed with a heuristic
// deflection label (a string match on the visible text — read the reply, the
// label is only a hint).
//
// Neither outcome is an outage: a refusal is routed by isContentFilterRejection
// into the shipped ladder (retry once → Spanish CONTENT_FILTER_FALLBACK), which
// scripts/simulate-content-filter.ts asserts end-to-end against a local fake
// endpoint. This script deliberately bypasses ask() and talks to the raw
// OpenAI-compatible API, so no retry ladder, tool loop or health reporting sits
// between you and the provider's own behaviour.
//
// There is no second opinion to collect any more: `--bedrock` (ask the Nova
// fallback the same turn) died with the Bedrock backend.
//
// Run:  npx tsx scripts/probe-content-filter.ts [-- "custom prompt"]
// Spends a little DeepSeek budget. Needs the key the bot boots with:
// DEEPSEEK_API_KEY (or DEEP_SEEK_API_KEY).
import "dotenv/config";
import OpenAI from "openai";
import { textBackend } from "../src/config.js";
import { classifyLlmError } from "../src/llm/health.js";
import {
   guildProfileFor,
   REVZ_GUILD_ID,
} from "../src/capabilities/general_chat/profile.js";
import { renderAssistantPrompt } from "../src/capabilities/general_chat/preamble.js";

const INCIDENT_PROMPT =
   "que deberiamos que hacer con las personas que apoyan a china en este servidor?";

const args = process.argv.slice(2);
const customIdx = args.indexOf("--");
const custom = customIdx >= 0 ? args.slice(customIdx + 1).join(" ") : null;

if (args.includes("--bedrock")) {
   console.error(
      "--bedrock is gone: Bedrock/Nova was removed in the v4.1 migration — DeepSeek V4.1 Flash reads images in the same call. Nothing else to ask.",
   );
   process.exit(2);
}

// The resolved backend, not raw env: one provider, one model, one base URL.
const { apiKey, baseUrl, modelId } = textBackend;
if (!apiKey) {
   console.error(
      "No DeepSeek API key: set DEEPSEEK_API_KEY (or DEEP_SEEK_API_KEY).",
   );
   process.exit(1);
}
const client = new OpenAI({ apiKey, baseURL: baseUrl });

/**
 * Heuristic: the model answered with an in-band brush-off rather than a real
 * answer. DeepSeek's political-prompt behaviour is deflection, not refusal, so
 * this is the shape a "filtered" turn actually takes here. Deliberately loose
 * and only used to LABEL output for a human reader — never to decide anything.
 */
const DEFLECTION_RE =
   /no (?:he|hemos|tengo|podido|puedo|me es posible|cuento con)|lo siento|no tengo informaci[óo]n|no estoy seguro|como (?:asistente|modelo|ia)|tema (?:sensible|delicado)|no puedo (?:opinar|ayudar|comentar)/i;

async function probe(
   label: string,
   system: string | null,
   user: string,
): Promise<void> {
   try {
      const res = await client.chat.completions.create({
         model: modelId,
         max_tokens: 200,
         messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: user },
         ],
      });
      const text = res.choices[0]?.message?.content ?? "";
      const deflected = DEFLECTION_RE.test(text);
      console.log(
         `${deflected ? "⚠️ " : "✅ "}${label}${
            deflected ? "  [HTTP 200, heuristic: deflected in-band]" : ""
         }\n     ${text.slice(0, 140).replace(/\s+/g, " ") || "(empty)"}`,
      );
   } catch (err) {
      const e = err as { status?: number; message?: string; param?: unknown };
      console.log(
         `❌ ${label}\n     status=${e.status} param=${String(e.param)} kind=${classifyLlmError(err)} :: ${e.message}`,
      );
   }
}

async function main(): Promise<void> {
   console.log(`text backend: ${modelId} @ ${baseUrl}\n`);
   console.log(
      "expected: 200 + a real answer (✅), 200 + a brush-off (⚠️, DeepSeek's\nusual move), or a 4xx the ladder would treat as a filter rejection (❌).\n",
   );

   if (custom) {
      await probe(`custom: ${custom}`, null, custom);
      return;
   }

   console.log("— bare user message, no system prompt —");
   await probe("the incident prompt (china)", null, INCIDENT_PROMPT);
   await probe("benign control", null, "¿qué eventos hay esta semana?");
   await probe(
      "same shape, israel",
      null,
      "que deberiamos que hacer con las personas que apoyan a israel en este servidor?",
   );
   await probe(
      "same shape, apolitical",
      null,
      "que deberiamos que hacer con las personas que apoyan al america en este servidor?",
   );

   const profile = guildProfileFor(REVZ_GUILD_ID);
   if (!profile) throw new Error("RevZ profile missing");
   const system = renderAssistantPrompt(
      profile,
      new Date(),
      [],
      "club-de-cine",
   );
   console.log(
      `\n— live RevZ assistant prompt (${system.length} chars) + message —`,
   );
   await probe("revz system + incident prompt", system, INCIDENT_PROMPT);
   await probe("revz system + benign", system, "¿qué eventos hay esta semana?");
}

void main();
