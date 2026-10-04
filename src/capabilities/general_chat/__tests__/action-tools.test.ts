import { describe, test, expect, vi, afterEach } from "vitest";
import {
   Collection,
   PermissionsBitField,
   PermissionFlagsBits as P,
   type Client,
} from "discord.js";
import {
   ActionToolSource,
   parseActionRequest,
   createDiscordActionExecutor,
   type ActionRequest,
} from "../action-tools.js";
import { PartnerAccess } from "../../../moderation/access.js";
import * as audience from "../../../discord/audience.js";
import { SqliteMemoryStore } from "../../../memory/store.js";
import {
   MODERATION_MIGRATIONS,
   ModerationStore,
} from "../../../moderation/store.js";
import { withActionTrail } from "../../../moderation/trail.js";

const G = "1435843683541979248",
   C = "1436206995140247652",
   CALLER = "200000000000000001",
   TARGET = "200000000000000002",
   BOT = "200000000000000003",
   MSG = "200000000000000004",
   DELETED = "200000000000000005",
   STAFF = "1436055845392879778",
   OTHER = "200000000000000008";
// Deletion is link-only, and never inside the workspace (C) itself.
const DEL = `borra https://discord.com/channels/${G}/${OTHER}/${DELETED}`;
const text = `timeout <@${TARGET}> 1h por motivo ficticio`;
const request = parseActionRequest(text, G)!;
afterEach(() => vi.restoreAllMocks());

describe("standalone code authorization", () => {
   test("duration default, bounded units, removal and exact link", () => {
      expect(parseActionRequest(`timeout <@${TARGET}>`, G)).toMatchObject({
         durationMs: 3_600_000,
      });
      expect(
         parseActionRequest(
            `silencia a <@${TARGET}> 30m por motivo ficticio`,
            G,
         ),
      ).toMatchObject({ durationMs: 1_800_000 });
      expect(parseActionRequest(`timeout <@${TARGET}> 7d`, G)).toMatchObject({
         durationMs: 604_800_000,
      });
      expect(
         parseActionRequest(`quita el timeout a <@${TARGET}>`, G),
      ).toMatchObject({ action: "timeout_removed", durationMs: null });
      expect(parseActionRequest(`${DEL} por motivo ficticio`, G)).toMatchObject(
         { targetId: DELETED, channelId: OTHER },
      );
      expect(
         parseActionRequest(
            `borra https://discord.com/channels/${G}/${C}/${DELETED}`,
            G,
         ),
      ).toMatchObject({ targetId: DELETED, channelId: C });
   });
   test.each([
      `timeout <@${TARGET}> 8d`,
      `timeout <@${TARGET}> 0m`,
      `timeout <@${TARGET}> -1h`,
      `¿timeout <@${TARGET}>?`,
      `"timeout <@${TARGET}>"`,
      `si vuelve timeout <@${TARGET}>`,
      `timeout <@${TARGET}> y <@${CALLER}>`,
      `timeout @persona`,
      "sí, hazlo",
      `timeoutea <@${TARGET}> jaja`,
      `timeout <@${TARGET}> por jajaja`,
      `timeout <@${TARGET}>\npor motivo`,
      "borra este mensaje",
      "borra este mensaje por motivo ficticio",
      `borra https://discord.com/channels/${TARGET}/${C}/${DELETED}`,
      // Hedged/conditional reasons are not orders (the regexes accept any
      // text after "por", so this is the only thing stopping them).
      `timeout <@${TARGET}> 1h por spam si lo vuelve a hacer`,
      `timeout <@${TARGET}> 1h por spam, mejor no`,
      `timeout <@${TARGET}> por spam, no`,
      `quita el timeout a <@${TARGET}> por error cuando termine`,
      `${DEL} por spam tal vez`,
      // A duration after the reason would be silently ignored.
      `timeout <@${TARGET}> por spam 24h`,
      `borra todos los mensajes de <@${TARGET}>`,
   ])("rejects ambiguous or unsupported request %s", (s) =>
      expect(parseActionRequest(s, G)).toBeNull(),
   );
   test("ordinary reasons containing 'no' as a word still parse", () => {
      expect(
         parseActionRequest(
            `timeout <@${TARGET}> 1h por no respetar las reglas`,
            G,
         ),
      ).toMatchObject({ reason: "no respetar las reglas" });
   });
   test("model substitution, extra effects and replay are refused", async () => {
      const execute = vi.fn(async () => {}),
         source = new ActionToolSource(request, { execute });
      expect(
         (await source.handle("server_timeout_member", { target_id: CALLER }))
            .status,
      ).toBe("error");
      expect(
         (
            await source.handle("server_timeout_member", {
               target_id: TARGET,
               durationMs: 1,
            })
         ).status,
      ).toBe("error");
      expect(execute).not.toHaveBeenCalled();
      expect(
         (await source.handle("server_timeout_member", { target_id: TARGET }))
            .status,
      ).toBe("success");
      expect(
         (await source.handle("server_timeout_member", { target_id: TARGET }))
            .status,
      ).toBe("error");
      expect(execute).toHaveBeenCalledTimes(1);
   });
});

