// Verify every workshop session channel under a category against ALL stores:
//   Discord (channel + carrier message), SQLite (session row + file manifest),
//   MinIO (object exists, size matches), and the local workspace cache.
// Read-only: posts nothing, writes nothing. Exit code 1 if any channel fails.
//
// Usage:
//   npx tsx scripts/verify-workshop-channels.ts [categoryId]
import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import {
   WorkshopStore,
   type WorkshopFileRecord,
   type WorkshopSession,
} from "../src/capabilities/workshop/store.js";
import { workspaceDirFor } from "../src/capabilities/workshop/workspace.js";
import { attachmentNameMatches } from "../src/capabilities/workshop/watcher.js";
import { storageKeyFor } from "../src/capabilities/workshop/storage.js";
import { createObjectStorage } from "../src/storage/index.js";

const CATEGORY_ID = process.argv[2] ?? "1534988650327310387";

type FileVerdict = {
   rec: WorkshopFileRecord;
   local: "yes" | "no";
   minio: "ok" | "missing" | "size-mismatch" | "no-key";
   carrier: "ok" | "gone" | "unreachable";
   problems: string[];
};

async function main(): Promise<void> {
   const storage = createObjectStorage();
   if (!storage) {
      console.error("❌ MINIO_* no configurado.");
      process.exit(1);
   }

   const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);
   const mem = new SqliteMemoryStore({ path: join(dataDir, "chopperbot.db") });
   const store = new WorkshopStore(mem.db());
   const sessions = mem
      .db()
      .prepare("SELECT * FROM workshop_sessions")
      .all() as WorkshopSession[];
   const sessionByChannel = new Map(sessions.map((s) => [s.channel_id, s]));

   const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
   });
   await client.login(config.DISCORD_TOKEN);
   await new Promise((res) => client.once("ready", res));

   let failures = 0;
   try {
      const category = await client.channels
         .fetch(CATEGORY_ID)
         .catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
         console.error(
            `❌ La categoría ${CATEGORY_ID} no existe o no es categoría.`,
         );
         process.exit(1);
      }
      const children = category.guild.channels.cache
         .filter((c) => c.parentId === CATEGORY_ID)
         .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      console.log(
         `Categoría "${category.name}" — ${children.size} canal(es):\n`,
      );

      for (const channel of children.values()) {
         const session = sessionByChannel.get(channel.id);
         const problems: string[] = [];
         const fileVerdicts: FileVerdict[] = [];

         if (!session) {
            problems.push("canal sin fila en workshop_sessions (¿huérfano?)");
         } else if (session.status !== "active") {
            problems.push(
               `sesión en estado '${session.status}' pero el canal existe`,
            );
         }

         const manifest = session ? store.fileManifest(channel.id) : [];
         for (const rec of manifest) {
            const fv: FileVerdict = {
               rec,
               local: "no",
               minio: "no-key",
               carrier: "unreachable",
               problems: [],
            };
            // Local cache
            const localPath = join(
               workspaceDirFor(dataDir, channel.id),
               rec.rel_path,
            );
            if (existsSync(localPath)) {
               fv.local = "yes";
               if (statSync(localPath).size !== rec.bytes) {
                  fv.problems.push(
                     `tamaño local ${statSync(localPath).size} ≠ manifiesto ${rec.bytes}`,
                  );
               }
            }
            // MinIO
            if (rec.storage_key) {
               const expected = rec.storage_key;
               if (expected !== storageKeyFor(channel.id, rec.rel_path)) {
                  fv.problems.push(`storage_key no canónica: ${expected}`);
               }
               const bytes = await storage!.get(expected).catch(() => null);
               if (bytes === null) {
                  fv.minio = "missing";
                  fv.problems.push("objeto NO existe en MinIO");
               } else if (bytes.length !== rec.bytes) {
                  fv.minio = "size-mismatch";
                  fv.problems.push(
                     `MinIO tiene ${bytes.length} B ≠ manifiesto ${rec.bytes} B`,
                  );
               } else {
                  fv.minio = "ok";
               }
            } else {
               fv.problems.push("sin storage_key (falta migrar a MinIO)");
            }
            // Discord carrier
            if (channel.type === ChannelType.GuildText) {
               const msg = await channel.messages
                  .fetch(rec.message_id)
                  .catch(() => null);
               if (!msg) {
                  fv.carrier = "gone";
                  fv.problems.push("mensaje portador eliminado");
               } else {
                  const att = [...msg.attachments.values()].find((a) =>
                     attachmentNameMatches(a.name, rec.rel_path),
                  );
                  fv.carrier = att ? "ok" : "gone";
                  if (!att)
                     fv.problems.push(
                        "el mensaje portador no tiene el adjunto",
                     );
               }
            }
            fileVerdicts.push(fv);
         }

         const ok =
            problems.length === 0 &&
            fileVerdicts.every((f) => f.problems.length === 0);
         if (!ok) failures += 1;
         const icon = ok
            ? "✅"
            : problems.length || fileVerdicts.some((f) => f.minio === "missing")
              ? "❌"
              : "⚠️";
         console.log(
            `${icon} #${channel.name} (${channel.id})${session ? ` — ${session.user_tag}, ${session.status}` : ""}`,
         );
         if (session && manifest.length === 0)
            console.log("    sin archivos en el manifiesto");
         for (const fv of fileVerdicts) {
            console.log(
               `    • ${fv.rec.rel_path} (${fv.rec.bytes} B): local=${fv.local} minio=${fv.minio} carrier=${fv.carrier}`,
            );
            for (const p of fv.problems) console.log(`      ⚠ ${p}`);
         }
         for (const p of problems) console.log(`    ⚠ ${p}`);
      }

      // Sessions whose channel is NOT under this category (informational).
      const inCategory = new Set(children.keys());
      const elsewhere = sessions.filter((s) => !inCategory.has(s.channel_id));
      if (elsewhere.length > 0) {
         console.log("\nSesiones en la DB fuera de esta categoría:");
         for (const s of elsewhere) {
            console.log(`  • ${s.channel_id} (${s.user_tag}, ${s.status})`);
         }
      }
   } finally {
      await client.destroy();
      mem.close();
   }

   console.log(
      failures === 0
         ? "\n✅ Todos los canales verificados."
         : `\n❌ ${failures} canal(es) con problemas.`,
   );
   process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
   console.error("❌", err instanceof Error ? err.message : err);
   process.exit(1);
});
