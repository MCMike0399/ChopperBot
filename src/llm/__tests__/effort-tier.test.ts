/**
 * Effort → thinking mode + `reasoning_effort` on DeepSeek V4.1 Flash
 * (v4.1 migration, 2026-09-14).
 *
 * Effort does NOT select a model: every turn runs on the single
 * `textBackend.modelId`. The old three-tier scheme (low = Nova vision,
 * medium = thinking off, high = thinking on) is replaced by DeepSeek's own
 * documented scale:
 *
 *   low  → thinking DISABLED                       (conversational / single-shot)
 *   high → thinking enabled, reasoning_effort high (the tool-loop capabilities)
 *   max  → thinking enabled, reasoning_effort max  (workshop only)
 *
 * WHY BOTH KNOBS ARE PINNED — the two halves have very different evidence:
 *
 *   • `thinking.type` is LOAD-BEARING and reliable. Probed on v4-flash
 *     (2026-08-13) and again on v4.1 Flash (2026-09-14): disabled ⇒ 0 reasoning
 *     tokens, enabled ⇒ roughly 2× the billed output. Thinking left on
 *     everywhere quietly doubles the bill on the surfaces that carry all the
 *     volume; thinking off on a tool loop quietly degrades the turns that write
 *     real state. Neither shows up as an error, which is why they are asserted.
 *
 *   • `reasoning_effort` is documented but measured INERT on this model.
 *     `scripts/probe-deepseek-v41-effort.ts`, 6 fixed puzzles × 6 reps per tier:
 *     median reasoning tokens 257 (low) / 244 (high) / 186 (max) — overlapping,
 *     with `max` lowest — and the control value "banana" returned HTTP 200
 *     instead of erroring. We send it anyway: it is the documented API, it costs
 *     nothing, and it becomes correct the day DeepSeek wires it up. These tests
 *     pin that we send the DOCUMENTED shape, not that the model obeys it.
 *
 * `'medium'` is pinned as a legacy alias for `'high'`, because that is exactly
 * what it meant on the old backend and an un-migrated declaration must not
 * silently lose thinking.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));

import { ask, normalizeEffort } from "../client.js";
import { config, textBackend } from "../../config.js";

const NO_TOOLS = {
   tools: [],
   handle: async () => ({ status: "success" as const, payload: null }),
};

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

describe("effort tier selects a thinking mode, not a model", () => {
   test("the resolved backend is the thinking-capable DeepSeek one", () => {
      expect(textBackend.provider).toBe("deepseek");
      expect(textBackend.supportsThinkingSwitch).toBe(true);
      expect(textBackend.modelId).toBe("deepseek-flash");
   });

   test("every tier uses the SAME model id", async () => {
      createMock
         .mockResolvedValueOnce(reply("a"))
         .mockResolvedValueOnce(reply("b"))
         .mockResolvedValueOnce(reply("c"));
      await ask({ ...baseInput(), effort: "low" });
      await ask({ ...baseInput(), effort: "high" });
      await ask({ ...baseInput(), effort: "max" });
      expect(bodyOf(0).model).toBe(textBackend.modelId);
      expect(bodyOf(1).model).toBe(textBackend.modelId);
      expect(bodyOf(2).model).toBe(textBackend.modelId);
   });

   test("effort 'low' disables thinking (and sends no reasoning_effort)", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "low" });
      expect(bodyOf(0).thinking).toEqual({ type: "disabled" });
   });

   test("effort 'high' enables thinking at high", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "high" });
      expect(bodyOf(0).thinking).toEqual({
         type: "enabled",
         reasoning_effort: "high",
      });
   });

   test("effort 'max' enables thinking at max", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "max" });
      expect(bodyOf(0).thinking).toEqual({
         type: "enabled",
         reasoning_effort: "max",
      });
   });

   test("an omitted tier defaults to high — thinking ON", async () => {
      // The conservative direction: a capability that forgot to declare a tier
      // must not silently lose the reasoning it used to have.
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask(baseInput());
      expect(bodyOf(0).thinking).toEqual({
         type: "enabled",
         reasoning_effort: "high",
      });
   });

   test("legacy 'medium' is honoured as 'high', not as thinking-off", async () => {
      createMock.mockResolvedValueOnce(reply("ok"));
      await ask({ ...baseInput(), effort: "medium" });
      expect(bodyOf(0).thinking).toEqual({
         type: "enabled",
         reasoning_effort: "high",
      });
   });

   test("normalizeEffort maps the legacy spelling and the default", () => {
      expect(normalizeEffort("medium")).toBe("high");
      expect(normalizeEffort(undefined)).toBe("high");
      expect(normalizeEffort("low")).toBe("low");
      expect(normalizeEffort("max")).toBe("max");
   });

   test("the mode holds across a retry, not just the first request", async () => {
      // The empty-content retry re-sends the same conversation; a retry that
      // rebuilt the request without the mode would silently change behavior
      // mid-turn relative to the attempt it is rescuing.
      createMock
         .mockResolvedValueOnce(reply(""))
         .mockResolvedValueOnce(reply("ya"));
      await ask({ ...baseInput(), effort: "low" });
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(1).model).toBe(textBackend.modelId);
      expect(bodyOf(1).thinking).toEqual({ type: "disabled" });
   });

   test("empty length-cap on high disables thinking for the retry", async () => {
      // Live 2026-09-02 workshop: thinking-on burned 3×16384 output tokens with
      // finish_reason `length` and empty content. The retry must flip the switch
      // off or it just empties the budget again.
      createMock
         .mockResolvedValueOnce({
            choices: [{ finish_reason: "length", message: { content: "" } }],
            usage: { prompt_tokens: 10, completion_tokens: 16384 },
         })
         .mockResolvedValueOnce(reply("ya"));
      await ask({ ...baseInput(), effort: "high" });
      expect(bodyOf(0).thinking).toEqual({
         type: "enabled",
         reasoning_effort: "high",
      });
      expect(bodyOf(1).thinking).toEqual({ type: "disabled" });
   });

   test("the forcing pass keeps the turn's tier", async () => {
      // The rescue pass must not silently drop the reasoning budget relative to
      // the turn it is rescuing.
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
         createMock.mockResolvedValueOnce({
            choices: [
               {
                  finish_reason: "tool_calls",
                  message: {
                     content: null,
                     tool_calls: [
                        {
                           id: `t${i}`,
                           type: "function",
                           function: { name: "noop", arguments: "{}" },
                        },
                     ],
                  },
               },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
         });
      }
      createMock.mockResolvedValueOnce(reply("listo"));
      await ask({
         ...baseInput(),
         tools: {
            tools: [
               {
                  name: "noop",
                  description: "noop",
                  inputSchema: { type: "object", properties: {} },
               },
            ],
            handle: async () => ({ status: "success", payload: null }),
         },
         effort: "max",
      });
      const forcing = bodyOf(config.MAX_TOOL_ITERATIONS);
      expect(forcing.tools).toBeUndefined();
      expect(forcing.thinking).toEqual({
         type: "enabled",
         reasoning_effort: "max",
      });
   });
});
