import { describe, test, expect, vi } from "vitest";
import {
   Collection,
   PermissionFlagsBits as P,
   PermissionsBitField,
   type Client,
} from "discord.js";
import { SqliteMemoryStore } from "../../memory/store.js";
import {
   MODERATION_MIGRATIONS,
   ModerationStore,
   MODERATION_GUILD_ID as G,
   DEFAULT_MODERATION_CHANNEL_ID as MOD,
} from "../store.js";
import {
   audienceContained,
   verifyAudienceContainment,
   type AudienceSnapshot,
} from "../../discord/audience.js";
import { PartnerAccess } from "../access.js";
import { BotSelfKnowledge } from "../self-knowledge.js";
import { withBanTrail, sendModerationLine } from "../trail.js";
import {
   EscalationToolSource,
   escalationCandidate,
   renderEscalation,
   sanitizeEscalationSummary,
} from "../../capabilities/general_chat/escalation-tools.js";
import { AuditLogToolSource } from "../../capabilities/general_chat/audit-tools.js";
import { GeneralChatCapability } from "../../capabilities/general_chat/capability.js";
import { CapabilityRegistry } from "../../capabilities/registry.js";
import { buildRouter } from "../../capabilities/routing.js";
import { CALENDAR_MIGRATIONS } from "../../capabilities/calendar/store.js";
import { createDiscordBanExecutor } from "../../capabilities/general_chat/moderation-tools.js";
import { ConfigModerationSource } from "../../capabilities/configuration/moderation-source.js";
import type { CapabilityTurnContext } from "../../capabilities/capability.js";

const STAFF = "1436055845392879778",
   GESTION = "1483694810253492235",
   COMMUNITY = "1436225305898389604";
const REPORTER = "1550000000000000001",
   TARGET = "1550000000000000002",
   MSG = "1550000000000000003",
   PUBLIC = "1437237844966899742";
const NOW = Date.parse("2026-10-04T19:00:00Z");
const VIEW_READ = P.ViewChannel | P.ReadMessageHistory;

test.each(["alta", "urgente"] as const)(
   "D1 %s uses the configured single role only when urgent",
   async (severity) => {
      const h = harness();
      h.store.setSettings(G, MOD, [STAFF]);
      h.guild.members.fetch.mockImplementation(async () => h.reporter as any);
      const result = await new EscalationToolSource(
         () => h.client,
         h.store,
         h.context,
      ).handle("server_escalate_report", {
         summary: "Reporte ficticio de amenazas",
         severity,
         target_id: TARGET,
      });
      expect(result.status).toBe("success");
      expect(h.mod.send.mock.calls[0][0].allowedMentions).toEqual({
         parse: [],
         users: [],
         roles: severity === "urgente" ? [STAFF] : [],
         repliedUser: false,
      });
      expect(
         h.mod.send.mock.calls[0][0].content.startsWith(`<@&${STAFF}>`),
      ).toBe(severity === "urgente");
      expect(
         h.store.summary(G).by_outcome[
            severity === "urgente" ? "escalated:ping_sent" : "escalated"
         ],
      ).toBe(1);
      h.memory.close();
   },
);

