/**
 * Wire-shape contract tests. Pin down the exact JSON we send to DeepSeek so
 * future contributors don't silently regress the integration. ONE provider
 * since the 2026-09-14 v4.1 migration: the OpenAI chat-completions shape, with
 * images inlined as `image_url` parts. Mocks the SDK; no network.
 *
 * The assertions about what we do NOT send matter as much as the ones about what
 * we do: DeepSeek's thinking mode IGNORES `temperature` and has DEPRECATED
 * `presence_penalty`/`frequency_penalty`, and clamps `top_p` to >= 0.95 — so
 * sampling params would be noise that reads like tuning.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));

const { ask } = await import("../client.js");
import { config, textBackend } from "../../config.js";
import type { ComposedTools, ToolSpec } from "../../tools/source.js";
import { ImageAttachable } from "../../attachments/attachable.js";

const SAMPLE_SPEC: ToolSpec = {
   name: "sample_tool",
   description: "A sample tool used in contract tests.",
   inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
   },
};

function toolsWithSample(): ComposedTools {
   return {
      tools: [SAMPLE_SPEC],
      handle: async () => ({ status: "success", payload: { hits: 0 } }),
   };
}

function end(text: string) {
   return {
      choices: [
         {
            message: { role: "assistant", content: text },
            finish_reason: "stop",
         },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
   };
}

function toolCallResponse(
   calls: Array<{ id: string; name: string; input: unknown }>,
) {
   return {
      choices: [
         {
            message: {
               role: "assistant",
               content: null,
               tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: {
                     name: c.name,
                     arguments: JSON.stringify(c.input),
                  },
               })),
            },
            finish_reason: "tool_calls",
         },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
   };
}

function reqAt(i: number): Record<string, unknown> {
   return createMock.mock.calls[i][0] as Record<string, unknown>;
}

const img = () =>
   new ImageAttachable("a.png", "image/png", new Uint8Array([1, 2, 3]), "png");

beforeEach(() => createMock.mockReset());

describe("DeepSeek wire contract", () => {
   test("system prompt is the leading role:system message; user turn follows", async () => {
      createMock.mockResolvedValueOnce(end("hi"));
      await ask({
         system: "YOU ARE A BOT",
         messages: [{ role: "user", content: "q" }],
         tools: toolsWithSample(),
      });
      const msgs = reqAt(0).messages as Array<{
         role: string;
         content: unknown;
      }>;
      expect(msgs[0]).toEqual({ role: "system", content: "YOU ARE A BOT" });
      expect(msgs[1]).toEqual({ role: "user", content: "q" });
   });

   test("tools serialize as { type:function, function:{ name, description, parameters } }", async () => {
      createMock.mockResolvedValueOnce(end("hi"));
      await ask({
         system: "s",
         messages: [{ role: "user", content: "q" }],
         tools: toolsWithSample(),
      });
      const tools = reqAt(0).tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
         type: "function",
         function: {
            name: "sample_tool",
            description: "A sample tool used in contract tests.",
            parameters: SAMPLE_SPEC.inputSchema,
         },
      });
   });

   test("model and max_tokens forwarded; no sampling params set", async () => {
      createMock.mockResolvedValueOnce(end("hi"));
      await ask({
         system: "s",
         messages: [{ role: "user", content: "q" }],
         tools: toolsWithSample(),
      });
      const req = reqAt(0);
      expect(req.model).toBe(config.DEEPSEEK_MODEL_ID);
      // Reasoning tokens count against max_tokens, so the generous dedicated
      // budget is the difference between a complete answer and finish_reason
      // `length` with empty content.
      expect(req.max_tokens).toBe(config.DEEPSEEK_MAX_OUTPUT_TOKENS);
      expect(req.temperature).toBeUndefined();
      expect(req.top_p).toBeUndefined();
      expect(req.frequency_penalty).toBeUndefined();
      expect(req.presence_penalty).toBeUndefined();
   });

   test("tool result follow-up: one role:tool message per call, in order, JSON-encoded payload", async () => {
      createMock
         .mockResolvedValueOnce(
            toolCallResponse([
               { id: "aaa", name: "sample_tool", input: { query: "one" } },
               { id: "bbb", name: "sample_tool", input: { query: "two" } },
            ]),
         )
         .mockResolvedValueOnce(end("done"));
      await ask({
         system: "s",
         messages: [{ role: "user", content: "q" }],
         tools: {
            tools: [SAMPLE_SPEC],
            handle: async (_n, input) => ({
               status: "success",
               payload: { echoed: input },
            }),
         },
      });
      const followup = reqAt(1).messages as Array<{
         role: string;
         tool_call_id?: string;
         content: string;
      }>;
      const results = followup.filter((m) => m.role === "tool");
      expect(results).toHaveLength(2);
      expect(results[0].tool_call_id).toBe("aaa");
      expect(results[1].tool_call_id).toBe("bbb");
      const first = JSON.parse(results[0].content) as {
         echoed: { query: string };
      };
      expect(first.echoed.query).toBe("one");
   });

   test("forcing pass omits `tools` when the iteration cap hits while still calling tools", async () => {
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
         createMock.mockResolvedValueOnce(
            toolCallResponse([
               { id: `t${i}`, name: "sample_tool", input: { query: `q${i}` } },
            ]),
         );
      }
      createMock.mockResolvedValueOnce(end("forced"));
      await ask({
         system: "s",
         messages: [{ role: "user", content: "go" }],
         tools: {
            tools: [SAMPLE_SPEC],
            handle: async () => ({ status: "success", payload: { ok: true } }),
         },
      });
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++)
         expect(reqAt(i).tools).toBeDefined();
      expect(reqAt(config.MAX_TOOL_ITERATIONS).tools).toBeUndefined();
   });
});

describe("DeepSeek image wire contract", () => {
   test("an attachment serializes as an OpenAI image_url data URL beside the text part", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      await ask({
         system: "YOU ARE A BOT",
         messages: [
            { role: "user", content: "see this", attachments: [img()] },
         ],
         tools: toolsWithSample(),
         effort: "low",
      });
      const msgs = reqAt(0).messages as Array<{
         role: string;
         content: unknown;
      }>;
      expect(msgs[0]).toEqual({ role: "system", content: "YOU ARE A BOT" });
      const parts = msgs[1].content as Array<Record<string, unknown>>;
      expect(parts[0]).toEqual({ type: "text", text: "see this" });
      expect(parts[1]).toEqual({
         type: "image_url",
         image_url: { url: "data:image/png;base64,AQID" },
      });
   });

   test("the same model serves text and images — there is no second model id", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      await ask({
         system: "s",
         messages: [{ role: "user", content: "q", attachments: [img()] }],
         tools: toolsWithSample(),
         effort: "low",
      });
      expect(reqAt(0).model).toBe(textBackend.modelId);
   });
});
