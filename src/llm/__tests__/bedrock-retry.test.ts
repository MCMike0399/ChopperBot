/**
 * askBedrock — empty-response retry. Nova sometimes closes a tool loop with
 * `end_turn` and NO text block at all once the tool results land (observed
 * live 2026-08-13: a calendar image turn created + synced + published the
 * event, then ended textless and the member got the "No pude generar una
 * respuesta" fallback despite everything having succeeded). The client must
 * drop the empty assistant echo and retry the same convo a bounded number of
 * times — the same policy the Kimi path has (kimi-retry.test.ts) — and a
 * retry that re-emits the same tool call must be served from the per-turn
 * tool cache so a write is never doubled.
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

import { ask } from "../client.js";
import type { ComposedTools } from "../../tools/source.js";

function bedrockEnd(text: string) {
   return {
      output: { message: { role: "assistant", content: [{ text }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
   };
}

/** An end_turn with no usable content — the failure shape from the incident. */
function bedrockEmptyEnd() {
   return {
      output: { message: { role: "assistant", content: [] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 0 },
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

function fakeTools(
   handle?: (
      n: string,
      i: unknown,
   ) => Promise<{ status: "success" | "error"; payload: unknown }>,
): ComposedTools {
   return {
      tools: [
         {
            name: "calendar_create_event",
            description: "create",
            inputSchema: {
               type: "object",
               properties: { title: { type: "string" } },
            },
         },
      ],
      handle: vi.fn(
         handle ?? (async () => ({ status: "success", payload: { id: 33 } })),
      ),
   };
}

/** The Converse request we sent for the i-th send() call. */
function bedrockReqAt(i: number): {
   messages: Array<{ role: string; content: unknown[] }>;
} {
   return (sendMock.mock.calls[i][0] as { input: unknown }).input as never;
}

function baseInput(tools: ComposedTools) {
   return {
      system: "system",
      messages: [
         { role: "user" as const, content: "agenda esto (cartel adjunto)" },
      ],
      tools,
      // The vision tier routes to Bedrock without needing an image fixture.
      effort: "low" as const,
   };
}

beforeEach(() => {
   kimiMock.mockReset();
   sendMock.mockReset();
});

describe("askBedrock — empty-response retry", () => {
   test("empty end_turn after a tool run retries and returns the later text", async () => {
      const tools = fakeTools();
      sendMock
         .mockResolvedValueOnce(
            bedrockToolUse("t1", "calendar_create_event", { title: "X" }),
         )
         .mockResolvedValueOnce(bedrockEmptyEnd())
         .mockResolvedValueOnce(bedrockEnd("Listo — evento creado."));
      const out = await ask(baseInput(tools));
      expect(out).toBe("Listo — evento creado.");
      expect(sendMock).toHaveBeenCalledTimes(3);
      // The write ran exactly once: the retry never re-executed it.
      expect(tools.handle).toHaveBeenCalledTimes(1);
      // The retry resends the same convo — the empty assistant echo was dropped.
      expect(bedrockReqAt(1).messages).toEqual(bedrockReqAt(2).messages);
   });

   test("empty end_turn on the very first response is retried too", async () => {
      sendMock
         .mockResolvedValueOnce(bedrockEmptyEnd())
         .mockResolvedValueOnce(bedrockEnd("Va de nuevo."));
      const out = await ask(baseInput(fakeTools()));
      expect(out).toBe("Va de nuevo.");
      expect(sendMock).toHaveBeenCalledTimes(2);
   });

   test("a retry that re-emits the same tool call is served from cache — no double write", async () => {
      const tools = fakeTools();
      sendMock
         .mockResolvedValueOnce(
            bedrockToolUse("t1", "calendar_create_event", { title: "X" }),
         )
         .mockResolvedValueOnce(bedrockEmptyEnd())
         // On the retry the model calls the same tool with the same input again…
         .mockResolvedValueOnce(
            bedrockToolUse("t2", "calendar_create_event", { title: "X" }),
         )
         .mockResolvedValueOnce(bedrockEnd("Listo."));
      const out = await ask(baseInput(tools));
      expect(out).toBe("Listo.");
      // …but the handler still ran exactly once (the second call hit the tool cache).
      expect(tools.handle).toHaveBeenCalledTimes(1);
   });

   test("persistent empty responses give up after 2 retries with the Spanish fallback", async () => {
      sendMock.mockResolvedValue(bedrockEmptyEnd());
      const out = await ask(baseInput(fakeTools()));
      expect(out).toContain("No pude generar una respuesta");
      // 1 initial + 2 retries.
      expect(sendMock).toHaveBeenCalledTimes(3);
   });
});