test("Phase 3 tools only attach to the current verified workspace moderator request", async () => {
   const h = harness(),
      cap = new GeneralChatCapability(),
      registry = new CapabilityRegistry();
   await cap.init({
      memory: { db: () => h.memory.db(), migrate: async () => {} },
      projectRoot: process.cwd(),
      getDiscordClient: () => h.client,
      getRegistry: () => registry,
      getRouter: () => buildRouter(new Map()),
   });
   const requestText = `timeout <@${TARGET}> 1h por motivo ficticio`;
   const turn = await cap.buildTurn({
      ...h.context,
      channelId: MOD,
      requestText,
   });
   expect(turn.tools.tools.map((t) => t.name)).toContain(
      "server_timeout_member",
   );
   expect(turn.effort).toBe("high");
   expect(turn.system).toContain(`server_timeout_member para el ID ${TARGET}`);
   const publicTurn = await cap.buildTurn({
      ...h.context,
      requestText: `timeoutea a <@${TARGET}> jaja`,
   });
   expect(publicTurn.tools.tools.map((t) => t.name)).not.toContain(
      "server_timeout_member",
   );
   expect(publicTurn.effort).toBe("low");
   h.member.roles.cache.clear();
   h.member.roles.cache.set(GESTION, h.guild.roles.cache.get(GESTION)!);
   const gestionTurn = await cap.buildTurn({
      ...h.context,
      channelId: MOD,
      requestText,
      memberRoles: [{ id: GESTION, name: "Rol ficticio" }],
      isAdministrator: false,
   });
   expect(gestionTurn.tools.tools.map((t) => t.name)).not.toContain(
      "server_timeout_member",
   );
   expect(gestionTurn.system).not.toContain("Mis roles reales:");
   h.memory.close();
});

test("public forum audience can contain evidence, while a private thread never uses its parent", async () => {
   const h = harness();
   h.community.type = 15;
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.community as any,
         h.mod as any,
      ),
   ).toBe(true);
   h.community.type = 12;
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.community as any,
         h.mod as any,
      ),
   ).toBe(false);
   h.memory.close();
});
const snap = (
   id: string,
   overwrites: AudienceSnapshot["overwrites"] = [],
): AudienceSnapshot => ({ id, overwrites });
const ow = (id: string, allow: bigint, deny = 0n, type = 0) => ({
   id,
   type,
   allow,
   deny,
});
const roles = [
   { id: G, permissions: P.ReadMessageHistory },
   { id: STAFF, permissions: P.ViewAuditLog },
   { id: GESTION, permissions: 0n },
];
const staffOnly = (id: string) =>
   snap(id, [ow(G, 0n, P.ViewChannel), ow(STAFF, VIEW_READ)]);

