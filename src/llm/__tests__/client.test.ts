/**
 * ask() — the agent loop. ONE backend, ONE loop (v4.1 migration, 2026-09-14).
 *
 * Before this file was rewritten there were two loops side by side: the
 * OpenAI-compatible one (Kimi/DeepSeek) and a Bedrock Converse one that served
 * the vision path on Amazon Nova Lite. DeepSeek V4.1 Flash is natively
 * multimodal, so the Converse loop, the two-stage "Nova transcribes, the text
 * brain acts" split and the whole provider-selection branch are gone. What is
 * left is one loop that takes images and text in the same request — which is
 * what most of these tests now pin, because that is the new failure surface.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));

const { ask } = await import("../client.js");
import { config } from "../../config.js";
import type { ComposedTools } from "../../tools/source.js";
import { ImageAttachable } from "../../attachments/attachable.js";

function fakeTools(
   handle?: (
      n: string,
      i: unknown,
   ) => Promise<{ status: "success" | "error"; payload: unknown }>,
): ComposedTools {
   return {
      tools: [],
      handle: vi.fn(
         handle ?? (async () => ({ status: "success", payload: { ok: true } })),
      ),
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
      usage: { prompt_tokens: 10, completion_tokens: 2 },
   };
}

function toolCalls(
   calls: Array<{ id: string; name?: string; input: unknown }>,
   opts: { reasoning?: string } = {},
) {
   return {
      choices: [
         {
            message: {
               role: "assistant",
               content: null,
               ...(opts.reasoning ? { reasoning_content: opts.reasoning } : {}),
               tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: {
                     ...(c.name ? { name: c.name } : {}),
                     arguments: JSON.stringify(c.input),
                  },
               })),
            },
            finish_reason: "tool_calls",
         },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
   };
}

/** The request object for the i-th create() call. */
function reqAt(i: number): {
   model: string;
   messages: Array<{
      role: string;
      content: unknown;
      tool_call_id?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
   }>;
   tools?: unknown[];
   max_tokens?: number;
   thinking?: unknown;
} {
   return createMock.mock.calls[i][0] as never;
}

/** role:'tool' messages in the i-th request. */
function toolMsgs(i: number): Array<{ tool_call_id: string; content: string }> {
   return reqAt(i).messages.filter((m) => m.role === "tool") as never;
}

const img = (bytes = [1, 2, 3]) =>
   new ImageAttachable("x.png", "image/png", new Uint8Array(bytes), "png");

beforeEach(() => {
   createMock.mockReset();
});

