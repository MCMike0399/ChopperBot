/**
 * Poll tallies at finalize (2026-10-13 live review): the cached message from
 * MessageCreate never learns about votes (no poll-vote intent), so only a
 * forced fetch sees the real counts.
 */
import { describe, expect, test } from "vitest";
import type { Client } from "discord.js";
import { withPollResults, type FinalizeDeps } from "../pipeline.js";
import { chatContentOf } from "../session.js";
import type { Message } from "discord.js";

const coll = <T>(items: T[]) => ({
   values: () => items.values(),
   size: items.length,
});

function clientWithPoll(calls: unknown[]): Client {
   const answers = (counts: number[]) =>
      coll(
         ["A favor", "En contra", "abstención"].map((text, i) => ({
            text,
            voteCount: counts[i]!,
         })),
      );
   return {
      channels: {
         fetch: async () => ({
            messages: {
               fetch: async (arg: unknown) => {
                  calls.push(arg);
                  const forced =
                     typeof arg === "object" &&
                     arg !== null &&
                     (arg as { force?: boolean }).force === true;
                  // The cache still has the counts from when the poll was posted.
                  return {
                     poll: {
                        resultsFinalized: false,
                        answers: answers(forced ? [13, 0, 4] : [0, 0, 0]),
                     },
                  };
               },
            },
         }),
      },
   } as unknown as Client;
}

describe("withPollResults", () => {
   test("reads live tallies (forced fetch), not the stale cached zeros", async () => {
      const calls: unknown[] = [];
      const deps = { client: clientWithPoll(calls) } as unknown as FinalizeDeps;
      const [line] = await withPollResults(deps, "voice-1", [
         {
            t: 0,
            author: "Ana",
            content:
               "[encuesta: «Asamblea el viernes (para plan de acción\n)»]",
            messageId: "m1",
            poll: {
               question: "Asamblea el viernes (para plan de acción\n)",
               answers: ["A favor", "En contra", "abstención"],
            },
         },
      ]);
      expect(calls).toEqual([{ message: "m1", force: true }]);
      expect(line!.content).toBe(
         "[encuesta: «Asamblea el viernes (para plan de acción )» — votos al cierre: A favor (13 votos), En contra (0 votos), abstención (4 votos)]",
      );
   });
});

describe("chatContentOf poll question", () => {
   test("a line break in the question stays on one draft line", () => {
      const m = {
         content: "",
         attachments: coll([]),
         stickers: coll([]),
         mentions: { users: coll([]), members: null },
         poll: {
            question: { text: "Asamblea el viernes (para plan de acción\n)" },
            answers: coll([]),
         },
      } as unknown as Message;
      expect(chatContentOf(m)).toBe(
         "[encuesta: «Asamblea el viernes (para plan de acción )»]",
      );
   });
});