function harness() {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   void memory.migrate("__framework__", MODERATION_MIGRATIONS);
   void memory.migrate("calendar", CALENDAR_MIGRATIONS);
   const store = new ModerationStore(memory.db());
   const roleCache = new Collection(
      roles.map((r) => [
         r.id,
         {
            id: r.id,
            name: r.id === STAFF ? "Rol de prueba" : "Otro rol de prueba",
            permissions: new PermissionsBitField(r.permissions),
         },
      ]),
   );
   roleCache.set(COMMUNITY, {
      id: COMMUNITY,
      name: "Comunidad de prueba",
      permissions: new PermissionsBitField(VIEW_READ),
   });
   const member = {
      id: REPORTER,
      user: { bot: false },
      roles: { cache: new Collection([[STAFF, roleCache.get(STAFF)!]]) },
      permissions: new PermissionsBitField(P.ViewAuditLog),
   };
   const reporter = {
      ...member,
      roles: {
         cache: new Collection([[COMMUNITY, roleCache.get(COMMUNITY)!]]),
      },
      permissions: new PermissionsBitField(VIEW_READ),
   };
   const bot = {
      id: "1498358942257123488",
      roles: { cache: new Collection([[STAFF, roleCache.get(STAFF)!]]) },
      permissions: new PermissionsBitField(P.Administrator),
   };
   const messages = new Collection([
      [
         MSG,
         {
            id: MSG,
            content: "Evidencia ficticia para pruebas",
            author: { id: TARGET, bot: false, username: "Persona ficticia" },
            createdTimestamp: NOW - 1000,
            attachments: new Collection(),
            mentions: { users: new Collection() },
            embeds: [],
         },
      ],
   ]);
   const makeChannel = (s: AudienceSnapshot) => {
      const c = {
         id: s.id,
         guildId: G,
         type: 0,
         name: "canal-ficticio",
         isTextBased: () => true,
         isThread: () => false,
         permissionOverwrites: {
            cache: new Collection(
               s.overwrites.map((o) => [
                  o.id,
                  {
                     ...o,
                     allow: new PermissionsBitField(o.allow),
                     deny: new PermissionsBitField(o.deny),
                  },
               ]),
            ),
         },
         permissionsFor(who: any) {
            if (who === bot) return bot.permissions;
            let bits = P.ReadMessageHistory;
            const ids = who.roles ? [...who.roles.cache.keys()] : [who.id];
            for (const id of ids)
               bits |= roleCache.get(id)?.permissions.bitfield ?? 0n;
            for (const id of [G, ...ids]) {
               const o = c.permissionOverwrites.cache.get(id);
               if (o) bits = (bits & ~o.deny.bitfield) | o.allow.bitfield;
            }
            return new PermissionsBitField(bits);
         },
         messages: {
            fetch: vi.fn(async (a: any) =>
               a.message
                  ? {
                       id: MSG,
                       author: { id: REPORTER, bot: false },
                       content: `Me amenaza <@${TARGET}> y publica mi dirección`,
                       editedTimestamp: null,
                       webhookId: null,
                    }
                  : messages,
            ),
         },
         send: vi.fn(async () => ({ id: "1550000000000000008" })),
      };
      return c;
   };
   const mod = makeChannel(staffOnly(MOD)),
      source = makeChannel(staffOnly("1436112159829397564"));
   const community = makeChannel(
      snap(PUBLIC, [
         ow(G, 0n, P.ViewChannel),
         ow(STAFF, VIEW_READ),
         ow(COMMUNITY, VIEW_READ),
      ]),
   );
   const channels = new Collection([
      [MOD, mod],
      [source.id, source],
      [PUBLIC, community],
   ]);
   const guild = {
      id: G,
      ownerId: "1550000000000000009",
      roles: {
         cache: roleCache,
         everyone: roleCache.get(G)!,
         fetch: vi.fn(async () => roleCache),
      },
      members: {
         me: bot,
         fetch: vi.fn(async () => member),
         fetchMe: vi.fn(async () => bot),
      },
      channels: {
         cache: channels,
         fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
      },
      fetchAuditLogs: vi.fn(async () => ({
         entries: new Collection([
            [
               MSG,
               {
                  id: MSG,
                  action: 24,
                  executorId: REPORTER,
                  targetId: TARGET,
                  target: { id: TARGET },
                  createdTimestamp: NOW,
                  reason: "Motivo ficticio",
                  changes: [],
               },
            ],
         ]),
      })),
   };
   const client = {
      user: { id: bot.id },
      guilds: {
         cache: new Collection([[G, guild]]),
         fetch: vi.fn(async () => guild),
      },
      channels: { cache: channels },
   } as unknown as Client;
   const context: CapabilityTurnContext = {
      guildId: G,
      userId: REPORTER,
      userTag: "fixture",
      channelId: PUBLIC,
      messageId: MSG,
      now: new Date(NOW),
      requestText: `Me amenaza <@${TARGET}> y publica mi dirección`,
      memberRoles: [{ id: STAFF, name: "Rol de prueba" }],
   };
   return {
      memory,
      store,
      roleCache,
      member,
      reporter,
      bot,
      mod,
      source,
      community,
      guild,
      client,
      context,
   };
}

