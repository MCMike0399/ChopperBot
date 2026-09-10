import { describe, test, expect, vi, beforeEach } from "vitest";

// Capture the ask() call so we can assert what the classifier hands the LLM.
const { askMock } = vi.hoisted(() => ({ askMock: vi.fn() }));
vi.mock("../../../llm/client.js", () => ({ ask: askMock }));

const { parseClassificationReply, classifyPost } =
   await import("../classifier.js");
import type { RecentPost } from "../fetcher.js";

describe("parseClassificationReply", () => {
   test("parses a clean JSON object", () => {
      const raw = JSON.stringify({
         relevant: true,
         type: "evento",
         title: "Marcha 8M",
         summary: "Marcha en CDMX",
         when: "2026-03-08T18:00:00-06:00",
         where: "CDMX",
         tags: ["cdmx", "feminismo"],
      });
      const c = parseClassificationReply(raw);
      expect(c).not.toBeNull();
      expect(c!.relevant).toBe(true);
      expect(c!.type).toBe("evento");
      expect(c!.title).toBe("Marcha 8M");
      expect(c!.tags).toEqual(["cdmx", "feminismo"]);
   });

   test("strips ```json fences", () => {
      const raw =
         '```json\n{"relevant":false,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":[]}\n```';
      const c = parseClassificationReply(raw);
      expect(c).not.toBeNull();
      expect(c!.relevant).toBe(false);
   });

   test("tolerates leading prose before the JSON object", () => {
      const raw =
         'Aquí está el resultado:\n{"relevant":true,"type":"alerta","title":"X","summary":"y","when":null,"where":"CDMX","tags":["x"]}';
      const c = parseClassificationReply(raw);
      expect(c).not.toBeNull();
      expect(c!.type).toBe("alerta");
      expect(c!.where).toBe("CDMX");
   });

   test('coerces unknown type to "otro"', () => {
      const raw =
         '{"relevant":true,"type":"weird","title":"x","summary":"y","when":null,"where":null,"tags":[]}';
      const c = parseClassificationReply(raw);
      expect(c!.type).toBe("otro");
   });

   test("clamps tags to 5 strings, drops non-strings", () => {
      const raw =
         '{"relevant":true,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":["a","b",3,"c","d","e","f"]}';
      const c = parseClassificationReply(raw);
      expect(c!.tags).toEqual(["a", "b", "c", "d", "e"]);
   });

   test("returns null on garbage text", () => {
      expect(parseClassificationReply("lol no json here")).toBeNull();
      expect(parseClassificationReply("")).toBeNull();
   });

   test("returns null on unbalanced braces", () => {
      expect(parseClassificationReply('{ "relevant": true ')).toBeNull();
   });

   // Historical: a weaker vision-only model used to write the STRING "null"
   // instead of the JSON literal, which printed a literal "Cuándo: null" on the
   // card. The decider is a frontier multimodal model now, so this should no
   // longer happen — but the guard costs nothing and must keep working.
   test('normalizes a literal string "null"/"None" in when/where to real null', () => {
      const raw =
         '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"null","where":"None","tags":[]}';
      const c = parseClassificationReply(raw);
      expect(c!.when).toBeNull();
      expect(c!.where).toBeNull();
   });

   test("normalizes accented / upper-case nullish tokens (Sin Fecha, NINGUNO, N/A)", () => {
      const raw =
         '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"Sin Fecha","where":"N/A","tags":[]}';
      const c = parseClassificationReply(raw);
      expect(c!.when).toBeNull();
      expect(c!.where).toBeNull();
      const raw2 =
         '{"relevant":true,"type":"noticia","title":"x","summary":"y","when":"NINGUNO","where":"no especificado","tags":[]}';
      const c2 = parseClassificationReply(raw2);
      expect(c2!.when).toBeNull();
      expect(c2!.where).toBeNull();
   });

   test("normalizes nullish title/summary to empty strings", () => {
      const raw =
         '{"relevant":false,"type":"otro","title":"null","summary":"ninguna","when":null,"where":null,"tags":[]}';
      const c = parseClassificationReply(raw);
      expect(c!.title).toBe("");
      expect(c!.summary).toBe("");
   });

   test("keeps a real date / place unchanged", () => {
      const raw =
         '{"relevant":true,"type":"evento","title":"t","summary":"s","when":"2026-03-08","where":"CDMX","tags":[]}';
      const c = parseClassificationReply(raw);
      expect(c!.when).toBe("2026-03-08");
      expect(c!.where).toBe("CDMX");
   });
});

