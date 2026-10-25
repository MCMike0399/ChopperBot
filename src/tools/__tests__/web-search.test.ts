import { afterEach, describe, expect, test, vi } from "vitest";
import {
   createSearchBudget,
   WebSearchSource,
   withWebSearch,
} from "../web-search.js";

const row = {
   title: "Fuente oficial",
   url: "https://example.org/news",
   summary: "Resumen",
   date: "2026-10-25T00:00:00Z",
};
const response = (results: unknown[] = [row]) =>
   new Response(JSON.stringify({ results }));
function fixture() {
   const fetch = vi.fn().mockImplementation(async () => response());
   const admit = vi.fn(() => true);
   const source = new WebSearchSource({
      apiKey: "test-private-key",
      fetch,
      admit,
   });
   return { source, fetch, admit };
}
afterEach(() => vi.restoreAllMocks());

describe("DeepSeek web search", () => {
   test("sends only the bounded public query to the fixed endpoint", async () => {
      const { source, fetch } = fixture();
      const result = await source.handle("web_search", {
         query: " site:example.org ciencia ",
      });
      expect(result.status).toBe("success");
      expect(result.payload).toMatchObject({ results: [row] });
      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/v1/tools/search");
      expect(JSON.parse(options.body)).toEqual({
         query: "site:example.org ciencia",
         count: 5,
         need_content: false,
      });
      expect(options.headers.Authorization).toBe("Bearer test-private-key");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(source.tools()[0].inputSchema).toMatchObject({
         additionalProperties: false,
      });
   });

   test.each([
      null,
      [],
      {},
      { query: " " },
      { query: "a".repeat(129) },
      { query: 12 },
      { query: "hola", count: 0 },
      { query: "hola", count: 6 },
      { query: "hola", count: 1.5 },
      { query: "hola", context: "private text" },
      { query: "hola", ori_question: "private text" },
   ])(
      "rejects invalid or unexpected input %j before spending",
      async (input) => {
         const { source, fetch, admit } = fixture();
         expect((await source.handle("web_search", input)).status).toBe(
            "error",
         );
         expect(fetch).not.toHaveBeenCalled();
         expect(admit).not.toHaveBeenCalled();
      },
   );

   test("counts Unicode code points rather than UTF-16 units", async () => {
      const { source } = fixture();
      expect(
         (await source.handle("web_search", { query: "🌎".repeat(128) }))
            .status,
      ).toBe("success");
      expect(
         (await source.handle("web_search", { query: "🌎".repeat(129) }))
            .status,
      ).toBe("error");
   });

   test("bounds results and text; ignores page content and unsafe URLs", async () => {
      const { source, fetch } = fixture();
      fetch.mockResolvedValueOnce(
         response([
            { ...row, url: "javascript:alert(1)" },
            { ...row, url: "https://user:pass@example.org" },
            {
               ...row,
               title: "T".repeat(1000),
               summary: "S".repeat(10_000),
               content: "private full page",
            },
            { ...row, summary: "", snippet: "Fallback" },
            row,
            row,
         ]),
      );
      const { payload } = await source.handle("web_search", {
         query: "fuentes",
         count: 4,
      });
      const data = payload as any;
      expect(data.results).toHaveLength(2);
      expect(data.results[0].title).toHaveLength(200);
      expect(data.results[0].summary).toHaveLength(1500);
      expect(data.results[0]).not.toHaveProperty("content");
      expect(data.results[1].summary).toBe("Fallback");
   });

   test("no results is a truthful success, not fabricated evidence", async () => {
      const { source, fetch } = fixture();
      fetch.mockResolvedValueOnce(response([]));
      expect(
         await source.handle("web_search", { query: "no matches" }),
      ).toMatchObject({ status: "success", payload: { results: [] } });
   });

   test.each([401, 402, 429, 500, 503])(
      "returns a safe HTTP %i error without retrying or leaking body",
      async (status) => {
         const { source, fetch } = fixture();
         fetch.mockResolvedValueOnce(
            new Response("test-private-key internal error", { status }),
         );
         const result = await source.handle("web_search", { query: "fuentes" });
         expect(result.status).toBe("error");
         expect(JSON.stringify(result)).toContain(String(status));
         expect(JSON.stringify(result)).not.toContain("test-private-key");
         expect(fetch).toHaveBeenCalledTimes(1);
      },
   );

   test.each([
      "network",
      "timeout",
      "invalid JSON",
      "invalid schema",
      "oversized",
   ])("handles %s safely", async (mode) => {
      const { source, fetch } = fixture();
      if (mode === "network" || mode === "timeout")
         fetch.mockRejectedValueOnce(new Error("test-private-key"));
      if (mode === "invalid JSON")
         fetch.mockResolvedValueOnce(new Response("not json"));
      if (mode === "invalid schema")
         fetch.mockResolvedValueOnce(new Response('{"results":[{"url":4}]}'));
      if (mode === "oversized")
         fetch.mockResolvedValueOnce(new Response("x".repeat(262_145)));
      const result = await source.handle("web_search", { query: "fuentes" });
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("test-private-key");
   });

   test("aborts a hanging request at 20 seconds", async () => {
      const { source, fetch } = fixture();
      const signal = new AbortController();
      const timeout = vi
         .spyOn(AbortSignal, "timeout")
         .mockReturnValue(signal.signal);
      fetch.mockImplementationOnce(
         async (_url, options) =>
            new Promise((_resolve, reject) =>
               options.signal.addEventListener("abort", () =>
                  reject(new Error("timeout")),
               ),
            ),
      );
      const pending = source.handle("web_search", { query: "fuentes" });
      signal.abort();
      expect((await pending).status).toBe("error");
      expect(timeout).toHaveBeenCalledWith(20_000);
   });

   test("missing key, unknown tool and shared budget exhaustion never fetch", async () => {
      const fetch = vi.fn();
      const absent = new WebSearchSource({ fetch, admit: () => true });
      expect(
         (await absent.handle("web_search", { query: "fuentes" })).status,
      ).toBe("error");
      const blocked = new WebSearchSource({
         apiKey: "test",
         fetch,
         admit: () => false,
      });
      expect(
         (await blocked.handle("web_search", { query: "fuentes" })).status,
      ).toBe("error");
      expect((await blocked.handle("other", { query: "fuentes" })).status).toBe(
         "error",
      );
      expect(fetch).not.toHaveBeenCalled();
   });

   test("caps attempted requests at three per turn, even across provider errors", async () => {
      const { source, fetch } = fixture();
      fetch.mockImplementation(
         async () => new Response("down", { status: 503 }),
      );
      for (let i = 0; i < 3; i++)
         await source.handle("web_search", { query: `fuentes ${i}` });
      expect(
         (await source.handle("web_search", { query: "fuentes cuarta" }))
            .payload,
      ).toMatchObject({ error: expect.stringContaining("3 búsquedas") });
      expect(fetch).toHaveBeenCalledTimes(3);
   });

   test("shared minute/day caps reset only in the next window", () => {
      let now = 0;
      const admit = createSearchBudget(() => now);
      for (let minute = 0; minute < 33; minute++) {
         now = minute * 60_000;
         for (let call = 0; call < 30; call++) expect(admit()).toBe(true);
         expect(admit()).toBe(false);
      }
      now = 33 * 60_000;
      for (let call = 0; call < 10; call++) expect(admit()).toBe(true);
      expect(admit()).toBe(false);
      now += 60_000;
      expect(admit()).toBe(false);
      now = 86_400_000;
      expect(admit()).toBe(true);
   });

   test("preserves existing capability dispatch and rejects collisions", async () => {
      const handle = vi.fn(async () => ({
         status: "error" as const,
         payload: { error: "denied" },
      }));
      const existing = {
         tools: [
            { name: "protected_action", description: "gated", inputSchema: {} },
         ],
         handle,
      };
      const { source } = fixture();
      const merged = withWebSearch(existing, source);
      expect(merged.tools.map((tool) => tool.name)).toEqual([
         "protected_action",
         "web_search",
      ]);
      expect(
         (await merged.handle("protected_action", { confirm: true })).status,
      ).toBe("error");
      expect(handle).toHaveBeenCalledWith("protected_action", {
         confirm: true,
      });
      expect((await merged.handle("unknown", {})).status).toBe("error");
      expect(() =>
         withWebSearch({ ...existing, tools: source.tools() }, source),
      ).toThrow("collision");
   });
});