describe("audience containment", () => {
   test("proves staff containment and rejects a wider destination", () => {
      expect(
         audienceContained(
            G,
            roles,
            staffOnly("source"),
            staffOnly(MOD),
            [],
            "owner",
         ),
      ).toBe(true);
      const wider = staffOnly(MOD);
      wider.overwrites.push(ow(GESTION, P.ViewChannel));
      expect(
         audienceContained(G, roles, staffOnly("source"), wider, [], "owner"),
      ).toBe(false);
   });
   test("individual grants, revoked roles, unknown overwrites fail closed; Administrators bypass", () => {
      const dst = staffOnly(MOD);
      dst.overwrites.push(ow(REPORTER, P.ViewChannel, 0n, 1));
      expect(
         audienceContained(G, roles, staffOnly("source"), dst, [], "owner"),
      ).toBe(false);
      expect(
         audienceContained(
            G,
            roles,
            staffOnly("source"),
            dst,
            [{ id: REPORTER, roleIds: [GESTION] }],
            "owner",
         ),
      ).toBe(false);
      expect(
         audienceContained(
            G,
            roles,
            staffOnly("source"),
            dst,
            [{ id: REPORTER, roleIds: [STAFF] }],
            "owner",
         ),
      ).toBe(true);
      const admin = { id: "1550000000000000007", permissions: P.Administrator };
      expect(
         audienceContained(
            G,
            [...roles, admin],
            staffOnly("source"),
            dst,
            [{ id: REPORTER, roleIds: [admin.id] }],
            "owner",
         ),
      ).toBe(true);
      expect(
         audienceContained(
            G,
            roles,
            staffOnly("source"),
            snap(MOD, [ow("unknown", P.ViewChannel)]),
            [],
            "owner",
         ),
      ).toBe(false);
   });
   test("multi-role combinations and source member-denies cannot be hidden by a role-only check", () => {
      const src = staffOnly("source"),
         dst = staffOnly(MOD);
      src.overwrites.push(ow(GESTION, 0n, P.ReadMessageHistory));
      // STAFF allows history, so that deny alone is harmless; an explicit user deny wins.
      expect(audienceContained(G, roles, src, dst, [], "owner")).toBe(true);
      src.overwrites.push(ow(REPORTER, 0n, P.ReadMessageHistory, 1));
      expect(
         audienceContained(
            G,
            roles,
            src,
            dst,
            [{ id: REPORTER, roleIds: [STAFF, GESTION] }],
            "owner",
         ),
      ).toBe(false);
   });
});

describe("partner availability and evidence", () => {
   test("only moderator in configured restricted workspace gets partner/audit; public and Gestión don't", async () => {
      const h = harness(),
         cap = new GeneralChatCapability();
      await cap.init({
         memory: { db: () => h.memory.db(), migrate: async () => {} },
         projectRoot: ".",
         getDiscordClient: () => h.client,
         getRegistry: () => new CapabilityRegistry(),
         getRouter: () => buildRouter(new Map()),
      });
      const staff = await cap.buildTurn({ ...h.context, channelId: MOD });
      expect(staff.system).toContain("colaborador prudente");
      expect(staff.tools.tools.map((t) => t.name)).toContain(
         "server_audit_log",
      );
      const publicTurn = await cap.buildTurn(h.context);
      expect(publicTurn.tools.tools.map((t) => t.name)).not.toContain(
         "server_audit_log",
      );
      expect(publicTurn.system).toContain("No ofrezco avisos de entrada");
      const gestion = await cap.buildTurn({
         ...h.context,
         channelId: MOD,
         memberRoles: [{ id: GESTION, name: "Gestión" }],
      });
      expect(gestion.system).not.toContain("colaborador prudente");
      expect(gestion.tools.tools.map((t) => t.name)).not.toContain(
         "server_audit_log",
      );
      expect(gestion.system).not.toContain(
         "@ChopperBot banea a @persona por motivo",
      );
      h.memory.close();
   });
   test("audit filters, Spanish labels, bounds, and effect-time authority revocation", async () => {
      const h = harness();
      const access = new PartnerAccess(
         () => h.client,
         h.memory.db(),
         G,
         REPORTER,
         MOD,
      );
      const tool = new AuditLogToolSource(() => h.client, G, access);
      const result = await tool.handle("server_audit_log", {
         action_type: 24,
         actor_id: REPORTER,
         target_id: TARGET,
         before: MSG,
      });
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.payload)).toContain("Miembro actualizado");
      expect(h.guild.fetchAuditLogs).toHaveBeenCalledWith({
         limit: 50,
         type: 24,
         user: REPORTER,
         before: MSG,
      });
      h.member.roles.cache.clear();
      expect(await access.verifyDelivery()).toBe(false);
      expect((await tool.handle("server_audit_log", {})).status).toBe("error");
      h.memory.close();
   });
   test("self-knowledge is sorted/cached and keeps operational syntax out of member prompts", async () => {
      const h = harness(),
         knowledge = new BotSelfKnowledge();
      const first = await knowledge.block(h.client, G, true, NOW);
      expect(first).toContain("Administrator=sí");
      expect(first).toContain("máximo 7d");
      h.bot.permissions = new PermissionsBitField();
      expect(await knowledge.block(h.client, G, true, NOW + 1000)).toBe(first);
      expect(await knowledge.block(h.client, G, true, NOW + 61_000)).toContain(
         "Administrator=no",
      );
      const member = await knowledge.block(h.client, G, false, NOW + 61_000);
      expect(member).not.toContain("@ChopperBot banea");
      expect(member).not.toContain("Administrator=");
      expect(member).toContain("Nunca envío ni retransmito");
      h.memory.close();
   });
});

