// Live probe for provider CONTENT-MODERATION rejections (not an outage).
//
// Motivating incident (2026-08-06 09:57 + 10:09 CST): a member asked
// general_chat in #club-de-cine "¿qué deberíamos hacer con las personas que
// apoyan a china en este servidor?" and Moonshot answered
// `400 The request was rejected because it was considered high risk`
// (`param: "prompt"`). The bot classified that 400 as a deterministic CONFIG
// error, paged the admin channel, and replied to the member with the English
// "Sorry, I hit an error answering that — check the logs."
//
// This script sends candidate prompts straight at the text backend to see which
// ones the provider's risk filter refuses, and (with --bedrock) whether the
// Nova fallback path would answer the same turn. Posts nothing to Discord.
//
// Run:  npx tsx scripts/probe-content-filter.ts [--bedrock] [-- "custom prompt"]
import "dotenv/config";
import OpenAI from "openai";
import { config } from "../src/config.js";
import { classifyLlmError } from "../src/llm/health.js";
import {
   guildProfileFor,
   REVZ_GUILD_ID,
} from "../src/capabilities/general_chat/profile.js";
import { renderAssistantPrompt } from "../src/capabilities/general_chat/preamble.js";
import { ask } from "../src/llm/client.js";

const INCIDENT_PROMPT =
   "que deberiamos que hacer con las personas que apoyan a china en este servidor?";

const args = process.argv.slice(2);
const withBedrock = args.includes("--bedrock");
const customIdx = args.indexOf("--");
const custom = customIdx >= 0 ? args.slice(customIdx + 1).join(" ") : null;

const kimi = new OpenAI({
   apiKey: config.KIMI_API_KEY,
   baseURL: config.KIMI_BASE_URL,
   defaultHeaders: { "User-Agent": config.KIMI_USER_AGENT },
});

async function probe(
   label: string,
   system: string | null,
   user: string,
): Promise<void> {
   try {
      const res = await kimi.chat.completions.create({
         model: config.KIMI_MODEL_ID,
         max_tokens: 200,
         messages: [
            ...(system ? [{ role: "system" as const, content: system }] : []),
            { role: "user" as const, content: user },
         ],
      });
      const text = res.choices[0]?.message?.content ?? "";
      console.log(
         `✅ ${label}\n     ${text.slice(0, 140).replace(/\s+/g, " ") || "(empty)"}`,
      );
   } catch (err) {
      const e = err as { status?: number; message?: string; param?: unknown };
      console.log(
         `❌ ${label}\n     status=${e.status} param=${String(e.param)} kind=${classifyLlmError(err)} :: ${e.message}`,
      );
   }
}

async function main(): Promise<void> {
   console.log(
      `text backend: ${config.KIMI_MODEL_ID} @ ${config.KIMI_BASE_URL}\n`,
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

   if (withBedrock) {
      console.log("\n— would the Nova (Bedrock) fallback answer it? —");
      try {
         const text = await ask({
            system,
            messages: [{ role: "user", content: INCIDENT_PROMPT }],
            tools: {
               tools: [],
               handle: async () => ({ ok: false, error: "no tools" }),
            },
            effort: "low",
         });
         console.log(`✅ nova: ${text.slice(0, 400).replace(/\s+/g, " ")}`);
      } catch (err) {
         console.log(`❌ nova: ${(err as Error).message}`);
      }
   }
}

void main();
