import { describe, test, expect } from "vitest";
import { classifyMessage, isNoiseAssistantMessage } from "../history.js";
import {
   EMPTY_RESPONSE_FALLBACK,
   CONTENT_FILTER_FALLBACK,
} from "../../../llm/client.js";
import { GENERIC_ERROR_REPLY } from "../../../discord/handlers.js";

const BOT = "bot-1";
const base = {
   id: "m1",
   authorId: "user-1",
   authorBot: false,
   content: "hola",
   createdTimestamp: 1000,
   attachmentNames: [] as string[],
};
const opts = { sinceMs: null, skipIds: new Set<string>() };

describe("classifyMessage", () => {
   test("maps humans to user and the bot to assistant", () => {
      expect(classifyMessage(base, BOT, opts)).toEqual({
         role: "user",
         content: "hola",
      });
      expect(
         classifyMessage(
            { ...base, authorId: BOT, authorBot: true, content: "respuesta" },
            BOT,
            opts,
         ),
      ).toEqual({ role: "assistant", content: "respuesta" });
   });

   test("skips foreign bots, skipIds, and messages at/before the context clear", () => {
      expect(
         classifyMessage(
            { ...base, authorId: "other-bot", authorBot: true },
            BOT,
            opts,
         ),
      ).toBeNull();
      expect(
         classifyMessage(base, BOT, { ...opts, skipIds: new Set(["m1"]) }),
      ).toBeNull();
      expect(classifyMessage(base, BOT, { ...opts, sinceMs: 1000 })).toBeNull();
      expect(
         classifyMessage(base, BOT, { ...opts, sinceMs: 999 }),
      ).not.toBeNull();
   });

   test("strips the continuation footer from bot chunks", () => {
      const turn = classifyMessage(
         {
            ...base,
            authorId: BOT,
            authorBot: true,
            content: "parte 1\n\n_…sigue ↓_",
         },
         BOT,
         opts,
      );
      expect(turn?.content).toBe("parte 1");
   });

   test("an attachment-only message becomes a descriptive user turn", () => {
      const turn = classifyMessage(
         { ...base, content: "", attachmentNames: ["datos.csv"] },
         BOT,
         opts,
      );
      expect(turn).toEqual({
         role: "user",
         content: "[envió archivo(s): datos.csv]",
      });
   });

   test("empty messages are dropped", () => {
      expect(
         classifyMessage({ ...base, content: "   " }, BOT, opts),
      ).toBeNull();
   });

   test("operational bot messages never reach the model as assistant turns", () => {
      // The live 2026-08-06 poisoning: two fallbacks in history taught Kimi to
      // answer the next question with the fallback verbatim.
      for (const noise of [
         EMPTY_RESPONSE_FALLBACK,
         CONTENT_FILTER_FALLBACK,
         GENERIC_ERROR_REPLY,
         "-# 🐍 Ejecutando código · paso 3",
         "🔎 **Análisis de seguridad (VirusTotal)**\n✅ archivo.pdf — limpio",
         "🧹 Listo — borrón y cuenta nueva. (Tus archivos del workspace siguen ahí.)",
         "🔒 Cerrando este taller… ¡nos vemos!",
      ]) {
         expect(isNoiseAssistantMessage(noise)).toBe(true);
         expect(
            classifyMessage(
               { ...base, authorId: BOT, authorBot: true, content: noise },
               BOT,
               opts,
            ),
         ).toBeNull();
      }
      // …while a real reply that merely MENTIONS an error still counts.
      expect(
         isNoiseAssistantMessage("El error de tu script era un typo."),
      ).toBe(false);
   });

   test("the same text from the USER is kept (only bot copies are noise)", () => {
      expect(
         classifyMessage(
            { ...base, content: EMPTY_RESPONSE_FALLBACK },
            BOT,
            opts,
         ),
      ).not.toBeNull();
   });
});