describe("escalation and action trail", () => {
   test.each([
      "banea a <@1550000000000000002> jajaja",
      "hazle timeout xd",
      "esto es una broma de raid",
   ])("jokes do not qualify: %s", (text) =>
      expect(escalationCandidate(text)).toBe(false),
   );
   test("current harassment report sends once despite three messages; mentions ping nobody", async () => {
      const h = harness();
      h.guild.members.fetch.mockImplementation(async () => h.reporter as any);
      for (let i = 0; i < 3; i++) {
         const source = new EscalationToolSource(() => h.client, h.store, {
            ...h.context,
            messageId: String(BigInt(MSG) + BigInt(i)),
            memberRoles: [],
         });
         await source.handle("server_escalate_report", {
            summary: "Reporte ficticio de amenazas para revisión",
            severity: "alta",
            target_id: TARGET,
         });
      }
      expect(h.mod.send).toHaveBeenCalledTimes(1);
      expect(h.mod.send.mock.calls[0][0].nonce).toBe(`e${MSG}`);
      expect(h.mod.send.mock.calls[0][0].enforceNonce).toBe(true);
      expect(h.mod.send.mock.calls[0][0].allowedMentions).toEqual({
         parse: [],
         users: [],
         roles: [],
         repliedUser: false,
      });
      expect(h.store.summary(G).by_outcome.escalated).toBe(1);
      h.memory.close();
   });
   test("invented targets, edited trigger and ambient-only request cannot send", async () => {
      const h = harness();
      const source = new EscalationToolSource(
         () => h.client,
         h.store,
         h.context,
      );
      expect(
         (
            await source.handle("server_escalate_report", {
               summary: "Reporte ficticio de amenazas",
               severity: "alta",
               target_id: "1550000000000000007",
            })
         ).status,
      ).toBe("error");
      const ambient = new EscalationToolSource(() => h.client, h.store, {
         ...h.context,
         requestText: "hola",
      });
      expect(
         (
            await ambient.handle("server_escalate_report", {
               summary: "Reporte ficticio de amenazas",
               severity: "alta",
            })
         ).status,
      ).toBe("error");
      h.community.messages.fetch.mockResolvedValueOnce({
         author: { id: REPORTER },
         editedTimestamp: NOW,
      } as any);
      expect(
         (
            await source.handle("server_escalate_report", {
               summary: "Reporte ficticio de amenazas",
               severity: "alta",
            })
         ).status,
      ).toBe("error");
      expect(h.mod.send).not.toHaveBeenCalled();
      h.memory.close();
   });
   test("persistent per-channel/daily caps and unique trigger/target reservation", () => {
      const h = harness();
      const entry = {
         guildId: G,
         actorId: REPORTER,
         targetId: TARGET,
         action: "escalation" as const,
         reason: "fixture",
         triggerMessageId: MSG,
         channelId: PUBLIC,
         outcome: "escalated",
         timestamp: NOW,
      };
      expect(h.store.reserveEscalation(entry)).not.toBeNull();
      expect(h.store.reserveEscalation(entry)).toBeNull();
      expect(
         h.store.reserveEscalation({
            ...entry,
            actorId: TARGET,
            triggerMessageId: "different",
         }),
      ).toBeNull();
      for (let i = 1; i < 20; i++)
         expect(
            h.store.reserveEscalation({
               ...entry,
               actorId: String(i),
               channelId: String(i),
               targetId: `t${i}`,
               triggerMessageId: String(i),
            }),
         ).not.toBeNull();
      expect(
         h.store.reserveEscalation({
            ...entry,
            actorId: "new",
            channelId: "new",
            targetId: "new",
            triggerMessageId: "new",
         }),
      ).toBeNull();
      h.memory.close();
   });
   test("one note per cited target; refused deliveries do not burn the daily cap", () => {
      const h = harness();
      const entry = {
         guildId: G,
         actorId: REPORTER,
         targetId: TARGET,
         action: "escalation" as const,
         reason: "fixture",
         triggerMessageId: MSG,
         channelId: PUBLIC,
         outcome: "escalated",
         timestamp: NOW,
      };
      expect(h.store.reserveEscalation(entry)).not.toBeNull();
      // Another reporter, another channel, same target within 30 min: deduped.
      expect(
         h.store.reserveEscalation({
            ...entry,
            actorId: "a2",
            channelId: "c2",
            triggerMessageId: "m2",
         }),
      ).toBeNull();
      // No cited target is never limited by the per-target rule.
      expect(
         h.store.reserveEscalation({
            ...entry,
            actorId: "a3",
            channelId: "c3",
            targetId: "",
            triggerMessageId: "m3",
         }),
      ).not.toBeNull();
      for (let i = 0; i < 25; i++) {
         const id = h.store.reserveEscalation({
            ...entry,
            actorId: `r${i}`,
            channelId: `rc${i}`,
            targetId: `rt${i}`,
            triggerMessageId: `rm${i}`,
            outcome: "refused:delivery_unconfirmed",
         });
         expect(id).not.toBeNull();
      }
      // 25 failed deliveries later, a real report still gets through.
      expect(
         h.store.reserveEscalation({
            ...entry,
            actorId: "late",
            channelId: "late",
            targetId: "late",
            triggerMessageId: "late",
         }),
      ).not.toBeNull();
      h.memory.close();
   });
   test("successful mocked ban records and logs; refused ban records without logging; failed log cannot replay", async () => {
      const h = harness(),
         effect = vi.fn(async () => {}),
         send = vi.fn(async () => {
            throw new Error("log unavailable");
         });
      const entry = {
         guildId: G,
         actorId: REPORTER,
         targetId: TARGET,
         action: "ban" as const,
         reason: "Motivo ficticio",
         triggerMessageId: MSG,
         channelId: PUBLIC,
         outcome: "executed",
         timestamp: NOW,
      };
      const execute = withBanTrail({ execute: effect }, h.store, entry, send);
      await execute.execute({ targetId: TARGET, reason: entry.reason });
      expect(h.store.summary(G, NOW).by_outcome.executed).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      await expect(
         execute.execute({ targetId: TARGET, reason: entry.reason }),
      ).rejects.toThrow();
      expect(effect).toHaveBeenCalledTimes(1);
      const refusal = withBanTrail(
         {
            execute: async () => {
               throw new Error("Objetivo protegido o jerarquía insuficiente.");
            },
         },
         h.store,
         { ...entry, triggerMessageId: "refusal" },
         send,
      );
      await expect(
         refusal.execute({ targetId: TARGET, reason: entry.reason }),
      ).rejects.toThrow();
      expect(
         h.store.summary(G, NOW).by_outcome[
            "refused:protected_target_or_hierarchy"
         ],
      ).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      h.memory.close();
   });
   test("mod-log renderer's actual send has no user/role pings", async () => {
      const h = harness();
      await sendModerationLine(
         h.client,
         h.store,
         G,
         "Acción ficticia: ban ejecutado",
      );
      expect(h.mod.send.mock.calls[0][0].allowedMentions).toEqual({
         parse: [],
         users: [],
         roles: [],
         repliedUser: false,
      });
      h.memory.close();
   });
   test("settings are live-editable but direct invocation with revoked authority is refused", async () => {
      const h = harness(),
         tool = new ConfigModerationSource(
            h.memory.db(),
            h.client,
            G,
            REPORTER,
            MOD,
         );
      expect(
         (
            await tool.handle("config_moderation", {
               action: "set_escalation_pings",
               role_ids: [STAFF],
            })
         ).status,
      ).toBe("success");
      expect(h.store.settings(G).escalation_ping_role_ids).toEqual([STAFF]);
      expect(
         (
            await tool.handle("config_moderation", {
               action: "set_escalation_pings",
               role_ids: [G],
            })
         ).status,
      ).toBe("error");
      h.member.roles.cache.clear();
      expect(
         (
            await tool.handle("config_moderation", {
               action: "set_escalation_pings",
               role_ids: [],
            })
         ).status,
      ).toBe("error");
      h.memory.close();
   });
});