describe("ask — the agent loop", () => {
   test("returns text on a single end-of-turn response", async () => {
      createMock.mockResolvedValueOnce(end("hola"));
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "hi" }],
         tools,
      });
      expect(out).toBe("hola");
      expect(tools.handle).not.toHaveBeenCalled();
      expect(createMock).toHaveBeenCalledTimes(1);
   });

   test("runs a tool call and continues to a final response", async () => {
      createMock
         .mockResolvedValueOnce(
            toolCalls([
               { id: "t1", name: "search_knowledge", input: { query: "spei" } },
            ]),
         )
         .mockResolvedValueOnce(end("final answer"));
      const tools = fakeTools(async (name, input) => {
         expect(name).toBe("search_knowledge");
         expect(input).toEqual({ query: "spei" });
         return { status: "success", payload: { results: [] } };
      });
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "tell me about spei" }],
         tools,
      });
      expect(out).toBe("final answer");
      expect(tools.handle).toHaveBeenCalledOnce();
      expect(createMock).toHaveBeenCalledTimes(2);
   });

   test("runs multiple tool calls in one turn (one tool message each, in order)", async () => {
      createMock
         .mockResolvedValueOnce(
            toolCalls([
               { id: "t1", name: "search_knowledge", input: { query: "a" } },
               { id: "t2", name: "search_knowledge", input: { query: "b" } },
            ]),
         )
         .mockResolvedValueOnce(end("done"));
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "go" }],
         tools,
      });
      expect(out).toBe("done");
      expect(tools.handle).toHaveBeenCalledTimes(2);
      expect(toolMsgs(1).map((m) => m.tool_call_id)).toEqual(["t1", "t2"]);
   });

   test("hits MAX_TOOL_ITERATIONS, then forces a final answer without tools", async () => {
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
         createMock.mockResolvedValueOnce(
            toolCalls([
               {
                  id: `t${i}`,
                  name: "search_knowledge",
                  input: { query: `q${i}` },
               },
            ]),
         );
      }
      createMock.mockResolvedValueOnce(
         end("forced synthesis based on partial context"),
      );
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "loop" }],
         tools,
      });
      expect(out).toBe("forced synthesis based on partial context");
      expect(createMock).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS + 1);
      // The forcing pass (last call) must omit `tools`.
      expect(reqAt(config.MAX_TOOL_ITERATIONS).tools).toBeUndefined();
   });

   test("per-turn cache: identical (tool, input) pairs hit the cache on the second call", async () => {
      createMock
         .mockResolvedValueOnce(
            toolCalls([
               { id: "a", name: "search_knowledge", input: { query: "same" } },
            ]),
         )
         .mockResolvedValueOnce(
            toolCalls([
               { id: "b", name: "search_knowledge", input: { query: "same" } },
            ]),
         )
         .mockResolvedValueOnce(end("done"));
      const handle = vi
         .fn()
         .mockResolvedValue({ status: "success", payload: { ok: 1 } });
      const tools = { tools: [], handle } satisfies ComposedTools;
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "cache me" }],
         tools,
      });
      expect(out).toBe("done");
      expect(handle).toHaveBeenCalledTimes(1);
   });

   test("a malformed tool_call (missing name) yields an error tool message, handler not called", async () => {
      createMock
         .mockResolvedValueOnce(toolCalls([{ id: "bad", input: {} }])) // no name
         .mockResolvedValueOnce(end("recovered"));
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "q" }],
         tools,
      });
      expect(out).toBe("recovered");
      expect(tools.handle).not.toHaveBeenCalled();
      const msgs = toolMsgs(1);
      expect(msgs[0].tool_call_id).toBe("bad");
      expect(msgs[0].content).toContain("Malformed tool_call");
   });

   test("text-only turn sends content as a plain string (no image parts)", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "hi", attachments: [] }],
         tools,
      });
      expect(out).toBe("ok");
      // system is messages[0]; the user turn is messages[1] with a string body.
      expect(reqAt(0).messages[1]).toEqual({ role: "user", content: "hi" });
   });

   test("reasoning_content is echoed back on the assistant turn", async () => {
      // DeepSeek's docs REQUIRE this whenever the request carries `tools`
      // ("If your code does not correctly pass back reasoning_content, the API
      // will return a 400 error"). Probed 2026-09-14: omitting it happened to
      // still 200, which is exactly why this needs a test rather than trust.
      createMock
         .mockResolvedValueOnce(
            toolCalls([{ id: "t1", name: "search_knowledge", input: {} }], {
               reasoning: "necesito buscar spei",
            }),
         )
         .mockResolvedValueOnce(end("listo"));
      await ask({
         system: "p",
         messages: [{ role: "user", content: "q" }],
         tools: fakeTools(),
      });
      const assistant = reqAt(1).messages.find((m) => m.role === "assistant");
      expect(assistant?.reasoning_content).toBe("necesito buscar spei");
      expect(assistant?.tool_calls).toHaveLength(1);
   });
});

