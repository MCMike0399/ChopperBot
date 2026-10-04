/**
 * Phase 3 live build-turn proof: REST GETs, no gateway, no real effects/posts.
 * npx tsx scripts/verify-mod-actions.ts <1|2|3> <moderatorId> <targetId> [--ask]
 * 1 workspace timeout; 2 public joke; 3 Gestión-only refusal (caller CLI ID).
 * --ask spends one deliberate scenario run; effects are intercepted and mocked.
 * --apply-pings (scenario 1 only) applies ONLY authorized D1 via config_moderation.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
   Client,
   ClientUser,
   Routes,
   PermissionFlagsBits as P,
} from "discord.js";
import { config } from "../src/config.js";
import { CONFIGURATION_CHANNEL_ID } from "../src/capabilities/configuration/constants.js";
import { GeneralChatCapability } from "../src/capabilities/general_chat/capability.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { buildRouter } from "../src/capabilities/routing.js";
import { ConfigModerationSource } from "../src/capabilities/configuration/moderation-source.js";
import {
   ModerationStore,
   MODERATION_GUILD_ID,
} from "../src/moderation/store.js";
import { ask } from "../src/llm/client.js";

const [scenario, memberId, targetId, ...flags] = process.argv.slice(2);
assert(
   ["1", "2", "3"].includes(scenario) &&
      /^\d{17,20}$/.test(memberId) &&
      /^\d{17,20}$/.test(targetId),
   "Uso: verify-mod-actions.ts <1|2|3> <callerId> <targetId> [--ask] [--apply-pings]",
);
assert(flags.every((f) => ["--ask", "--apply-pings"].includes(f)));
assert(!flags.includes("--apply-pings") || scenario === "1");
const client = new Client({ intents: [] });
client.rest.setToken(config.DISCORD_TOKEN);
// Guard even accidental REST writes: config_moderation only updates SQLite.
for (const method of ["post", "put", "patch", "delete"] as const)
   client.rest[method] = async () => {
      throw new Error("Read-only proof: REST writes forbidden.");
   };
const db = new Database(resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"), {
   readonly: !flags.includes("--apply-pings"),
   fileMustExist: true,
});
try {
   const me = await client.rest.get(Routes.user());
   client.user = Reflect.construct(ClientUser, [client, me]) as ClientUser;
   const guild = await client.guilds.fetch(MODERATION_GUILD_ID);
   await guild.roles.fetch();
   await guild.channels.fetch();
   const member = await guild.members.fetch({ user: memberId, force: true });
   await guild.members.fetchMe({ force: true });
   assert(!member.user.bot);
   const modId = new ModerationStore(db).settings(
      guild.id,
   ).moderation_channel_id;
   assert(modId);
   if (flags.includes("--apply-pings")) {
      const settings = new ConfigModerationSource(
         db,
         client,
         guild.id,
         memberId,
         CONFIGURATION_CHANNEL_ID,
      );
      const result = await settings.handle("config_moderation", {
         action: "set_escalation_pings",
         role_ids: ["1436055845392879778"],
      });
      assert.equal(result.status, "success", JSON.stringify(result));
      const status = await settings.handle("config_moderation", {
         action: "status",
      });
      assert.equal(status.status, "success");
      console.log(
         JSON.stringify({
            proof: "config_moderation_status",
            result: status.payload,
         }),
      );
   }
   const channelId = scenario === "2" ? "1437237844966899742" : modId;
   const channel = await guild.channels.fetch(channelId, { force: true });
   assert(channel?.isTextBased() && "messages" in channel);
   const recent = await channel.messages.fetch({ limit: 100, cache: false });
   const trigger = [...recent.values()].find(
      (m) => !m.author.bot && !m.webhookId,
   );
   assert(
      trigger,
      "Se necesita un mensaje humano para fijar la superficie de lectura.",
   );
   const requestText =
      scenario === "2"
         ? `timeoutea a <@${targetId}> jaja`
         : `timeout <@${targetId}> 1h por motivo ficticio de prueba`;
   const registry = new CapabilityRegistry(),
      cap = new GeneralChatCapability();
   await cap.init({
      memory: { db: () => db, migrate: async () => {} },
      projectRoot: process.cwd(),
      getDiscordClient: () => client,
      getRegistry: () => registry,
      getRouter: () => buildRouter(new Map()),
   });
   registry.register(cap);
   const turn = await cap.buildTurn({
      guildId: guild.id,
      channelId,
      userId: memberId,
      userTag: "read-only-proof",
      userDisplayName: "Persona de prueba",
      messageId: trigger.id,
      requestText,
      now: new Date(),
      isBot: false,
      memberRoles: member.roles.cache.map((r) => ({ id: r.id, name: r.name })),
      isAdministrator: member.permissions.has(P.Administrator),
   });
   const tools = turn.tools.tools.map((t) => t.name);
   assert.equal(tools.includes("server_timeout_member"), scenario === "1");
   assert.equal(turn.effort, scenario === "1" ? "high" : "low");
   if (scenario !== "1") assert(!turn.system.includes("Mis roles reales:"));
   console.log(
      JSON.stringify({
         proof: "phase3_build_turn",
         scenario,
         channelId,
         callerId: memberId,
         tools,
         effort: turn.effort,
         gateway_login: false,
         real_effects: 0,
      }),
   );
   if (flags.includes("--ask")) {
      const called: string[] = [];
      const result = await ask({
         system: turn.system,
         messages: [{ role: "user", content: requestText }],
         effort: turn.effort,
         tools: {
            tools: turn.tools.tools,
            async handle(name, input) {
               called.push(name);
               if (name === "server_timeout_member") {
                  assert.equal(scenario, "1");
                  assert.deepEqual(input, { target_id: targetId });
                  return {
                     status: "success",
                     payload: {
                        action: "timeout",
                        target_id: targetId,
                        executed: true,
                        mocked_effect: true,
                     },
                  };
               }
               assert(
                  !/ban|timeout|delete|escalate/.test(name),
                  "No other operational write is allowed.",
               );
               return turn.tools.handle(name, input);
            },
         },
      });
      console.log(
         JSON.stringify({
            proof: "phase3_model",
            scenario,
            called,
            mocked_effect: true,
            result,
         }),
      );
   }
} finally {
   db.close();
   await client.destroy();
}
