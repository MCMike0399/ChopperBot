/**
 * Effort → thinking mode on the OpenAI-compatible text brain (2026-08-13).
 *
 * Effort does NOT select a model any more: every text turn runs on the single
 * `textBackend.modelId` (V4-Pro measured identical to Flash on the calendar
 * tool battery while being ~48% slower and 3.1× the price). What it selects is
 * DeepSeek's `thinking` switch — the one knob that model actually honours:
 *
 *   high   → thinking enabled  (reason before acting; the multi-turn tool loops)
 *   medium → thinking disabled (~2.2× fewer billed output tokens, ~30% faster)
 *   low    → never reaches here; ask() routes it to Nova, the vision backend
 *
 * The sibling `reasoning_effort` is deliberately NOT sent: measured on
 * v4-flash it is silently ignored (an invalid "banana" value returns 200, and
 * `low` produced more reasoning than `high`). A knob that never errors and
 * never works is the worst kind, so these tests also pin that we don't send it.
 *
 * Both failure directions are silent in production — thinking left on
 * everywhere quietly doubles the output-token bill on the surfaces carrying
 * all the volume; thinking off on a tool loop quietly degrades the turns that
 * write real state. Neither shows up as an error.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// Select the DeepSeek backend BEFORE the static imports run (config validates
// and freezes `textBackend` at import time). Without this the file inherits the
// host .env / vitest.setup defaults, resolves to a provider with no thinking
// switch, and the two assertions that matter silently skip — which is exactly
// what happened on the first version of this file.
vi.hoisted(() => {
   process.env.LLM_TEXT_BACKEND = "deepseek";
   process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
});

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));

import { ask } from "../client.js";
import { textBackend } from "../../config.js";
import { composeToolSources } from "../../tools/source.js";

const NO_TOOLS = composeToolSources([]);

function reply(content: string) {
   return {
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
   };
}

function baseInput() {
   return {
      system: "system",
      messages: [{ role: "user" as const, content: "hola" }],
      tools: NO_TOOLS,
   };
}

/** The request body of the Nth (0-based) upstream call. */
function bodyOf(n: number): Record<string, unknown> {
   return createMock.mock.calls[n]?.[0] ?? {};
}

beforeEach(() => {
   createMock.mockReset();
});

describe("effort tier selects the thinking mode, not a model", () => {
   // Guard the guard: if this ever resolves false the switch assertions below
   // would pass vacuously, so fail loudly instead of skipping.
   test("the test env really is on a thinking-capable provider", () => {
      expect(textBackend.supportsThinkingSwitch).toBe(true);
      expect(textBackend.modelId).toBe("deepseek-v4-flash");
   });

   test("every tier uses the SAME model id", async () => {
      createMock
         .mockResolvedValueOnce(reply("a"))
         .mockResolvedValueOnce(reply("b"));
      await ask({ ...baseInput(), effort: "high" });
      await ask({ ...baseInput(), effort: "medium" });
      expect(bodyOf(0).model).toBe(textBackend.modelId);
      expect(bodyOf(1).model).toBe(textBackend.modelId);
   });

   test("effort 'high' enables thinking", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "high" });
      expect(bodyOf(0).thinking).toEqual({ type: "enabled" });
   });

   test("effort 'medium' disables thinking", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "medium" });
      expect(bodyOf(0).thinking).toEqual({ type: "disabled" });
   });

   test("reasoning_effort is never sent — it is silently ignored upstream", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "high" });
      expect(bodyOf(0)).not.toHaveProperty("reasoning_effort");
   });

   test("the mode holds across a retry, not just the first request", async () => {
      // The empty-content retry re-sends the same conversation; a retry that
      // rebuilt the request without the mode would silently change behavior
      // mid-turn relative to the attempt it is rescuing.
      createMock
         .mockResolvedValueOnce(reply(""))
         .mockResolvedValueOnce(reply("ya"));
      await ask({ ...baseInput(), effort: "medium" });
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(1).model).toBe(textBackend.modelId);
      expect(bodyOf(1).thinking).toEqual({ type: "disabled" });
   });

   // The other direction, on a fresh module graph: Moonshot 400s on unexpected
   // params, so a `thinking` key leaking onto a kimi deployment would break
   // EVERY text turn. Worth a real request-shape assertion, not just the config
   // flag, because the flag and the send site can drift apart.
   test("a kimi deployment never receives the thinking key", async () => {
      vi.resetModules();
      process.env.LLM_TEXT_BACKEND = "kimi";
      process.env.KIMI_API_KEY = "sk-kimi-test";
      try {
         const { ask: kimiAsk } = await import("../client.js");
         createMock.mockResolvedValueOnce(reply("ok"));
         await kimiAsk({ ...baseInput(), effort: "medium" });
         expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("thinking");
      } finally {
         process.env.LLM_TEXT_BACKEND = "deepseek";
      }
   });
});
