/** Live read-only proof of Phase 2. No settings changes, escalations or bans.
 * Each --ask is ONE deliberate billed turn; never run in a loop.
 * npx tsx scripts/verify-moderation-partner.ts <1|2|3> <moderatorId> <targetId> [--ask]
 * --probe-logs (scenarios 2/3): read-only audience/history proof; no model call.
 * Optional --post-rendering sends synthetic renderers ONLY to test-chopperbot.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client, ClientUser, Routes, PermissionFlagsBits } from "discord.js";
import { config } from "../src/config.js";
import { GeneralChatCapability } from "../src/capabilities/general_chat/capability.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { buildRouter } from "../src/capabilities/routing.js";
import { ask } from "../src/llm/client.js";
import {
   ModerationStore,
   MODERATION_GUILD_ID,
   DEFAULT_MODERATION_CHANNEL_ID,
} from "../src/moderation/store.js";
import { renderModLog } from "../src/moderation/trail.js";
import { renderEscalation } from "../src/capabilities/general_chat/escalation-tools.js";

const [scenario, memberId, targetId] = process.argv.slice(2);
assert(
   ["1", "2", "3"].includes(scenario) &&
      /^\d{17,20}$/.test(memberId) &&
      /^\d{17,20}$/.test(targetId),
   "Uso: verify-moderation-partner.ts <1|2|3> <moderatorId> <targetId> [--ask]",
);
const client = new Client({ intents: [] });
const db = new Database(resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"), {
   readonly: true,
});
try {
   client.rest.setToken(config.DISCORD_TOKEN);
   client.user = Reflect.construct(ClientUser, [
      client,
      await client.rest.get(Routes.user()),
   ]) as ClientUser;
   const guild = await client.guilds.fetch(MODERATION_GUILD_ID);
   await guild.roles.fetch();
   await guild.channels.fetch();
   const member = await guild.members.fetch({ user: memberId, force: true });
   const bot = await guild.members.fetchMe({ force: true });
   assert(!member.user.bot);
   const modId = new ModerationStore(db).settings(
      guild.id,
   ).moderation_channel_id;
   assert.equal(
      modId,
      DEFAULT_MODERATION_CHANNEL_ID,
      "No cambia el canal configurado para esta prueba.",
   );
   const channelId = scenario === "1" ? "1437237844966899742" : modId!;
   const channel = await guild.channels.fetch(channelId, { force: true });
   assert(channel?.isTextBased() && "messages" in channel);
   const recent = await channel.messages.fetch({ limit: 100, cache: false });
   const trigger = [...recent.values()].find(
      (m) => !m.author.bot && !m.webhookId,
   );
   assert(trigger, "Se necesita un trigger humano para la prueba de lectura.");
   const request =
      scenario === "1"
         ? `Dile a Nekotina que le dé timeout a <@${targetId}>.`
         : scenario === "2"
           ? `Dale timeout a <@${targetId}> cuando entre o al menos avísame cuando entre.`
           : `¿Qué pasó con <@${targetId}> esta semana? Consulta auditoría e historial y separa los hechos de tu interpretación, con enlaces reales a mensajes.`;
   const registry = new CapabilityRegistry(),
      router = buildRouter(new Map()),
      cap = new GeneralChatCapability();
   await cap.init({
      memory: {
         db: () => db,
         migrate: async (_id, migrations) => assert.equal(migrations.length, 0),
      },
      projectRoot: process.cwd(),
      getDiscordClient: () => client,
      getRegistry: () => registry,
      getRouter: () => router,
   });
   registry.register(cap);
   const context = {
      guildId: guild.id,
      channelId,
      userId: memberId,
      userTag: "read-only-proof",
      userDisplayName: "Moderación",
      messageId: trigger.id,
      now: new Date(),
      requestText: request,
      isBot: false,
      memberRoles: member.roles.cache.map((r) => ({ id: r.id, name: r.name })),
      isAdministrator: member.permissions.has(
         PermissionFlagsBits.Administrator,
      ),
   };
   const turn = await cap.buildTurn(context);
   const tools = turn.tools.tools.map((t) => t.name),
      expectedPartner = scenario !== "1";
   assert.equal(tools.includes("server_audit_log"), expectedPartner);
   assert(
      !tools.includes("server_ban_member") &&
         !tools.includes("server_escalate_report"),
   );
   console.log(
      JSON.stringify({
         proof: "moderation_partner",
         scenario,
         channelId,
         tools,
         botRoles: bot.roles.cache.map((r) => r.id).sort(),
         botPermissions: [
            "Administrator",
            "BanMembers",
            "ModerateMembers",
            "ManageMessages",
            "ViewAuditLog",
         ].map((name) => ({
            name,
            enabled: bot.permissions.has(name as "Administrator"),
         })),
      }),
   );
   const knownUrls = new Set<string>(),
      called: string[] = [];
   const reads = {
      tools: turn.tools.tools,
      async handle(name: string, input: unknown) {
         assert(
            [
               "server_audit_log",
               "server_conversation_history",
               "server_moderation_review",
               "server_channel_info",
               "server_list_channels",
               "server_list_discord_events",
               "calendar_list_upcoming",
               "calendar_search_events",
               "calendar_get_event",
            ].includes(name),
            "Solo lectura: herramienta con efecto bloqueada.",
         );
         called.push(name);
         const result = await turn.tools.handle(name, input);
         for (const m of (result.payload as { messages?: { url: string }[] })
            .messages ?? [])
            knownUrls.add(m.url);
         console.log(
            JSON.stringify({
               read: name,
               status: result.status,
               resultChars: JSON.stringify(result.payload).length,
            }),
         );
         return result;
      },
   };
   if (process.argv.includes("--probe-logs")) {
      for (const sourceId of ["1436112159829397564", "1436110972602417253"]) {
         const fresh = await cap.buildTurn(context);
         const read = await fresh.tools.handle("server_conversation_history", {
            channel_id: sourceId,
         });
         console.log(
            JSON.stringify({
               logSourceProof: sourceId,
               status: read.status,
               resultChars: JSON.stringify(read.payload).length,
               returned:
                  (read.payload as { messages?: unknown[] }).messages?.length ??
                  0,
            }),
         );
         assert(
            read.status === "success",
            "Audiencia del log no verificable; no se relajan permisos.",
         );
      }
   }
   if (process.argv.includes("--ask")) {
      console.log(
         "Un turno deliberado facturado; cero acciones/publicaciones; agent_turn registra tokens.",
      );
      const reply = await ask({
         system: turn.system,
         tools: reads,
         effort: turn.effort,
         messages: [{ role: "user", content: request }],
      });
      assert(
         (await turn.verifyDelivery?.()) ?? true,
         "Audiencia revocada antes de entregar.",
      );
      console.log(JSON.stringify({ scenario, reply, called }));
      if (scenario === "3") {
         assert(called.includes("server_audit_log"));
         assert(
            called.some((t) =>
               [
                  "server_conversation_history",
                  "server_moderation_review",
               ].includes(t),
            ),
         );
         const citations =
            reply.match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g) ??
            [];
         assert(
            citations.every((url) => knownUrls.has(url)),
            "Cita no verificada.",
         );
         // An empty/denied evidence window cannot honestly supply a message citation.
         console.log(
            JSON.stringify({
               verifiedMessageCitations: citations.length,
               availableEvidenceUrls: knownUrls.size,
            }),
         );
      }
   }
   if (process.argv.includes("--post-rendering")) {
      const test = await client.channels.fetch("1517612351824728207");
      assert(test?.isTextBased() && "send" in test);
      assert("messages" in test);
      const carrier = await test.messages.fetch({ limit: 1, cache: false });
      const carrierId = carrier.first()?.id;
      assert(carrierId);
      const fixture = {
         ...context,
         channelId: test.id,
         userId: client.user!.id,
         messageId: carrierId,
      };
      const log = renderModLog({
         guildId: guild.id,
         actorId: client.user!.id,
         targetId: client.user!.id,
         action: "ban",
         reason: "Ejemplo sintético; no se ejecutó ninguna acción.",
         triggerMessageId: carrierId,
         channelId: test.id,
         outcome: "executed",
         timestamp: Date.now(),
      });
      const note = renderEscalation(
         fixture,
         client.user!.id,
         "Ejemplo sintético de un reporte; sin incidente real.",
         "alta",
      );
      const posted = await test.send({
         content: `**PRUEBA de representación: no hubo sanción ni reporte real.**\n\n${log}\n\n${note}`,
         allowedMentions: {
            parse: [],
            users: [],
            roles: [],
            repliedUser: false,
         },
      });
      console.log(
         JSON.stringify({
            rendererProofMessage: posted.id,
            channelId: test.id,
         }),
      );
   }
} finally {
   await client.destroy();
   db.close();
}
