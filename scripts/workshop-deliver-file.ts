/**
 * Repair tool: deliver workspace files to a workshop session channel AS THE
 * BOT, keeping the bot's own invariants — the sent message is recorded in the
 * workshop_files manifest (Discord carrier = fallback durable copy) and the
 * bytes are uploaded to MinIO (primary durable copy) when storage is
 * configured. Use after a delivery failure (e.g. the model generated files
 * but never attached them).
 *
 *   npx tsx scripts/workshop-deliver-file.ts <channelId> <relPath...> [--caption "texto"]
 *
 * Default caption: a brief apology note. --dry-run prints what would happen.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import { WorkshopStore } from "../src/capabilities/workshop/store.js";
import {
   SessionWorkspace,
   workspaceDirFor,
} from "../src/capabilities/workshop/workspace.js";
import {
   deliverQueuedFiles,
   type DeliverChannel,
} from "../src/capabilities/workshop/deliver.js";
import { createObjectStorage } from "../src/storage/index.js";

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const DRY_RUN = process.argv.includes("--dry-run");
const captionIdx = args.indexOf("--caption");
const caption =
   captionIdx >= 0
      ? args.splice(captionIdx, 2)[1]
      : "Una disculpa: estos archivos quedaron generados pero no se adjuntaron en su momento. Aquí están. 📄";
const [channelId, ...relPaths] = args;

if (!channelId || relPaths.length === 0) {
   console.error(
      'usage: npx tsx scripts/workshop-deliver-file.ts <channelId> <relPath...> [--caption "texto"] [--dry-run]',
   );
   process.exit(1);
}

const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);
const wsRoot = workspaceDirFor(dataDir, channelId);
for (const rel of relPaths) {
   if (!existsSync(join(wsRoot, rel))) {
      console.error(`❌ no existe en el workspace: ${rel} (${wsRoot})`);
      process.exit(1);
   }
}

async function main(): Promise<void> {
   const mem = new SqliteMemoryStore({ path: join(dataDir, "chopperbot.db") });
   const store = new WorkshopStore(mem.db());
   const session = store.getSession(channelId);
   if (!session) {
      console.error(`❌ no hay sesión de workshop para el canal ${channelId}`);
      process.exit(1);
   }
   const storage = createObjectStorage();
   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   try {
      await client.login(config.DISCORD_TOKEN);
      await new Promise((res) => client.once("clientReady", res));
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
         throw new Error(`el canal ${channelId} no es un canal de texto`);
      }

      if (DRY_RUN) {
         console.log(
            `dry-run: enviaría ${relPaths.join(", ")} a #${channel.name} con caption:`,
         );
         console.log(`> ${caption}`);
         return;
      }
      // Same code path the watcher uses after a turn: artifact check → attach →
      // manifest row → MinIO copy. A repair must not skip the structural check
      // or leave the ledger out of sync (this script used to do its own thing).
      const outcome = await deliverQueuedFiles(
         {
            channelId,
            channel: channel as unknown as DeliverChannel,
            workspace: new SessionWorkspace(wsRoot),
            store,
            storage,
            venvDir: resolve(dataDir, "workshop", "venv"),
            now: () => Date.now(),
         },
         relPaths.map((rel) => ({ relPath: rel, caption })),
      );
      for (const rel of outcome.sent)
         console.log(`  ✓ entregado + manifest + minio: ${rel}`);
      for (const rel of outcome.blocked)
         console.log(`  ✗ bloqueado por la revisión del archivo: ${rel}`);
      for (const rel of outcome.failed)
         console.log(`  ✗ falló el envío: ${rel}`);
      if (outcome.sent.length === 0) process.exitCode = 1;
   } finally {
      await client.destroy();
      mem.close();
   }
}

main().catch((err) => {
   console.error("❌", err instanceof Error ? err.message : err);
   process.exit(1);
});
