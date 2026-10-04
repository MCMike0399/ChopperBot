/**
 * Phase 4 REST-only handler/build-turn proof. No gateway, posts or writes.
 * npx tsx scripts/verify-context-scale.ts <1|2|3> <moderatorId> [--ask]
 * One deliberate billed run per scenario: general event/directory question,
 * management-channel calendar question, and workspace greeting as a control.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import {
   Client,
   ClientUser,
   Routes,
   Collection,
   PermissionFlagsBits as P,
   type Message,
} from "discord.js";
import { config } from "../src/config.js";
import { gatherTurnContext } from "../src/discord/handlers.js";
import { GeneralChatCapability } from "../src/capabilities/general_chat/capability.js";
import { CalendarCapability } from "../src/capabilities/calendar/capability.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { buildRouter } from "../src/capabilities/routing.js";
import {
   MODERATION_GUILD_ID,
   ModerationStore,
} from "../src/moderation/store.js";
import { ask } from "../src/llm/client.js";
import { transcriptCacheFor } from "../src/discord/transcript-cache.js";

const [scenario, memberId, flag] = process.argv.slice(2);
assert(
   ["1", "2", "3"].includes(scenario) &&
      /^\d{17,20}$/.test(memberId) &&
      (!flag || flag === "--ask"),
);
const db = new Database(resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"), {
   readonly: true,
   fileMustExist: true,
});
const client = new Client({ intents: [] });
client.rest.setToken(config.DISCORD_TOKEN);
for (const method of ["post", "put", "patch", "delete"] as const)
   client.rest[method] = async () => {
      throw new Error("Read-only proof: REST writes forbidden.");
   };
try {
   client.user = Reflect.construct(ClientUser, [
      client,
      await client.rest.get(Routes.user()),
   ]) as ClientUser;
   const guild = await client.guilds.fetch(MODERATION_GUILD_ID);
   await guild.roles.fetch();
   await guild.channels.fetch();
   const member = await guild.members.fetch({ user: memberId, force: true });
   assert(!member.user.bot);
   const bot = await guild.members.fetchMe({ force: true });
   assert(!bot.permissions.has(P.Administrator), "D4 must remain applied.");
   const workspace = new ModerationStore(db).settings(
      guild.id,
   ).moderation_channel_id!;
   const channelId =
      scenario === "1"
         ? "1437237844966899742"
         : scenario === "2"
           ? "1483675563871961248"
           : workspace;
   const channel = await guild.channels.fetch(channelId, { force: true });
   assert(channel?.isTextBased() && "messages" in channel);
   const recent = await channel.messages.fetch({ limit: 10, cache: false });
   const anchor = recent.first();
   assert(anchor);
   const now = new Date(),
      requestText =
         scenario === "1"
            ? "¿Qué eventos hay esta semana y dónde propongo un círculo nuevo?"
            : scenario === "2"
              ? "¿Qué evento hay mañana? ¿Ya tiene evento de Discord?"
              : "Hola, Choppy. Solo paso a saludar.";
   // Synthetic CURRENT read trigger; never pass it to an effect executor.
   const id = ((BigInt(now.getTime()) - 1420070400000n) << 22n).toString();
   const trigger = Object.create(anchor) as Message;
   Object.defineProperties(trigger, {
      id: { value: id },
      author: { value: member.user },
      member: { value: member },
      content: { value: requestText },
      createdTimestamp: { value: now.getTime() },
      reference: { value: null },
      attachments: { value: new Collection() },
      stickers: { value: new Collection() },
   });
   const rssBefore = process.memoryUsage().rss,
      started = Date.now();
   const context = await gatherTurnContext(client, trigger, true);
   assert(context.transcript, "Ambient context must be observed, not guessed.");
   const bindings = new Map(
      (
         db
            .prepare(
               "SELECT channel_id, capability_id FROM configuration_bindings",
            )
            .all() as { channel_id: string; capability_id: string }[]
      ).map((r) => [r.channel_id, r.capability_id]),
   );
   const registry = new CapabilityRegistry(),
      router = buildRouter(bindings),
      general = new GeneralChatCapability(),
      calendar = new CalendarCapability();
   const deps = {
      memory: { db: () => db, migrate: async () => {} },
      projectRoot: process.cwd(),
      getDiscordClient: () => client,
      getRegistry: () => registry,
      getRouter: () => router,
   };
   await calendar.init(deps);
   registry.register(calendar);
   await general.init(deps);
   registry.register(general);
   const capability = scenario === "2" ? calendar : general;
   const turn = await capability.buildTurn({
      channelId,
      guildId: guild.id,
      userId: memberId,
      userTag: "read-only-proof",
      userDisplayName: "Persona de prueba",
      requestText,
      messageId: id,
      now,
      isBot: false,
      memberRoles: member.roles.cache.map((r) => ({ id: r.id, name: r.name })),
      isAdministrator: member.permissions.has(P.Administrator),
   });
   const permitted = [
      "calendar_list_upcoming",
      "calendar_search_events",
      "calendar_get_event",
      "server_member_lookup",
      "server_conversation_history",
      "server_moderation_review",
      "server_audit_log",
      "server_channel_info",
      "server_list_channels",
      "server_list_discord_events",
   ];
   assert(turn.tools.tools.every((t) => permitted.includes(t.name)));
   console.log(
      JSON.stringify({
         proof: "context_scale",
         scenario,
         channelId,
         backfillMs: Date.now() - started,
         transcriptChars: context.transcript.length,
         estimatedTranscriptTokens: Math.ceil(context.transcript.length / 3),
         stableSystemChars: turn.stableSystem?.length,
         tailChars: turn.systemTail?.length,
         rssBefore,
         rssAfter: process.memoryUsage().rss,
         cache: transcriptCacheFor(client).stats(),
         tools: turn.tools.tools.map((t) => t.name),
         gateway_login: false,
         writes: 0,
      }),
   );
   if (flag === "--ask") {
      const called: string[] = [];
      const reply = await ask({
         system: turn.system,
         stableSystem: turn.stableSystem,
         systemTail: turn.systemTail,
         channelTranscript: context.transcript,
         messages: [{ role: "user", content: requestText }],
         effort: turn.effort,
         tools: {
            tools: turn.tools.tools,
            async handle(name, input) {
               assert(
                  permitted.includes(name),
                  "No operational write may run.",
               );
               called.push(name);
               return turn.tools.handle(name, input);
            },
         },
      });
      if (turn.verifyDelivery)
         assert(
            await turn.verifyDelivery(),
            "Delivery audience must still be verified.",
         );
      console.log(
         JSON.stringify({
            proof: "context_scale_model",
            scenario,
            called,
            reply,
         }),
      );
   }
} finally {
   db.close();
   await client.destroy();
}
