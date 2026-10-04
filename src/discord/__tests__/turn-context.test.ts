/** The 2026-09-23 general_chat audit fixes on what a turn carries beyond its words. */
import { describe, test, expect } from "vitest";
import {
   composeUserText,
   parentImagesLabel,
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
      const msg = m({
         id: "1",
         attachments: coll([{ name: "meme.jpg", contentType: "image/jpeg" }]),
      });
      expect(composeUserText("", msg)).toBe("(mandó una imagen sin texto)");
   });

   test("a sticker-only reply carries the sticker name (live 1534771943474204692)", () => {
      expect(
         composeUserText(
            "",
            m({ id: "1", stickers: coll([{ name: "bebepensando" }]) }),
         ),
      ).toBe("[sticker: bebepensando]");
   });

   test("a PDF is named so the model can say it can't open it", () => {
      const msg = m({
         id: "1",
         attachments: coll([
            { name: "tarea.pdf", contentType: "application/pdf" },
         ]),
      });
      expect(composeUserText("léelo", msg)).toBe(
         "léelo\n[adjuntó un archivo que no puedes abrir aquí: tarea.pdf]",
      );
   });

   test("<@id> becomes @Name", () => {
      const msg = m({
         id: "1",
         mentions: {
            users: coll([
               {
                  id: "123456789012345678",
                  username: "darko_",
                  globalName: "Darko",
               },
            ]),
            members: { get: () => ({ displayName: "Darko ☭" }) },
         },
      });
      expect(composeUserText("dile a <@123456789012345678> que sí", msg)).toBe(
         "dile a @Darko ☭ que sí",
      );
   });

   test("a bare mention with nothing at all stays empty (no reply)", () => {
      expect(composeUserText("", m({ id: "1" }))).toBe("");
   });
});

describe("labels", () => {
   test("parent images and thread", () => {
      expect(parentImagesLabel("Luna", 1, false)).toMatch(
         /mensaje de Luna, que trae una imagen — va adjunta/,
      );
      expect(parentImagesLabel("x", 2, true)).toMatch(
         /tu propio mensaje anterior, que trae 2 imágenes/,
      );
      expect(
         renderThreadContext(
            "Gracias por el taller",
            "Les dejo la presentación",
         ),
      ).toBe(
         "[Contexto — estás en el hilo/publicación «Gracias por el taller».\nPublicación inicial: «Les dejo la presentación»]",
      );
   });
});