describe("ask — images ride the SAME call as the tools (v4.1)", () => {
   test("an attached image becomes an image_url content part in the same request", async () => {
      createMock.mockResolvedValueOnce(end("Veo un cuadro rojo."));
      const tools = fakeTools();
      const out = await ask({
         system: "p",
         messages: [
            { role: "user", content: "¿qué ves?", attachments: [img()] },
         ],
         tools,
         effort: "low",
      });
      expect(out).toBe("Veo un cuadro rojo.");
      // ONE upstream call — the old two-stage flow made two (Nova, then text).
      expect(createMock).toHaveBeenCalledTimes(1);

      const parts = reqAt(0).messages[1].content as Array<
         Record<string, unknown>
      >;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "text", text: "¿qué ves?" });
      expect(parts[1]).toMatchObject({ type: "image_url" });
      const url = (parts[1] as { image_url: { url: string } }).image_url.url;
      // base64 data URL, not the (signed, short-lived) Discord CDN link.
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(Buffer.from(url.split(",")[1], "base64")).toEqual(
         Buffer.from([1, 2, 3]),
      );
   });

   test("several images in one turn become several image parts", async () => {
      createMock.mockResolvedValueOnce(end("dos"));
      await ask({
         system: "p",
         messages: [
            {
               role: "user",
               content: "mira",
               attachments: [img([1]), img([2]), img([3])],
            },
         ],
         tools: fakeTools(),
      });
      const parts = reqAt(0).messages[1].content as unknown[];
      expect(parts).toHaveLength(4); // 1 text + 3 images
   });

   test("an image turn keeps its tool bundle — no downgrade to a vision-only call", async () => {
      // This is the shape that broke on the old backend: a calendar flyer turn
      // was routed wholesale to the weaker vision model, which looped a write
      // tool ten times and then 400'd the forcing pass. The tools must be present
      // on the SAME request as the pixels.
      createMock
         .mockResolvedValueOnce(
            toolCalls([
               {
                  id: "t1",
                  name: "calendar_create_event",
                  input: { title: "X" },
               },
            ]),
         )
         .mockResolvedValueOnce(end("Listo."));
      const tools: ComposedTools = {
         tools: [
            {
               name: "calendar_create_event",
               description: "create",
               inputSchema: { type: "object", properties: {} },
            },
         ],
         handle: vi.fn(async () => ({
            status: "success" as const,
            payload: { id: 7 },
         })),
      };
      const out = await ask({
         system: "p",
         messages: [{ role: "user", content: "anuncia", attachments: [img()] }],
         tools,
         effort: "high",
      });
      expect(out).toBe("Listo.");
      expect(tools.handle).toHaveBeenCalledTimes(1);
      expect((reqAt(0).tools as unknown[]).length).toBe(1);
      const parts = reqAt(0).messages[1].content as unknown[];
      expect(parts).toHaveLength(2); // text + image, on the tool-carrying request
   });

   test("a history turn without attachments stays a plain string", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      await ask({
         system: "p",
         messages: [
            { role: "user", content: "antes" },
            { role: "assistant", content: "sí" },
            { role: "user", content: "ahora", attachments: [img()] },
         ],
         tools: fakeTools(),
      });
      // History stays text-only (DeepSeek 400s an image in an assistant message),
      // so only the live turn carries parts.
      expect(reqAt(0).messages[1]).toEqual({ role: "user", content: "antes" });
      expect(reqAt(0).messages[2]).toEqual({
         role: "assistant",
         content: "sí",
      });
      expect(Array.isArray(reqAt(0).messages[3].content)).toBe(true);
   });

   test("assistant history turns never carry an image part", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      await ask({
         system: "p",
         messages: [
            // A malformed window: an assistant turn that somehow has attachments.
            { role: "assistant", content: "mira", attachments: [img()] },
            { role: "user", content: "hola" },
         ],
         tools: fakeTools(),
      });
      const assistant = reqAt(0).messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("mira");
      expect(assistant).not.toHaveProperty("tool_calls");
   });
});

describe("ask — only one backend exists", () => {
   test("the request goes to the configured DeepSeek model", async () => {
      createMock.mockResolvedValueOnce(end("ok"));
      await ask({
         system: "p",
         messages: [{ role: "user", content: "x" }],
         tools: fakeTools(),
      });
      expect(reqAt(0).model).toBe(config.DEEPSEEK_MODEL_ID);
   });
});
