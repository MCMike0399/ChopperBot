// Deliberate live proof: synthetic fetch failures, real admin-channel delivery,
// isolated SQLite state, no Instagram/LLM requests. Deletes its two test messages.
// Run after build: npx tsx scripts/verify-ig-fetch-health.ts
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { CONFIGURATION_CHANNEL_ID } from "../src/capabilities/configuration/constants.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import {
   InstagramMonitorStore,
   INSTAGRAM_MONITOR_MIGRATIONS,
} from "../src/capabilities/instagram_monitor/store.js";
import { InstagramFetchHealth } from "../src/capabilities/instagram_monitor/fetch-health.js";
import { postFetchHealthAlert } from "../src/capabilities/instagram_monitor/capability.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const memory = new SqliteMemoryStore({ path: ":memory:" });
const messages: Array<{ id: string; delete(): Promise<unknown> }> = [];
try {
   await memory.migrate("instagram_monitor", INSTAGRAM_MONITOR_MIGRATIONS);
   const store = new InstagramMonitorStore(memory.db());
   const ready = new Promise<void>((resolve) =>
      client.once("clientReady", () => resolve()),
   );
   await client.login(config.DISCORD_TOKEN);
   await ready;
   const channel = await client.channels.fetch(CONFIGURATION_CHANNEL_ID);
   if (!channel || !channel.isSendable())
      throw new Error("Admin channel unavailable");
   const deliveryClient = {
      channels: {
         fetch: async () => ({
            type: channel.type,
            send: async (payload: {
               content: string;
               allowedMentions: unknown;
            }) => {
               const message = await channel.send({
                  content: `🧪 **PRUEBA DE MONITOREO — datos simulados, se borrará al terminar**\n${payload.content}`,
                  allowedMentions: { parse: [] },
               });
               messages.push(message);
               return message;
            },
         }),
      },
   } as unknown as Client;
   const notices: string[] = [];
   const health = new InstagramFetchHealth(store, async (notice) => {
      const delivered = await postFetchHealthAlert(deliveryClient, notice);
      if (delivered) notices.push(notice.kind);
      return delivered;
   });
   for (let n = 1; n <= 3; n++) {
      health.recordFailure(`cuenta_de_prueba_${n}`, "unexpected", Date.now());
      await health.flush(Date.now());
   }
   if (notices.join(",") !== "failed")
      throw new Error("Expected exactly one outage alert");
   console.log("PASS: third failed poll delivered exactly one admin alert");
   const restarted = new InstagramFetchHealth(
      new InstagramMonitorStore(memory.db()),
      async () => {
         throw new Error("Duplicate notification after restart");
      },
   );
   await restarted.flush(Date.now());
   console.log("PASS: persisted incident deduplicated after restart");
   health.recordSuccess("cuenta_de_prueba_4", Date.now());
   await health.flush(Date.now());
   if (notices.join(",") !== "failed,recovered")
      throw new Error("Expected recovery notification");
   if (store.readFetchHealth().recoveryPending)
      throw new Error("Recovery not acknowledged");
   console.log("PASS: successful read delivered one recovery notice");
} finally {
   const cleanup = await Promise.allSettled(
      messages.map(async (message) => {
         await message.delete();
         console.log(`Deleted synthetic proof message ${message.id}`);
      }),
   );
   memory.close();
   await client.destroy();
   if (cleanup.some((result) => result.status === "rejected")) {
      throw new Error(
         "Some synthetic proof messages could not be deleted; inspect the admin channel",
      );
   }
}
