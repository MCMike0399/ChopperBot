/**
 * 2026-09-23 audit fixes on the capture → prompt path: chat lines that used to
 * be empty or unreadable (polls, attachments, raw mentions, multi-line), and
 * the date table that stops "sábado 29" drifting into the wrong month.
 */
import { describe, test, expect } from "vitest";
import { MessageType, type Message } from "discord.js";
import { chatContentOf } from "../session.js";
import { buildMinutesSystemPrompt, renderDateTable } from "../minutes.js";

const coll = <T>(items: T[]) => ({
   values: () => items.values(),
   size: items.length,
});

function msg(over: Record<string, unknown>): Message {
   return {
      content: "",
      attachments: coll([]),
      stickers: coll([]),
      mentions: { users: coll([]), members: null },
      poll: null,
      ...over,
   } as unknown as Message;
}

describe("chatContentOf", () => {
   test("mentions become names, custom emoji become :name:, newlines fold", () => {
      const m = msg({
         content:
            "va <@123456789012345678> <:changuito:998877665544332211>\nsegunda línea",
         mentions: {
            users: coll([
               {
                  id: "123456789012345678",
                  username: "luna_x",
                  globalName: "Luna",
               },
            ]),
            members: { get: () => ({ displayName: "Lunita" }) },
         },
      });
      expect(chatContentOf(m)).toBe("va @Lunita :changuito: / segunda línea");
   });

   test("attachment-only / sticker-only / poll messages are no longer empty", () => {
      expect(
         chatContentOf(
            msg({
               attachments: coll([{ name: "a.png", contentType: "image/png" }]),
            }),
         ),
      ).toBe("[imagen]");
      expect(
         chatContentOf(
            msg({
               attachments: coll([
                  { name: "acta.pdf", contentType: "application/pdf" },
               ]),
            }),
         ),
      ).toBe("[archivo: acta.pdf]");
      expect(
         chatContentOf(msg({ stickers: coll([{ name: "bebepensando" }]) })),
      ).toBe("[sticker: bebepensando]");
      expect(
         chatContentOf(
            msg({
               poll: {
                  question: { text: "¿Cambiamos el horario?" },
                  answers: coll([]),
               },
            }),
         ),
      ).toBe("[encuesta: «¿Cambiamos el horario?»]");
   });
});

describe("chatContentOf — system notices (2026-10-13 live review)", () => {
   test("stage notices become readable timeline notes, not empty lines", () => {
      expect(chatContentOf(msg({ type: MessageType.StageSpeaker }))).toBe(
         "[subió al escenario]",
      );
      expect(chatContentOf(msg({ type: MessageType.StageRaiseHand }))).toBe(
         "[levantó la mano para hablar]",
      );
      expect(
         chatContentOf(
            msg({ type: MessageType.StageStart, content: "Asamblea" }),
         ),
      ).toBe("[abrió el escenario: «Asamblea»]");
      expect(
         chatContentOf(
            msg({ type: MessageType.StageTopic, content: "Plan de acción" }),
         ),
      ).toBe("[cambió el tema del escenario: «Plan de acción»]");
      expect(chatContentOf(msg({ type: MessageType.StageEnd }))).toBe(
         "[cerró el escenario]",
      );
   });

   test("other system notices and blank messages record nothing", () => {
      expect(
         chatContentOf(msg({ type: MessageType.UserJoin, content: "hola" })),
      ).toBe("");
      expect(
         chatContentOf(msg({ type: MessageType.ChannelPinnedMessage })),
      ).toBe("");
      expect(chatContentOf(msg({}))).toBe("");
   });

   test("replies are ordinary chat", () => {
      expect(
         chatContentOf(msg({ type: MessageType.Reply, content: "de acuerdo" })),
      ).toBe("de acuerdo");
   });
});

describe("renderDateTable", () => {
   test("resolves weekday ↔ date around the session (the 0818 «sábado 29» miss)", () => {
      const t = renderDateTable(Date.parse("2026-08-19T02:00:00Z")); // Tue 18 Aug, 20:00 CDMX
      expect(t).toMatch(/la sesión es el día mar 18 de ago/);
      expect(t).toContain("sáb 29 de ago");
      expect(t).not.toMatch(/sáb 29 de sep/);
   });
});

describe("minutes prompt carries the audit rules", () => {
   const p = buildMinutesSystemPrompt();
   test.each([
      /lista de participantes manda/,
      /conocimiento externo/,
      /tabla de fechas/,
      /Privacidad/,
      // 2026-10-13 live review: a 3 h acta dropped a whole security thread,
      // a deferred point and a spoken «me comprometo a preparar algo».
      /Cobertura completa/,
      /en qué quedó/,
      /me comprometo a/,
      /el acuerdo es posponerla/,
      /Si autorizo/,
      /leyó la propuesta de Y/,
      /no se adivina/,
   ])("%s", (re) => expect(p).toMatch(re));
});