test("existing explicit-ban executor integrates trail and actual mod-log payload with mocked sanction", async () => {
   const h = harness();
   Object.assign(h.member.roles, { highest: { comparePositionTo: () => 1 } });
   const target = {
      id: TARGET,
      user: { bot: false },
      permissions: new PermissionsBitField(),
      roles: { cache: new Collection(), highest: {} },
      bannable: true,
   };
   h.guild.members.fetch.mockImplementation(
      async ({ user }: any) => (user === REPORTER ? h.member : target) as any,
   );
   const ban = vi.fn(async () => {});
   Object.assign(h.guild.members, { ban });
   const request = { targetId: TARGET, reason: "Motivo ficticio" };
   h.community.messages.fetch.mockResolvedValue({
      author: { id: REPORTER },
      content: `<@${h.bot.id}> banea a <@${TARGET}> por Motivo ficticio`,
      editedTimestamp: null,
   } as any);
   const executor = withBanTrail(
      createDiscordBanExecutor(
         () => h.client,
         G,
         REPORTER,
         PUBLIC,
         MSG,
         h.memory.db(),
         request,
      ),
      h.store,
      {
         guildId: G,
         actorId: REPORTER,
         targetId: TARGET,
         action: "ban",
         reason: request.reason,
         triggerMessageId: MSG,
         channelId: PUBLIC,
         outcome: "executed",
         timestamp: NOW,
      },
      (line) => sendModerationLine(h.client, h.store, G, line),
   );
   await executor.execute(request);
   expect(ban).toHaveBeenCalledTimes(1);
   expect(h.mod.send).toHaveBeenCalledTimes(1);
   expect(h.store.summary(G, NOW).by_outcome.executed).toBe(1);
   expect(ban.mock.calls[0][1].reason).toContain(REPORTER);
   h.memory.close();
});

