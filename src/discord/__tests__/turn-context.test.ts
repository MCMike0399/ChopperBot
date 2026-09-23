/** The 2026-09-23 general_chat audit fixes on what a turn carries beyond its words. */
import { describe, test, expect } from "vitest";
import {
   composeUserText,
   parentImagesLabel,
   renderAmbientContext,
   renderThreadContext,
   type ContextMessage,
} from "../turn-context.js";

const coll = <T>(items: T[]) => ({ values: () => items.values() });
const T0 = 1_790_000_000_000;

function m(over: Partial<ContextMessage> & { id: string }): ContextMessage {
   return {
      content: "",
      createdTimestamp: T0,
      author: { id: "u1", bot: false, username: "luna_x", globalName: "Luna" },
      member: null,
      attachments: coll([]),
      stickers: coll([]),
      mentions: { users: coll([]), members: null },
      ...over,
   };
}

describe("composeUserText", () => {
   test("an image-only mention is answered, not dropped (was: return before attachments)", () => {
      const msg = m({ id: "1", attachments: coll([{ name: "meme.jpg", contentType: "image/jpeg" }]) });
      expect(composeUserText("", msg)).toBe("(mandó una imagen sin texto)");
   });

   test("a sticker-only reply carries the sticker name (live 1534771943474204692)", () => {
      expect(composeUserText("", m({ id: "1", stickers: coll([{ name: "bebepensando" }]) }))).toBe("[sticker: bebepensando]");
   });

   test("a PDF is named so the model can say it can't open it", () => {
      const msg = m({ id: "1", attachments: coll([{ name: "tarea.pdf", contentType: "application/pdf" }]) });
      expect(composeUserText("léelo", msg)).toBe("léelo\n[adjuntó un archivo que no puedes abrir aquí: tarea.pdf]");
   });

   test("<@id> becomes @Name", () => {
      const msg = m({
         id: "1",
         mentions: {
            users: coll([{ id: "123456789012345678", username: "darko_", globalName: "Darko" }]),
            members: { get: () => ({ displayName: "Darko ☭" }) },
         },
      });
      expect(composeUserText("dile a <@123456789012345678> que sí", msg)).toBe("dile a @Darko ☭ que sí");
   });

   test("a bare mention with nothing at all stays empty (no reply)", () => {
      expect(composeUserText("", m({ id: "1" }))).toBe("");
   });
});

describe("renderAmbientContext", () => {
   const bot = "BOT";
   test("recent lines, oldest first, labelled as context; other bots and stale lines skipped", () => {
      const recent = [
         m({ id: "a", content: "¿el bot sabe de Marx?", createdTimestamp: T0 - 60_000 }),
         m({ id: "b", content: "yo creo que sí", createdTimestamp: T0 - 30_000, author: { id: "u2", bot: false, username: "x", globalName: "Tomate" } }),
         m({ id: "c", content: "embed", createdTimestamp: T0 - 20_000, author: { id: "other", bot: true, username: "MEE6" } }),
         m({ id: "d", content: "muy viejo", createdTimestamp: T0 - 30 * 60_000 }),
      ];
      const block = renderAmbientContext(recent, { id: "z", createdTimestamp: T0 }, bot)!;
      expect(block).toMatch(/^\[Contexto — lo último que se dijo en el canal/);
      expect(block.split("\n").slice(1)).toEqual(["- Luna: ¿el bot sabe de Marx?", "- Tomate: yo creo que sí"]);
   });

   test("own lines are labelled as the bot's; images noted", () => {
      const recent = [
         m({ id: "a", content: "hola", createdTimestamp: T0 - 5_000, author: { id: bot, bot: true, username: "ChopperBot" } }),
         m({ id: "b", createdTimestamp: T0 - 4_000, attachments: coll([{ name: "x.png", contentType: "image/png" }]) }),
      ];
      const block = renderAmbientContext(recent, { id: "z", createdTimestamp: T0 }, bot)!;
      expect(block).toContain("- ChopperBot (tú): hola");
      expect(block).toContain("- Luna: [imagen]");
   });

   test("nothing recent → null", () => {
      expect(renderAmbientContext([], { id: "z", createdTimestamp: T0 }, bot)).toBeNull();
   });

   test("capped in size", () => {
      const recent = Array.from({ length: 10 }, (_, i) =>
         m({ id: String(i), content: "x".repeat(400), createdTimestamp: T0 - i * 1000 - 1 }),
      );
      expect(renderAmbientContext(recent, { id: "z", createdTimestamp: T0 }, bot)!.length).toBeLessThan(2300);
   });
});

describe("labels", () => {
   test("parent images and thread", () => {
      expect(parentImagesLabel("Luna", 1, false)).toMatch(/mensaje de Luna, que trae una imagen — va adjunta/);
      expect(parentImagesLabel("x", 2, true)).toMatch(/tu propio mensaje anterior, que trae 2 imágenes/);
      expect(renderThreadContext("Gracias por el taller", "Les dejo la presentación")).toBe(
         "[Contexto — estás en el hilo/publicación «Gracias por el taller».\nPublicación inicial: «Les dejo la presentación»]",
      );
   });
});
