/**
 * Live end-to-end check of the workshop status line + reply delivery, WITHOUT
 * needing a human in Discord: posts a message as the bot into a session
 * channel is not possible (the bot ignores itself), so instead this drives the
 * two Discord operations the turn depends on — LiveStatusMessage.start() and
 * finishAsReply() — against the REAL channel, then deletes what it posted.
 *
 * This is the regression guard for the 2026-08-06 bug where a detached
 * `channel.send` reference made every workshop reply vanish silently.
 *
 *   npx tsx scripts/verify-workshop-turn.ts <channelId>
 */
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { config } from "../src/config.js";
import {
   LiveStatusMessage,
   composeStatusText,
} from "../src/discord/status-message.js";

const channelId = process.argv[2];
if (!channelId) {
   console.error("usage: npx tsx scripts/verify-workshop-turn.ts <channelId>");
   process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
   try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
         throw new Error(`channel ${channelId} is not a text channel`);
      }
      const status = new LiveStatusMessage(channel);

      await status.start(
         composeStatusText({ phase: "thinking", step: 0, elapsedMs: 0 }),
      );
      console.log(
         status.active
            ? "✅ status line posted"
            : "❌ status line FAILED to post",
      );
      if (!status.active) process.exitCode = 1;

      status.update(
         composeStatusText({
            phase: "tool",
            toolName: "workshop_run_python",
            step: 2,
            elapsedMs: 42_000,
         }),
      );
      await new Promise((r) => setTimeout(r, 2500));

      const anchor = await status.finishAsReply([
         "✅ Verificación de entrega (se borra en 3s).",
      ]);
      console.log(
         anchor
            ? "✅ reply delivered (status morphed)"
            : "❌ reply delivery FAILED",
      );
      if (!anchor) process.exitCode = 1;

      await new Promise((r) => setTimeout(r, 3000));
      await anchor?.delete().catch(() => {});
      console.log("🧹 limpieza lista");
   } catch (err) {
      console.error("FAILED:", err);
      process.exitCode = 1;
   } finally {
      await client.destroy();
   }
});

await client.login(config.DISCORD_TOKEN);