test("containment checks a multi-role counterexample that either role alone would miss", () => {
   const src = snap("source", [
      ow(G, 0n, P.ViewChannel),
      ow(STAFF, P.ViewChannel),
      ow(GESTION, 0n, P.ReadMessageHistory),
   ]);
   expect(audienceContained(G, roles, src, staffOnly(MOD), [], "owner")).toBe(
      false,
   );
});

test("workspace setting takes effect immediately and rejects log channels", async () => {
   const h = harness();
   const replacementId = "1550000000000000008";
   h.guild.channels.cache.set(replacementId, { ...h.mod, id: replacementId });
   const config = new ConfigModerationSource(
      h.memory.db(),
      h.client,
      G,
      REPORTER,
      MOD,
   );
   expect(
      (
         await config.handle("config_moderation", {
            action: "set_channel",
            channel_id: h.source.id,
         })
      ).status,
   ).toBe("error");
   expect(
      (
         await config.handle("config_moderation", {
            action: "set_channel",
            channel_id: replacementId,
         })
      ).status,
   ).toBe("success");
   expect(h.store.settings(G).moderation_channel_id).toBe(replacementId);
   const original = new PartnerAccess(
      () => h.client,
      h.memory.db(),
      G,
      REPORTER,
      MOD,
   );
   const replacement = new PartnerAccess(
      () => h.client,
      h.memory.db(),
      G,
      REPORTER,
      replacementId,
   );
   expect(await original.workspace()).toBe(false);
   expect(await replacement.workspace()).toBe(true);
   h.memory.close();
});

