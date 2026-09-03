/**
 * askBedrock — forcing-pass protocol (live 2026-09-03).
 *
 * A calendar flyer turn hit MAX_TOOL_ITERATIONS still calling tools; the
 * forcing pass re-sent the convo WITHOUT `toolConfig` while history still had
 * toolUse/toolResult blocks. Converse 400s that shape:
 *   "The toolConfig field must be defined when using toolUse and toolResult
 *    content blocks."
 * The member got the empty-response fallback and the health watchdog paged
 * a "deterministic config error". The pass must flatten those blocks into
 * text, omit toolConfig (now legal), carry the prose nudge, and must NOT
 * execute more tools.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const { kimiMock, sendMock } = vi.hoisted(() => ({
   kimiMock: vi.fn(),
   sendMock: vi.fn(),
}));

vi.mock("openai", () => {
   class OpenAI {
      chat = { completions: { create: kimiMock } };
      constructor(_opts?: unknown) {}
   }
   return { default: OpenAI };
});
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
   class BedrockRuntimeClient {
      send = sendMock;
      constructor(_opts?: unknown) {}
   }
   class ConverseCommand {
      input: unknown;
      constructor(input: unknown) {
         this.input = input;
      }
   }
   return { BedrockRuntimeClient, ConverseCommand };
});

import { ask, flattenBedrockMessagesForForcing } from "../client.js";
import { config } from "../../config.js";
import type { ComposedTools } from "../../tools/source.js";
import type { Message } from "@aws-sdk/client-bedrock-runtime";

function bedrockEnd(text: string) {
   return {
      output: { message: { role: "assistant", content: [{ text }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
   };
}

function bedrockToolUse(id: string, name: string, input: unknown) {
   return {
      output: {
         message: {
            role: "assistant",
            content: [{ toolUse: { toolUseId: id, name, input } }],
         },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 2 },
   };
}

function fakeTools(): ComposedTools {
   return {
      tools: [
         {
            name: "calendar_draft_announcement",
            description: "draft",
            inputSchema: {
               type: "object",
               properties: { event_id: { type: "number" } },
            },
         },
      ],
      handle: vi.fn(async () => ({
         status: "success" as const,
         payload: { token: "abc", posted: 2 },
      })),
   };
}

function bedrockReqAt(i: number): {
   messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
   toolConfig?: unknown;
} {
   return (sendMock.mock.calls[i][0] as { input: unknown }).input as never;
}

function hasToolBlocks(
   messages: Array<{ content: Array<Record<string, unknown>> }>,
): boolean {
   return messages.some((m) =>
      m.content.some((b) => "toolUse" in b || "toolResult" in b),
   );
}

beforeEach(() => {
   kimiMock.mockReset();
   sendMock.mockReset();
});

describe("flattenBedrockMessagesForForcing", () => {
   test("rewrites toolUse/toolResult into text and merges consecutive same-role turns", () => {
      const convo: Message[] = [
         { role: "user", content: [{ text: "anuncia esto" }] },
         {
            role: "assistant",
            content: [
               {
                  toolUse: {
                     toolUseId: "t1",
                     name: "calendar_draft_announcement",
                     input: { event_id: 12 },
                  },
               },
            ],
         },
         {
            role: "user",
            content: [
               {
                  toolResult: {
                     toolUseId: "t1",
                     content: [{ text: '{"posted":2}' }],
                     status: "success",
                  },
               },
            ],
         },
      ];
      const out = flattenBedrockMessagesForForcing(convo);
      expect(out).toHaveLength(3);
      expect(out[0]).toEqual({
         role: "user",
         content: [{ text: "anuncia esto" }],
      });
      expect(out[1].role).toBe("assistant");
      expect((out[1].content?.[0] as { text: string }).text).toContain(
         "calendar_draft_announcement",
      );
      expect(out[2].role).toBe("user");
      expect((out[2].content?.[0] as { text: string }).text).toContain(
         "posted",
      );
      expect(
         out.every((m) =>
            (m.content ?? []).every(
               (b) => !("toolUse" in b) && !("toolResult" in b),
            ),
         ),
      ).toBe(true);
   });
});

describe("askBedrock — forcing pass after the iteration cap", () => {
   test("flattens tool blocks, omits toolConfig, returns prose, executes no extra tools", async () => {
      const tools = fakeTools();
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
         sendMock.mockResolvedValueOnce(
            bedrockToolUse(`t${i}`, "calendar_draft_announcement", {
               event_id: 12,
               i,
            }),
         );
      }
      sendMock.mockResolvedValueOnce(
         bedrockEnd("Listo — ya lo anuncié en general."),
      );

      const out = await ask({
         system: "s",
         messages: [{ role: "user", content: "anuncia la peli" }],
         tools,
         effort: "low",
      });

      expect(out).toBe("Listo — ya lo anuncié en general.");
      expect(sendMock).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS + 1);
      expect(tools.handle).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS);

      const forceReq = bedrockReqAt(config.MAX_TOOL_ITERATIONS);
      expect(forceReq.toolConfig).toBeUndefined();
      expect(hasToolBlocks(forceReq.messages)).toBe(false);
      const last = forceReq.messages.at(-1);
      expect(last?.role).toBe("user");
      expect(
         last?.content.some(
            (b) =>
               typeof b.text === "string" &&
               b.text.includes("sin llamar herramientas"),
         ),
      ).toBe(true);
   });

   test("a forcing pass that comes back empty gets one nudged retry", async () => {
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
         sendMock.mockResolvedValueOnce(
            bedrockToolUse(`t${i}`, "calendar_draft_announcement", {
               event_id: i,
            }),
         );
      }
      sendMock
         .mockResolvedValueOnce(bedrockEnd(""))
         .mockResolvedValueOnce(bedrockEnd("Parcial: lo anuncié."));

      const out = await ask({
         system: "s",
         messages: [{ role: "user", content: "go" }],
         tools: fakeTools(),
         effort: "low",
      });

      expect(out).toBe("Parcial: lo anuncié.");
      expect(sendMock).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS + 2);
      const retryReq = bedrockReqAt(config.MAX_TOOL_ITERATIONS + 1);
      expect(retryReq.toolConfig).toBeUndefined();
      expect(hasToolBlocks(retryReq.messages)).toBe(false);
      const last = retryReq.messages.at(-1);
      expect(
         last?.content.some(
            (b) =>
               typeof b.text === "string" && b.text.includes("Último intento"),
         ),
      ).toBe(true);
   });
});
