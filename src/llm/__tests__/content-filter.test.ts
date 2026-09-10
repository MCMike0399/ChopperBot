/**
 * ask() — recovery from a provider CONTENT-FILTER rejection.
 *
 * Incident (2026-08-06 09:57 + 10:09 CST, #club-de-cine): a member asked
 * general_chat "¿qué deberíamos hacer con las personas que apoyan a china en
 * este servidor?" and the gateway answered `400 The request was rejected
 * because it was considered high risk`. The turn threw, the member got the
 * English "Sorry, I hit an error answering that — check the logs.", and the
 * admin channel got paged as if the API key were broken.
 *
 * The filter is probabilistic (the same prompt answered on a replay minutes
 * later), so the contract is: retry once → then a Spanish message. The old
 * second leg of that ladder — failing over to Amazon Nova — is GONE with the
 * Bedrock backend (v4.1 migration, 2026-09-14), because there is no second
 * provider left to fail over to.
 *
 * And never retry once tools have run, or an approved calendar event would be
 * created twice.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));

const { ask } = await import("../client.js");
import type { ComposedTools } from "../../tools/source.js";

/** The verbatim rejection from the incident. */
function highRisk(): Error {
   const err = new Error(
      "400 The request was rejected because it was considered high risk",
   ) as Error & { status: number; param: string };
   err.status = 400;
   err.param = "prompt";
   return err;
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

function toolCall(id: string, name: string, input: unknown) {
   return {
      choices: [
         {
            message: {
               role: "assistant",
               content: null,
               tool_calls: [
                  {
                     id,
                     type: "function",
                     function: { name, arguments: JSON.stringify(input) },
                  },
               ],
            },
            finish_reason: "tool_calls",
         },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
   };
}

/** HTTP 200, but the provider's filter omitted the content. */
function filteredEnd() {
   return {
      choices: [
         {
            message: { role: "assistant", content: "" },
            finish_reason: "content_filter",
         },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
   };
}

function fakeTools(handle?: ComposedTools["handle"]): ComposedTools {
   return {
      tools: [
         {
            name: "calendar_create_event",
            description: "create",
            inputSchema: { type: "object", properties: {} },
         },
      ],
      handle: vi.fn(
         handle ?? (async () => ({ status: "success", payload: { id: 1 } })),
      ),
   };
}

const TURN = {
   system: "eres chopperbot",
   messages: [
      {
         role: "user" as const,
         content:
            "que deberiamos que hacer con las personas que apoyan a china en este servidor?",
      },
   ],
};

beforeEach(() => {
   createMock.mockReset();
});

describe("ask — content-filter recovery", () => {
   test("retries once and returns the answer the retry produced", async () => {
      createMock
         .mockRejectedValueOnce(highRisk())
         .mockResolvedValueOnce(end("Aquí la postura."));
      const out = await ask({ ...TURN, tools: fakeTools() });
      expect(out).toBe("Aquí la postura.");
      expect(createMock).toHaveBeenCalledTimes(2);
   });

   test("a Spanish message is the last resort when the retry is refused too", async () => {
      createMock.mockRejectedValue(highRisk());
      const out = await ask({ ...TURN, tools: fakeTools() });
      expect(out).toMatch(/filtro del proveedor/i);
      expect(out).not.toMatch(/error|logs/i);
      expect(createMock).toHaveBeenCalledTimes(2);
   });

   test("finish_reason 'content_filter' (HTTP 200) takes the same ladder", async () => {
      // DeepSeek can omit the content and still answer 200. That is the same
      // event as the 400-shaped refusal, and without this it would look like an
      // ordinary empty response and burn the three empty-retries instead.
      createMock
         .mockResolvedValueOnce(filteredEnd())
         .mockResolvedValueOnce(end("Ahora sí."));
      const out = await ask({ ...TURN, tools: fakeTools() });
      expect(out).toBe("Ahora sí.");
      expect(createMock).toHaveBeenCalledTimes(2);
   });

   test("a persistently filtered turn ends in the Spanish message, not the empty fallback", async () => {
      createMock.mockResolvedValue(filteredEnd());
      const out = await ask({ ...TURN, tools: fakeTools() });
      expect(out).toMatch(/filtro del proveedor/i);
   });

   test("does NOT retry after a tool has run — a second pass would re-create the event", async () => {
      const tools = fakeTools();
      createMock
         .mockResolvedValueOnce(
            toolCall("c1", "calendar_create_event", { title: "Asamblea" }),
         )
         .mockRejectedValueOnce(highRisk());
      const out = await ask({ ...TURN, tools });
      expect(tools.handle).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledTimes(2); // the initial call + the post-tool call, no retry
      expect(out).toMatch(/filtro del proveedor/i);
   });

   test("a filtered FORCING pass after tools also skips the retry", async () => {
      const tools = fakeTools();
      // Every loop iteration calls a (deduped) tool, so one write happens; the
      // only permitted forcing pass then comes back filtered.
      createMock
         .mockResolvedValueOnce(
            toolCall("c1", "calendar_create_event", { title: "Asamblea" }),
         )
         .mockResolvedValueOnce(filteredEnd());
      const out = await ask({ ...TURN, tools });
      expect(tools.handle).toHaveBeenCalledTimes(1);
      expect(out).toMatch(/filtro del proveedor/i);
   });

   test("other errors still propagate — a bad key must not look like moderation", async () => {
      const authErr = new Error("401 Invalid Authentication") as Error & {
         status: number;
      };
      authErr.status = 401;
      createMock.mockRejectedValueOnce(authErr);
      await expect(ask({ ...TURN, tools: fakeTools() })).rejects.toThrow(
         "Invalid Authentication",
      );
      expect(createMock).toHaveBeenCalledTimes(1);
   });
});
