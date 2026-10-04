import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "discord.js";
import {
   ReactionTurnPresenter,
   WorkshopTurnPresenter,
   type PresentableMessage,
} from "../presenter.js";

/**
 * Fake message capturing every user-visible operation in order: reactions,
 * replies, channel sends, edits, deletes, typing. The op log is what each
 * conversation style promises the user — the contract under test.
 */
function fakeMessage() {
   const ops: string[] = [];
   const sends: Array<{ content: string; allowedMentions?: unknown }> = [];
   const replies: Array<{ content: string; allowedMentions?: unknown }> = [];
   let typingCount = 0;
   const mkPosted = (): Message =>
      ({
         edit: vi.fn(async (text: string) => {
            ops.push(`edit:${text}`);
            return mkPosted();
         }),
         delete: vi.fn(async () => {
            ops.push("delete");
         }),
      }) as unknown as Message;
   const reaction = {
      users: { remove: vi.fn(async () => void ops.push("unreact")) },
   };
   const message = {
      react: vi.fn(async (emoji: string) => {
         ops.push(`react:${emoji}`);
         return reaction;
      }),
      author: { id: "200000000000000001" },
      reply: vi.fn(
         async (
            options: string | { content: string; allowedMentions?: unknown },
         ) => {
            const content =
               typeof options === "string" ? options : options.content;
            replies.push({
               content,
               allowedMentions:
                  typeof options === "string"
                     ? undefined
                     : options.allowedMentions,
            });
            ops.push(`reply:${content}`);
            return mkPosted();
         },
      ),
      reactions: { cache: { get: () => undefined } },
      channel: {
         send: vi.fn(
            async (
               options: string | { content: string; allowedMentions?: unknown },
            ) => {
               const content =
                  typeof options === "string" ? options : options.content;
               sends.push({
                  content,
                  allowedMentions:
                     typeof options === "string"
                        ? undefined
                        : options.allowedMentions,
               });
               ops.push(`send:${content}`);
               return mkPosted();
            },
         ),
         sendTyping: vi.fn(async () => {
            typingCount += 1;
         }),
      },
   };
   return {
      ops,
      sends,
      replies,
      message: message as unknown as PresentableMessage,
      typing: () => typingCount,
   };
}

