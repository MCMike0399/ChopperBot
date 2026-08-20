import { describe, test, expect, vi } from "vitest";
import type { Client } from "discord.js";
import { publishPost, renderText } from "../publisher.js";
import type { Classification } from "../classifier.js";
import type { RecentPost } from "../fetcher.js";

const POST: RecentPost = {
   igPostId: "123_456",
   shortcode: "ABC123",
   caption: "irrelevant — the card is built from the classification",
   takenAtMs: Date.UTC(2026, 4, 27, 21, 37, 0), // 27 may 2026, 15:37 CDMX
   mediaType: "image",
   displayUrl: "https://example.com/cover.jpg",
};

function classification(
   overrides: Partial<Classification> = {},
): Classification {
   return {
      relevant: true,
      type: "acuerpamiento",
      title: "Acuerpamiento urgente para protesta de trabajadores sexuales en Parque Elevado",
      summary:
         "Trabajadores sexuales realizan un cierre en el Parque Elevado de CDMX.",
      when: "2026-05-27",
      where: "Parque Elevado, CDMX",
      tags: ["trabajo sexual", "cdmx"],
      ...overrides,
   };
}

describe("renderText", () => {
   test('bolds the location ("Dónde") value', () => {
      const text = renderText("yoxlas40horas", POST, classification());
      expect(text).toContain("Dónde: **Parque Elevado, CDMX**");
   });

   test('bolds the time ("Cuándo") value', () => {
      const text = renderText("yoxlas40horas", POST, classification());
      expect(text).toContain("Cuándo: **miércoles 27 de mayo**");
   });

   test('omits the "Dónde" field entirely when no location is stated', () => {
      const text = renderText(
         "yoxlas40horas",
         POST,
         classification({ where: null }),
      );
      expect(text).not.toContain("Dónde:");
   });
});

/**
 * An IG card is model output written from a caption on somebody ELSE's
 * Instagram account — attacker-controlled text this bot republishes, unread, to
 * every bound community channel. With the bot holding Administrator, a caption
 * engineered into "@everyone …" would ring the whole server. Nothing in a card
 * may ping: `parse: []`, stricter than the bot-wide users-only default.
 */
describe("publishPost — mention policy", () => {
   test("posts with every mention class denied", async () => {
      const send = vi.fn(async () => ({ id: "MSG_1" }));
      const client = {
         channels: {
            cache: new Map([["CHAN_1", { isTextBased: () => true, send }]]),
         },
      } as unknown as Client;

      const res = await publishPost(
         client,
         "CHAN_1",
         "yoxlas40horas",
         POST,
         classification({ summary: "@everyone @here vengan todxs" }),
         null,
      );

      expect(res.ok).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      const payload = send.mock.calls[0][0] as unknown as {
         content: string;
         allowedMentions: { parse: string[] };
      };
      expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(payload.content).toContain("@everyone"); // renders as text, notifies nobody
   });
});
