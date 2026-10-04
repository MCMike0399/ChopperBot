/**
 * Live, read-only proof: Discord history + real general_chat bundle + optional
 * ONE billed model request. Posts nothing; never invokes a ban.
 *
 * npx tsx scripts/verify-conversation-context.ts <channelId> <memberId> [--ask]
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { gatherTurnContext } from "../src/discord/handlers.js";
import { GeneralChatCapability } from "../src/capabilities/general_chat/capability.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { buildRouter } from "../src/capabilities/routing.js";
import { ask } from "../src/llm/client.js";
import { parseBanRequest } from "../src/capabilities/general_chat/moderation-tools.js";

const [channelId, memberId, mode] = process.argv.slice(2);
assert(
   channelId && memberId,
   "Uso: verify-conversation-context.ts <channelId> <memberId> [--ask]",
);
const client = new Client({
   intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
   ],
});
const db = new Database(resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"), {
   readonly: true,
});
try {
   await client.login(config.DISCORD_TOKEN);
   await new Promise<void>((r) =>
      client.isReady() ? r() : client.once("clientReady", () => r()),
   );
   const channel = await client.channels.fetch(channelId);
   assert(
      channel?.isTextBased() && !channel.isDMBased() && "messages" in channel,
   );
   const guild = channel.guild;
   const member = await guild.members.fetch({ user: memberId, force: true });
   const recent = await channel.messages.fetch({ limit: 100, cache: false });
   const trigger = [...recent.values()].find((m) => !m.author.bot);
   assert(
      trigger,
      "Se necesita un mensaje de una persona para probar el contexto real.",
   );
   // Exercise the actual handler context path using a historical trigger.
   const context = await gatherTurnContext(client, trigger, true);
   assert(
      context.blocks.some((b) => b.includes("mensajes anteriores")),
      "El handler no reunió contexto.",
   );
   const registry = new CapabilityRegistry();
   const router = buildRouter(new Map());
   const cap = new GeneralChatCapability();
   await cap.init({
      memory: {
         db: () => db,
         migrate: async (_id, migrations) => {
            assert.equal(migrations.length, 0);
         },
      },
      projectRoot: process.cwd(),
      getDiscordClient: () => client,
      getRegistry: () => registry,
      getRouter: () => router,
   });
   registry.register(cap);
   const base = {
      channelId,
      guildId: guild.id,
      userId: memberId,
      userTag: "live-proof",
      messageId: trigger.id,
      now: new Date(),
      userDisplayName: "Moderación de prueba",
      memberRoles: member.roles.cache.map((r) => ({ id: r.id, name: r.name })),
      isAdministrator: member.permissions.has("Administrator"),
   };
   const turn = await cap.buildTurn({
      ...base,
      requestText: "revisa la conversación reciente",
   });
   assert(
      turn.tools.tools.some((t) => t.name === "server_conversation_history"),
   );
   assert(!turn.tools.tools.some((t) => t.name === "server_ban_member"));
   const read = await turn.tools.handle("server_conversation_history", {});
   assert.equal(read.status, "success");
   const evidence = read.payload as {
      messages: { url: string }[];
      scanned: number;
      complete: boolean;
   };
   assert(evidence.messages.length > 0);
   const denied = await turn.tools.handle("server_ban_member", {
      user_id: client.user!.id,
   });
   assert.equal(denied.status, "error");
   assert.equal(parseBanRequest("sí, hazlo"), null);
   const hasReview = turn.tools.tools.some(
      (t) => t.name === "server_moderation_review",
   );
   if (hasReview) {
      const review = await turn.tools.handle("server_moderation_review", {});
      assert.equal(review.status, "success");
      assert(
         (review.payload as { review: string }).review.includes("Cita enlaces"),
      );
   }
   console.log(
      JSON.stringify({
         proof: "conversation_context",
         channelId,
         contextBlocks: context.blocks.length,
         contextChars: context.blocks.join("\n").length,
         historyMessages: evidence.messages.length,
         scanned: evidence.scanned,
         complete: evidence.complete,
         tools: turn.tools.tools.map((t) => t.name),
         implicitBanRefused: true,
         moderatorReviewVerified: hasReview,
      }),
   );
   if (mode === "--ask") {
      console.log(
         "Un turno deliberado de DeepSeek, con posible lectura de historial; agent_turn registra los tokens. No se publica nada.",
      );
      const modelTurn = await cap.buildTurn({
         ...base,
         requestText: "revisa la conversación reciente",
      });
      const knownUrls = new Set(evidence.messages.map((m) => m.url));
      const reply = await ask({
         system: modelTurn.system,
         tools: {
            tools: modelTurn.tools.tools,
            async handle(name, input) {
               const result = await modelTurn.tools.handle(name, input);
               for (const m of (
                  result.payload as { messages?: { url: string }[] }
               ).messages ?? [])
                  knownUrls.add(m.url);
               return result;
            },
         },
         effort: modelTurn.effort,
         messages: [
            {
               role: "user",
               content: `${context.blocks.join("\n\n")}\n\nConsulta también el historial anterior a esta ventana para entender de qué venía la conversación. Resume en dos párrafos y cita dos enlaces reales a mensajes. Omite nombres y detalles íntimos que no sean necesarios. No sanciones a nadie.`,
            },
         ],
      });
      console.log(reply);
      assert(
         reply.includes(`discord.com/channels/${guild.id}/${channelId}/`),
         "La respuesta no citó evidencia.",
      );
      const cited =
         reply.match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g) ?? [];
      assert(
         cited.every(
            (url) =>
               context.blocks.some((b) => b.includes(url)) ||
               knownUrls.has(url),
         ),
         "La respuesta inventó una cita.",
      );
   }
} finally {
   await client.destroy();
   db.close();
}
