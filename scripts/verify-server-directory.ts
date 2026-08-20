/**
 * Read-only live check of general_chat's server-directory tools: prints how
 * many channels each given member can see and resolves a channel query as that
 * member. Verifies the visibility filter against real Discord data — a
 * regular member must see FEWER channels than an admin, and staff channels
 * must resolve as "no existe o no puedes verlo" for them. Posts nothing.
 *
 *   npx tsx scripts/verify-server-directory.ts [query] [userId ...]
 */
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { REVZ_GUILD_ID } from "../src/capabilities/general_chat/profile.js";
import {
   createDiscordDirectoryProvider,
   ServerDirectoryToolSource,
} from "../src/capabilities/general_chat/server-tools.js";

const [, , queryArg, ...userArgs] = process.argv;
const query = queryArg ?? "bienvenidx";
const users =
   userArgs.length > 0
      ? userArgs
      : ["187289179871248384", "678730759309099019"];

// Guilds alone suffices: fetching a SINGLE member by id is plain REST and does
// not need the privileged GuildMembers intent (same as the live bot).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
   try {
      for (const userId of users) {
         const provider = createDiscordDirectoryProvider(
            () => client,
            REVZ_GUILD_ID,
            userId,
         );
         const source = new ServerDirectoryToolSource(provider);
         const channels = await provider.listViewableChannels();
         const info = await source.handle("server_channel_info", {
            channel: query,
         });
         console.log(`\nusuario ${userId}: ve ${channels.length} canales`);
         console.log(
            `  server_channel_info("${query}") → ${info.status}:`,
            JSON.stringify(info.payload),
         );
      }
   } catch (err) {
      console.error("FAILED:", err);
      process.exitCode = 1;
   } finally {
      await client.destroy();
   }
});

await client.login(config.DISCORD_TOKEN);