describe("classifyPost — ONE multimodal call (v4.1)", () => {
   const post: RecentPost = {
      igPostId: "123",
      shortcode: "ABC",
      caption: "Convocatoria",
      takenAtMs: Date.parse("2026-06-22T20:00:00Z"),
      mediaType: "image",
      displayUrl: "https://example/c.jpg",
   };
   const goodReply = JSON.stringify({
      relevant: true,
      type: "convocatoria",
      title: "t",
      summary: "s",
      when: null,
      where: null,
      tags: [],
   });
   const cover = {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      format: "jpeg" as const,
   };

   beforeEach(() => askMock.mockReset());

   test("no cover → one caption-only call on the low tier, no attachment", async () => {
      askMock.mockResolvedValueOnce(goodReply);
      const out = await classifyPost("acc", post, { nowMs: Date.now() });
      expect(askMock).toHaveBeenCalledTimes(1);
      const arg = askMock.mock.calls[0][0] as {
         effort: string;
         messages: Array<{ attachments?: unknown[]; content: string }>;
      };
      expect(arg.effort).toBe("low");
      expect(arg.messages[0].attachments).toBeUndefined();
      expect(arg.messages[0].content).not.toContain("adjunta como imagen");
      expect(out.relevant).toBe(true);
   });

   test("with cover → ONE call carrying the image, the caption AND the tools bundle", async () => {
      askMock.mockResolvedValueOnce(goodReply);
      const out = await classifyPost("acc", post, { cover, nowMs: Date.now() });

      // The old flow made TWO calls here (Nova transcribed, then the text brain
      // decided). One multimodal call is the whole point of the migration.
      expect(askMock).toHaveBeenCalledTimes(1);
      const arg = askMock.mock.calls[0][0] as {
         effort: string;
         messages: Array<{
            attachments?: Array<{ mimeType: string; format: string }>;
            content: string;
         }>;
      };
      expect(arg.effort).toBe("low");
      expect(arg.messages[0].attachments).toHaveLength(1);
      expect(arg.messages[0].attachments![0]).toMatchObject({
         mimeType: "image/jpeg",
         format: "jpeg",
      });
      // The caption still rides along — the flyer and the caption are read together.
      expect(arg.messages[0].content).toContain("Convocatoria");
      expect(arg.messages[0].content).toContain("adjunta como imagen");
      expect(out.relevant).toBe(true);
   });

   test("a failed classification call is non-fatal but marks the post undecided", async () => {
      askMock.mockRejectedValueOnce(new Error("deepseek 500"));
      const out = await classifyPost("acc", post, { cover, nowMs: Date.now() });
      expect(askMock).toHaveBeenCalledTimes(1);
      expect(out.relevant).toBe(false);
      expect(out.reason).toMatch(/ask_failed/);
      // The scheduler holds its dedup anchor back on `undecided` so the post is
      // retried instead of being silently dropped forever.
      expect(out.undecided).toBe(true);
   });

   test("an unparseable reply is undecided too", async () => {
      askMock.mockResolvedValueOnce("no soy JSON");
      const out = await classifyPost("acc", post, { nowMs: Date.now() });
      expect(out.undecided).toBe(true);
      expect(out.reason).toBe("parse_error");
   });
});
