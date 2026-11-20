import { describe, test, expect, vi } from "vitest";
import type { Message } from "discord.js";
import { canDeleteMessage, deleteMaliciousMessage } from "../actions.js";

/** Minimal Message surface used by the delete helper. */
function fakeMessage(opts: {
   inGuild?: boolean;
   me?: unknown;
   perms?: { has: (bit: bigint) => boolean } | null;
   deleteImpl?: () => Promise<unknown>;
}) {
   const del = vi.fn(opts.deleteImpl ?? (async () => undefined));
   const message = {
      id: "m-1",
      channelId: "c-1",
      guildId: "g-1",
      author: { id: "u-1" },
      inGuild: () => opts.inGuild ?? true,
      guild: {
         members: { me: opts.me === undefined ? { id: "bot" } : opts.me },
      },
      channel: { permissionsFor: () => opts.perms ?? null },
      delete: del,
   };
   return { message: message as unknown as Message, del };
}

describe("deleteMaliciousMessage", () => {
   test("deletes the upload when the bot has ManageMessages", async () => {
      const { message, del } = fakeMessage({
         perms: { has: () => true },
      });
      const ok = await deleteMaliciousMessage(message, {
         enabled: true,
         fileName: "bad.exe",
      });
      expect(ok).toBe(true);
      expect(del).toHaveBeenCalledTimes(1);
   });

   test("never deletes when the operator turned it off", async () => {
      const { message, del } = fakeMessage({ perms: { has: () => true } });
      const ok = await deleteMaliciousMessage(message, {
         enabled: false,
         fileName: "bad.exe",
      });
      expect(ok).toBe(false);
      expect(del).not.toHaveBeenCalled();
   });

   test("refuses without ManageMessages instead of trying", async () => {
      const { message, del } = fakeMessage({ perms: { has: () => false } });
      const ok = await deleteMaliciousMessage(message, {
         enabled: true,
         fileName: "bad.exe",
      });
      expect(ok).toBe(false);
      expect(del).not.toHaveBeenCalled();
   });

   test("a Discord failure is swallowed and reported as false", async () => {
      const { message } = fakeMessage({
         perms: { has: () => true },
         deleteImpl: async () => {
            throw new Error("Unknown Message");
         },
      });
      await expect(
         deleteMaliciousMessage(message, {
            enabled: true,
            fileName: "bad.exe",
         }),
      ).resolves.toBe(false);
   });

   test("unresolvable permissions don't block the attempt", async () => {
      expect(canDeleteMessage(fakeMessage({ perms: null }).message)).toBe(true);
      expect(canDeleteMessage(fakeMessage({ inGuild: false }).message)).toBe(
         true,
      );
   });
});