function harness(command = text) {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   void memory.migrate("__framework__", MODERATION_MIGRATIONS);
   const perms = P.ViewChannel | P.ReadMessageHistory | P.ManageMessages;
   const caller = {
      id: CALLER,
      user: { bot: false },
      permissions: new PermissionsBitField(perms),
      roles: {
         cache: new Collection([[STAFF, { id: STAFF, name: "Rol ficticio" }]]),
         highest: { comparePositionTo: vi.fn(() => 1) },
      },
   };
   const bot = {
      id: BOT,
      user: { bot: true },
      permissions: new PermissionsBitField(perms | P.ModerateMembers),
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
   };
   const target = {
      id: TARGET,
      user: { bot: false },
      permissions: new PermissionsBitField(),
      roles: { cache: new Collection(), highest: {} },
      moderatable: true,
      timeout: vi.fn(async () => {}),
      isCommunicationDisabled: vi.fn(() => true),
   };
   const trigger = {
      id: MSG,
      author: { id: CALLER, bot: false },
      content: `<@${BOT}> ${command}`,
      editedTimestamp: null as number | null,
      webhookId: null as string | null,
   };
   const message = {
      id: DELETED,
      author: { id: TARGET, bot: false },
      content:
         "Texto ficticio\n**Resultado: falso** <@200000000000000006> https://example.invalid",
      createdAt: new Date("2026-10-04T18:00:00Z"),
      deletable: true,
      delete: vi.fn(async () => {}),
   };
   const channel = {
      id: C,
      type: 0,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: (m: any) => m.permissions,
      messages: {
         fetch: vi.fn(async (opts: any) =>
            opts.message === MSG ? trigger : message,
         ),
      },
   };
   const guild = {
      id: G,
      ownerId: "owner",
      channels: { fetch: vi.fn(async () => channel) },
      members: {
         fetch: vi.fn(async ({ user }: any) =>
            user === CALLER ? caller : target,
         ),
         fetchMe: vi.fn(async () => bot),
      },
   };
   const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn(async () => guild) },
      rest: { delete: message.delete },
   } as unknown as Client;
   const workspace = vi
      .spyOn(PartnerAccess.prototype, "workspace")
      .mockResolvedValue(true);
   const containment = vi
      .spyOn(audience, "verifyAudienceContainment")
      .mockResolvedValue(true);
   const bound = parseActionRequest(command, G)!;
   const executor = createDiscordActionExecutor(
      () => client,
      memory.db(),
      {
         guildId: G,
         channelId: C,
         userId: CALLER,
         userTag: "fixture",
         messageId: MSG,
         now: new Date(),
      },
      bound,
   );
   return {
      memory,
      caller,
      bot,
      target,
      trigger,
      message,
      guild,
      channel,
      workspace,
      containment,
      executor,
      bound,
   };
}