/** Let the StatusReactor's internal promise chain drain. */
const settle = async (): Promise<void> => {
   for (let i = 0; i < 25; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ReactionTurnPresenter (public conversation style)", () => {
   test("never posts a status message: only reactions + typing + the reply", async () => {
      const { ops, message } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      p.onQueued();
      await p.begin();
      p.onPhase("thinking");
      p.onPhase("tool", "calendar_create_event");
      const anchor = await p.deliver(["hola", "sigo aquí"]);
      await settle();

      expect(anchor).not.toBeNull();
      expect(
         ops.filter((o) => o.startsWith("send:") && o.includes("-#")),
      ).toHaveLength(0);
      expect(ops).toContain("reply:hola");
      expect(ops).toContain("send:sigo aquí");
   });

   test("a public reply notifies only the asker, never other members it names", async () => {
      const { message, replies, sends } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      await p.deliver([
         "Hablaban <@200000000000000002> y <@200000000000000003>.",
         "Y también <@200000000000000004>.",
      ]);
      await settle();
      const asker = {
         parse: [],
         users: ["200000000000000001"],
         roles: [],
      };
      expect(replies[0].allowedMentions).toEqual({
         ...asker,
         repliedUser: true,
      });
      expect(sends[0].allowedMentions).toEqual({
         ...asker,
         repliedUser: false,
      });
   });

   test("keeps typing alive until the reply posts, then stops", async () => {
      const { message, typing } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      const before = typing();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(typing()).toBeGreaterThan(before); // heartbeat while working
      await p.deliver(["listo"]);
      const after = typing();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(typing()).toBe(after); // silent once delivered
   });

   test("fail replies with the error text and leaves the ❌ reaction", async () => {
      const { ops, message } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      await p.fail("se rompió");
      await settle();
      expect(ops).toContain("reply:se rompió");
      expect(ops).toContain("react:❌");
   });

   test("empty reply cleans up silently", async () => {
      const { ops, message } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      const anchor = await p.deliver([]);
      expect(anchor).toBeNull();
      expect(ops.filter((o) => o.startsWith("reply:"))).toHaveLength(0);
      expect(ops.filter((o) => o.startsWith("send:"))).toHaveLength(0);
   });

   test("falls back to channel.send when the reply target is gone", async () => {
      const { ops, message } = fakeMessage();
      (message as unknown as { reply: unknown }).reply = vi.fn(async () => {
         throw new Error("Unknown Message");
      });
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      const anchor = await p.deliver(["respuesta"]);
      expect(anchor).not.toBeNull();
      expect(ops).toContain("send:respuesta");
   });

   /**
    * A message-level `allowedMentions` REPLACES the client default rather than
    * merging with it, so these sends must repeat the users-only allowlist. They
    * used to pass `{ repliedUser: false }` alone, which handed @everyone and
    * role pings back to whatever the model wrote.
    */
   test("an empty failure text marks ❌ without posting (suppressed repeat)", async () => {
      const { ops, message } = fakeMessage();
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      await p.fail("");
      await settle();
      expect(ops.filter((o) => o.startsWith("reply:"))).toHaveLength(0);
      expect(ops).toContain("react:❌");
   });

   test("every channel send carries the asker-only mention policy", async () => {
      const { sends, message } = fakeMessage();
      (message as unknown as { reply: unknown }).reply = vi.fn(async () => {
         throw new Error("Unknown Message"); // force the fallback path too
      });
      const p = new ReactionTurnPresenter(message, "bot");
      await p.begin();
      await p.deliver(["@everyone hola", "segunda parte"]);

      expect(sends).toHaveLength(2);
      for (const s of sends) {
         // No @everyone/role parse, and only the asker can be notified.
         expect(s.allowedMentions).toEqual({
            parse: [],
            users: ["200000000000000001"],
            roles: [],
            repliedUser: false,
         });
      }
   });
});

describe("WorkshopTurnPresenter (taller conversation style)", () => {
   test("posts ONE status line, edits it through phases, morphs it into the reply", async () => {
      const { ops, message } = fakeMessage();
      const p = new WorkshopTurnPresenter(message, "bot");
      await p.begin();
      expect(ops.some((o) => o.startsWith("send:-# 🤔"))).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000); // past the edit throttle
      p.onPhase("tool", "workshop_run_python");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
         ops.some((o) => o.startsWith("edit:-# 🐍 Ejecutando código")),
      ).toBe(true);

      await p.deliver(["aquí está tu archivo", "y el detalle"]);
      expect(ops.some((o) => o === "edit:aquí está tu archivo")).toBe(true);
      expect(ops).toContain("send:y el detalle");
   });

   test("fail before begin() replies plainly (queue-busy path)", async () => {
      const { ops, message } = fakeMessage();
      const p = new WorkshopTurnPresenter(message, "bot");
      p.onQueued();
      await p.fail("cola llena");
      await settle();
      expect(ops).toContain("reply:cola llena");
      expect(ops).toContain("react:❌");
   });

   test("fail after begin() morphs the status line into the error", async () => {
      const { ops, message } = fakeMessage();
      const p = new WorkshopTurnPresenter(message, "bot");
      await p.begin();
      await p.fail("error del turno");
      expect(ops).toContain("edit:error del turno");
      expect(ops.filter((o) => o.startsWith("reply:"))).toHaveLength(0);
   });

   test("discard removes the status line without posting anything", async () => {
      const { ops, message } = fakeMessage();
      const p = new WorkshopTurnPresenter(message, "bot");
      await p.begin();
      await p.discard();
      expect(ops).toContain("delete");
      expect(ops.filter((o) => o.startsWith("reply:"))).toHaveLength(0);
   });
});