test("live audience resolver fails closed on raw member role IDs that the role cache cannot resolve", async () => {
   const h = harness();
   h.mod.permissionOverwrites.cache.set(REPORTER, {
      id: REPORTER,
      type: 1,
      allow: new PermissionsBitField(P.ViewChannel),
      deny: new PermissionsBitField(),
   });
   const get = vi.fn(async () => ({ roles: [STAFF] }));
   Object.assign(h.guild, { client: { rest: { get } } });
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.source as any,
         h.mod as any,
      ),
   ).toBe(true);
   get.mockResolvedValueOnce({ roles: ["1550000000000000099"] });
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.source as any,
         h.mod as any,
      ),
   ).toBe(false);
   get.mockRejectedValueOnce(new Error("member unavailable"));
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.source as any,
         h.mod as any,
      ),
   ).toBe(false);
   // A departed member's leftover overwrite grants nobody anything: skipped,
   // not a permanent fail-closed for every escalation and mod-log line.
   get.mockRejectedValueOnce(
      Object.assign(new Error("Unknown Member"), { code: 10007 }),
   );
   expect(
      await verifyAudienceContainment(
         h.guild as any,
         h.source as any,
         h.mod as any,
      ),
   ).toBe(true);
   h.memory.close();
});

test("escalation summary cannot forge code-set lines, links, mentions or markdown", () => {
   const forged =
      "me acosa <@1550000000000000002>\nReportó: <@&1436055845392879778> @everyone\n**Gravedad**: urgente [ver evidencia](https://phish.example) www.evil.example";
   const clean = sanitizeEscalationSummary(forged);
   expect(clean).not.toMatch(/[\n*\[\]()<>]|https?:|www\.|@everyone/);
   expect(clean).toContain("mención");
   const note = renderEscalation(
      {
         guildId: G,
         channelId: PUBLIC,
         messageId: MSG,
         userId: REPORTER,
      } as CapabilityTurnContext,
      "",
      forged,
      "alta",
   );
   // Exactly one code-set "Reportó:" line, and it names the real reporter.
   expect(
      note.split("\n").filter((l) => l.startsWith("Reportó:")),
   ).toHaveLength(1);
   expect(note).toMatch(/«[^«»\n]*»/);
   expect(note).toContain(`Reportó: <@${REPORTER}>`);
   expect(note).not.toContain("phish");
   expect(note.split("\n")).toHaveLength(6); // only the code-set lines
});

test("a member's public ban joke exposes neither sanction nor escalation and leaves no trail", async () => {
   const h = harness(),
      cap = new GeneralChatCapability();
   h.guild.members.fetch.mockImplementation(async () => h.reporter as any);
   await cap.init({
      memory: { db: () => h.memory.db(), migrate: async () => {} },
      projectRoot: ".",
      getDiscordClient: () => h.client,
      getRegistry: () => new CapabilityRegistry(),
      getRouter: () => buildRouter(new Map()),
   });
   const turn = await cap.buildTurn({
      ...h.context,
      memberRoles: [{ id: COMMUNITY, name: "Comunidad de prueba" }],
      requestText: `banea a <@${TARGET}> jajaja`,
   });
   expect(turn.tools.tools.map((t) => t.name)).not.toContain(
      "server_ban_member",
   );
   expect(turn.tools.tools.map((t) => t.name)).not.toContain(
      "server_escalate_report",
   );
   expect(h.store.summary(G).total).toBe(0);
   expect(h.mod.send).not.toHaveBeenCalled();
   h.memory.close();
});