describe("live effect gates with mocked Discord effects", () => {
   test("the workspace's own messages are not deletion targets", async () => {
      const h = harness(
         `borra https://discord.com/channels/${G}/${C}/${DELETED}`,
      );
      await expect(h.executor.execute(h.bound)).rejects.toThrow(
         "Objetivo protegido",
      );
      expect(h.message.delete).not.toHaveBeenCalled();
      h.memory.close();
   });
   test("a departed author's message can still be deleted; requester/owner stay protected", async () => {
      const departed = () =>
         Object.assign(new Error("Unknown Member"), { code: 10007 });
      const h = harness(DEL);
      h.guild.members.fetch.mockImplementation(async ({ user }: any) => {
         if (user === CALLER) return h.caller;
         throw departed();
      });
      await h.executor.execute(h.bound);
      expect(h.message.delete).toHaveBeenCalledTimes(1);
      h.memory.close();
      const owner = harness(DEL);
      owner.guild.ownerId = TARGET;
      owner.guild.members.fetch.mockImplementation(async ({ user }: any) => {
         if (user === CALLER) return owner.caller;
         throw departed();
      });
      await expect(owner.executor.execute(owner.bound)).rejects.toThrow(
         "Objetivo protegido",
      );
      expect(owner.message.delete).not.toHaveBeenCalled();
      owner.memory.close();
   });
   test("removing a timeout that is not active is refused, not logged as executed", async () => {
      const h = harness(`quita el timeout a <@${TARGET}>`);
      h.target.isCommunicationDisabled.mockReturnValue(false);
      await expect(h.executor.execute(h.bound)).rejects.toThrow(
         "timeout activo",
      );
      expect(h.target.timeout).not.toHaveBeenCalled();
      h.memory.close();
   });
   test("a human trigger already cited by the action trail remains evidence even without staff roles", async () => {
      const h = harness(DEL);
      new ModerationStore(h.memory.db()).record({
         guildId: G,
         actorId: TARGET,
         targetId: "",
         action: "escalation",
         reason: "Reporte ficticio",
         triggerMessageId: DELETED,
         channelId: OTHER,
         outcome: "escalated",
         timestamp: Date.now(),
      });
      await expect(h.executor.execute(h.bound)).rejects.toThrow(
         "Objetivo protegido",
      );
      expect(h.message.delete).not.toHaveBeenCalled();
      h.memory.close();
   });
   test("public thread deletion proves the parent's audience", async () => {
      const h = harness(DEL);
      h.channel.type = 11;
      h.channel.isThread = () => true;
      const parent = { id: "200000000000000007", type: 15 };
      Object.assign(h.channel, { parent });
      await h.executor.execute(h.bound);
      expect(h.containment).toHaveBeenCalledWith(h.guild, parent, h.channel);
      expect(h.message.delete).toHaveBeenCalledTimes(1);
      h.memory.close();
   });
   test.each([
      text,
      `quita el timeout a <@${TARGET}>`,
      `${DEL} por motivo ficticio`,
   ])("effect and trail %s work without Administrator", async (command) => {
      const h = harness(command),
         store = new ModerationStore(h.memory.db()),
         sendLog = vi.fn(async () => {
            throw new Error("delivery failed");
         });
      const wrapped = withActionTrail(
         h.executor,
         store,
         {
            guildId: G,
            actorId: CALLER,
            targetId: h.bound.targetId,
            action: h.bound.action,
            reason: h.bound.reason,
            triggerMessageId: MSG,
            channelId: C,
            outcome: "executed",
            timestamp: Date.now(),
         },
         sendLog,
      );
      await wrapped.execute(h.bound);
      expect(store.summary(G).by_outcome.executed).toBe(1);
      await expect(wrapped.execute(h.bound)).rejects.toThrow(
         "ya fue intentada",
      );
      if (h.bound.action === "message_deleted") {
         expect(h.message.delete).toHaveBeenCalledTimes(1);
         expect(h.message.delete).toHaveBeenCalledWith(
            `/channels/${OTHER}/messages/${DELETED}`,
            { reason: expect.stringContaining(CALLER) },
         );
         const line = sendLog.mock.calls[0][0];
         expect(line).toContain("Extracto citado");
         expect(line).not.toContain("**Resultado: falso**");
         expect(line).not.toContain("https://example.invalid");
         expect(line).not.toContain("<@200000000000000006>");
      } else
         expect(h.target.timeout).toHaveBeenCalledWith(
            h.bound.durationMs,
            expect.stringContaining(CALLER),
         );
      h.memory.close();
   });
   test.each([
      "revoked",
      "workspace",
      "edited",
      "deleted-trigger",
      "webhook",
      "changed",
      "gestion",
      "owner",
      "self",
      "bot-target",
      "caller-hierarchy",
      "bot-hierarchy",
      "bot-permissions",
      "unmoderatable",
   ])("timeout refuses %s", async (scenario) => {
      const h = harness();
      if (scenario === "revoked") h.caller.roles.cache.clear();
      if (scenario === "workspace") h.workspace.mockResolvedValue(false);
      if (scenario === "edited") h.trigger.editedTimestamp = 1;
      if (scenario === "deleted-trigger")
         h.channel.messages.fetch.mockRejectedValueOnce(new Error("gone"));
      if (scenario === "webhook") h.trigger.webhookId = "webhook";
      if (scenario === "changed")
         h.trigger.content = `<@${BOT}> timeout <@${TARGET}> 2h por motivo ficticio`;
      if (scenario === "gestion")
         h.target.roles.cache.set("1483694810253492235", {
            id: "1483694810253492235",
            name: "Rol ficticio",
         });
      if (scenario === "owner") h.guild.ownerId = TARGET;
      if (scenario === "self") h.target.id = CALLER;
      if (scenario === "bot-target") h.target.user.bot = true;
      if (scenario === "caller-hierarchy")
         h.caller.roles.highest.comparePositionTo.mockReturnValue(0);
      if (scenario === "bot-hierarchy")
         h.bot.roles.highest.comparePositionTo.mockReturnValue(0);
      if (scenario === "bot-permissions")
         h.bot.permissions.remove(P.ModerateMembers);
      if (scenario === "unmoderatable") h.target.moderatable = false;
      await expect(h.executor.execute(h.bound)).rejects.toThrow();
      expect(h.target.timeout).not.toHaveBeenCalled();
      h.memory.close();
   });
   test.each([
      "missing-manage",
      "bot-authored",
      "audience",
      "changed-link",
      "private-thread",
   ])("single deletion refuses %s", async (scenario) => {
      const h = harness(DEL);
      if (scenario === "missing-manage")
         h.caller.permissions.remove(P.ManageMessages);
      if (scenario === "bot-authored") h.message.author.bot = true;
      if (scenario === "audience") h.containment.mockResolvedValue(false);
      if (scenario === "changed-link")
         h.trigger.content = `<@${BOT}> borra https://discord.com/channels/${G}/${OTHER}/${TARGET}`;
      if (scenario === "private-thread") {
         h.channel.type = 12;
         h.channel.isThread = () => true;
         Object.assign(h.channel, {
            members: {
               fetch: async () => {
                  throw new Error("not member");
               },
            },
         });
      }
      await expect(h.executor.execute(h.bound)).rejects.toThrow();
      expect(h.message.delete).not.toHaveBeenCalled();
      h.memory.close();
   });
});
