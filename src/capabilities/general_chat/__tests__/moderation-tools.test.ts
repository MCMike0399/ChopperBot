import { describe, test, expect, vi } from "vitest";
import {
   Collection,
   PermissionFlagsBits,
   PermissionsBitField,
   type Client,
} from "discord.js";
import { DEFAULT_MOD_ROLES } from "../../../discord/mod-roles.js";
import {
   BanToolSource,
   createDiscordBanExecutor,
   parseBanRequest,
} from "../moderation-tools.js";

const TARGET = "200000000000000001";
const CALLER = "200000000000000002";
const BOT = "200000000000000003";
const GESTION = "1483694810253492235";
const REQUEST = { targetId: TARGET, reason: "acoso" };

describe("current explicit ban request", () => {
   test("accepts standalone Spanish/English ban requests with one real mention", () => {
      expect(parseBanRequest(`banea a <@${TARGET}> por acoso`)).toEqual(
         REQUEST,
      );
      expect(parseBanRequest(`por favor, ban <@!${TARGET}>`)).toEqual({
         targetId: TARGET,
         reason: "Solicitud explícita de moderación.",
      });
   });
   test.each([
      `¿banea a <@${TARGET}>?`,
      `si vuelve, banea a <@${TARGET}>`,
      `"banea a <@${TARGET}>"`,
      `me dijeron banea a <@${TARGET}>`,
      `revisa si debemos banear a <@${TARGET}>`,
      `no banea a <@${TARGET}>`,
      `banea a <@${TARGET}> y <@${CALLER}>`,
      `banea a <@&${TARGET}>`,
      `banea a <@${TARGET}>\npor acoso`,
      "sí, hazlo",
      "ban @apodo",
      `banea a <@${TARGET}> por acoso si lo vuelve a hacer`,
      `banea a <@${TARGET}> por acoso, mejor no`,
      `banea a <@${TARGET}> por acoso tal vez`,
   ])(
      "does not authorize quoted/conditional/ambiguous/implicit actions: %s",
      (text) => {
         expect(parseBanRequest(text)).toBeNull();
      },
   );

   test("model cannot switch target, add deletion, or replay an attempted write", async () => {
      const execute = vi.fn(async () => {});
      const source = new BanToolSource(REQUEST, { execute });
      expect(
         (await source.handle("server_ban_member", { user_id: CALLER })).status,
      ).toBe("error");
      expect(
         (
            await source.handle("server_ban_member", {
               user_id: TARGET,
               delete_messages: true,
            })
         ).status,
      ).toBe("error");
      expect(execute).not.toHaveBeenCalled();
      expect(
         (await source.handle("server_ban_member", { user_id: TARGET })).status,
      ).toBe("success");
      expect(
         (await source.handle("server_ban_member", { user_id: TARGET })).status,
      ).toBe("error");
      expect(execute).toHaveBeenCalledTimes(1);
   });
});

function harness() {
   const caller = {
      id: CALLER,
      permissions: new PermissionsBitField(),
      roles: {
         cache: new Collection([
            [
               DEFAULT_MOD_ROLES[0],
               { id: DEFAULT_MOD_ROLES[0], name: "Moderación" },
            ],
         ]),
         highest: { comparePositionTo: vi.fn(() => 1) },
      },
   };
   const target = {
      id: TARGET,
      user: { bot: false },
      permissions: new PermissionsBitField(),
      roles: { cache: new Collection(), highest: {} },
      bannable: true,
   };
   const bot = {
      id: BOT,
      permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
   };
   const trigger = {
      author: { id: CALLER },
      content: `<@${BOT}> banea a <@${TARGET}> por acoso`,
   };
   const ban = vi.fn(async () => {});
   const channel = {
      isTextBased: () => true,
      permissionsFor: () =>
         new PermissionsBitField(PermissionFlagsBits.Administrator),
      messages: { fetch: vi.fn(async () => trigger) },
   };
   const guild = {
      ownerId: "owner",
      channels: { fetch: vi.fn(async () => channel) },
      members: {
         fetch: vi.fn(async ({ user }: { user: string }) =>
            user === CALLER ? caller : target,
         ),
         fetchMe: vi.fn(async () => bot),
         ban,
      },
   };
   const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn(async () => guild) },
   } as unknown as Client;
   const executor = createDiscordBanExecutor(
      () => client,
      "guild",
      CALLER,
      "channel",
      "message",
      null,
      REQUEST,
   );
   return { caller, target, bot, trigger, channel, guild, ban, executor };
}

describe("ban effect authorization", () => {
   test("valid current mod request bans exact target, leaves history, records moderator in audit reason", async () => {
      const h = harness();
      await h.executor.execute(REQUEST);
      expect(h.ban).toHaveBeenCalledWith(TARGET, {
         deleteMessageSeconds: 0,
         reason: expect.stringContaining(CALLER),
      });
      expect(h.channel.messages.fetch).toHaveBeenCalledWith(
         expect.objectContaining({ force: true, cache: false }),
      );
   });

   test.each([
      "revoked-role",
      "gestion-caller",
      "edited-request",
      "deleted-request",
      "protected-mod",
      "protected-gestion",
      "owner",
      "self",
      "hierarchy",
      "bot-permissions",
      "unbannable",
   ])("refuses %s before a ban", async (scenario) => {
      const h = harness();
      if (scenario === "revoked-role") h.caller.roles.cache.clear();
      if (scenario === "gestion-caller") {
         h.caller.roles.cache.clear();
         h.caller.roles.cache.set(GESTION, { id: GESTION, name: "Gestión" });
      }
      if (scenario === "edited-request")
         h.trigger.content = `revisa a <@${TARGET}>`;
      if (scenario === "deleted-request")
         h.channel.messages.fetch.mockRejectedValueOnce(new Error("deleted"));
      if (scenario === "protected-mod")
         h.target.permissions.add(PermissionFlagsBits.Administrator);
      if (scenario === "protected-gestion")
         h.target.roles.cache.set(GESTION, { id: GESTION, name: "Gestión" });
      if (scenario === "owner") h.guild.ownerId = TARGET;
      if (scenario === "self") h.target.id = CALLER;
      if (scenario === "hierarchy")
         h.caller.roles.highest.comparePositionTo.mockReturnValue(0);
      if (scenario === "bot-permissions")
         h.bot.permissions = new PermissionsBitField();
      if (scenario === "unbannable") h.target.bannable = false;
      await expect(h.executor.execute(REQUEST)).rejects.toThrow(
         scenario === "revoked-role" || scenario === "gestion-caller"
            ? "ya no tiene autorización"
            : scenario === "edited-request"
              ? "La solicitud cambió"
              : scenario === "deleted-request"
                ? "deleted"
                : "Objetivo protegido",
      );
      expect(h.ban).not.toHaveBeenCalled();
   });
});
