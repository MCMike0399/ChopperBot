import { afterEach, beforeEach, expect, test, vi } from "vitest";
const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
   default: class {
      chat = { completions: { create: createMock } };
   },
}));
import { ask } from "../client.js";
import { WEB_SEARCH_INSTRUCTIONS } from "../../tools/web-search.js";

const input = () => ({
   system: "capability system",
   messages: [{ role: "user" as const, content: "Busca fuentes públicas" }],
   tools: { tools: [], handle: vi.fn() },
   effort: "low" as const,
});
const reply = (content: string) => ({
   choices: [{ finish_reason: "stop", message: { content } }],
});
const call = (id: string, query: string) => ({
   choices: [
      {
         finish_reason: "tool_calls",
         message: {
            content: null,
            tool_calls: [
               {
                  id,
                  type: "function",
                  function: {
                     name: "web_search",
                     arguments: JSON.stringify({ query }),
                  },
               },
            ],
         },
      },
   ],
});
beforeEach(() => createMock.mockReset());
afterEach(() => vi.unstubAllGlobals());

test("adds search and safety/citation instructions to the actual cached system prefix", async () => {
   const fetch = vi.fn(
      async () =>
         new Response(
            JSON.stringify({
               results: [
                  {
                     title: "Official",
                     url: "https://example.org",
                     summary: "Current evidence",
                  },
               ],
            }),
         ),
   );
   vi.stubGlobal("fetch", fetch);
   createMock
      .mockResolvedValueOnce(call("search1", "ciencia site:example.org"))
      .mockResolvedValueOnce(reply("Fuente: https://example.org/"));
   const result = await ask({
      ...input(),
      webSearch: true,
      stableSystem: "stable system",
      systemTail: "trusted tail",
      channelTranscript: "quoted private context",
   });
   expect(result).toContain("https://example.org");
   const request = createMock.mock.calls[0][0];
   expect(request.messages[0].content).toBe(
      `stable system\n\n${WEB_SEARCH_INSTRUCTIONS}`,
   );
   expect(request.tools).toEqual([
      expect.objectContaining({
         function: expect.objectContaining({ name: "web_search" }),
      }),
   ]);
   expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({
      query: "ciencia site:example.org",
      count: 5,
      need_content: false,
   });
   const toolReply = createMock.mock.calls[1][0].messages.find(
      (m: any) => m.role === "tool",
   );
   expect(JSON.parse(toolReply.content)).toMatchObject({
      results: [{ url: "https://example.org/" }],
   });
});

test("does not attach search to background or JSON callers", async () => {
   createMock.mockResolvedValue(reply("{}"));
   await ask(input());
   await ask({ ...input(), webSearch: true, responseFormat: "json_object" });
   for (const [request] of createMock.mock.calls) {
      expect(request.tools).toBeUndefined();
      expect(request.messages[0].content).not.toContain(
         WEB_SEARCH_INSTRUCTIONS,
      );
   }
});

test("normal greetings can answer without any search requests", async () => {
   const fetch = vi.fn();
   vi.stubGlobal("fetch", fetch);
   createMock.mockResolvedValueOnce(reply("Hola, amix."));
   expect(await ask({ ...input(), webSearch: true })).toBe("Hola, amix.");
   expect(fetch).not.toHaveBeenCalled();
});

test("identical successful searches share the existing per-turn cache", async () => {
   const fetch = vi.fn(async () => new Response('{"results":[]}'));
   vi.stubGlobal("fetch", fetch);
   createMock
      .mockResolvedValueOnce(call("a", "fuentes"))
      .mockResolvedValueOnce(call("b", "fuentes"))
      .mockResolvedValueOnce(reply("Sin resultados."));
   await ask({ ...input(), webSearch: true });
   expect(fetch).toHaveBeenCalledTimes(1);
});

test("failed search reaches the model as an error and the turn can still answer", async () => {
   const fetch = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
   );
   vi.stubGlobal("fetch", fetch);
   createMock
      .mockResolvedValueOnce(call("a", "fuentes"))
      .mockResolvedValueOnce(reply("No pude verificar la información."));
   expect(await ask({ ...input(), webSearch: true })).toContain(
      "No pude verificar",
   );
   const toolReply = createMock.mock.calls[1][0].messages.find(
      (m: any) => m.role === "tool",
   );
   expect(toolReply.content).toContain("503");
   expect(toolReply.content).toContain("false");
});
