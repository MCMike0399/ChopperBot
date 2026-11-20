/**
 * Live end-to-end proof of the workshop DELIVERY path against real Discord and
 * real MinIO, with no LLM turn and no member involved.
 *
 * What it proves (the three things the send path must keep true):
 *   1. deliverables the safety net picks up arrive as ONE grouped message;
 *   2. work copies (`.scratch/`, `recalc/`) and duplicate basenames are NEVER
 *      attached — live 2026-11-16/17 a recalculated LibreOffice copy was
 *      delivered next to the real workbook;
 *   3. each attached file lands in the workshop_files manifest (Discord carrier
 *      = fallback durable copy) and in MinIO (primary durable copy).
 *
 * It creates a TEMPORARY private channel in the workshop category, then deletes
 * the channel, the manifest rows, the MinIO objects and the local workspace.
 *
 *   npx tsx scripts/e2e-workshop-delivery.ts [--keep]
 *
 * `--keep` leaves the channel/objects in place for inspection. Costs nothing in
 * tokens; it does write to Discord and MinIO, so run it deliberately.
 */
import "dotenv/config";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
   ChannelType,
   Client,
   GatewayIntentBits,
   PermissionFlagsBits,
} from "discord.js";
import { config } from "../src/config.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import { WorkshopStore } from "../src/capabilities/workshop/store.js";
import { SessionWorkspace } from "../src/capabilities/workshop/workspace.js";
import {
   autoDeliverForgotten,
   type DeliverPort,
} from "../src/capabilities/workshop/deliver.js";
import { deleteSessionObjects } from "../src/capabilities/workshop/storage.js";
import { createObjectStorage } from "../src/storage/index.js";

const KEEP = process.argv.includes("--keep");
const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);

const log = (ok: boolean, msg: string) =>
   console.log(`${ok ? "✅" : "❌"} ${msg}`);

async function main(): Promise<number> {
   const mem = new SqliteMemoryStore({ path: join(dataDir, "chopperbot.db") });
   const store = new WorkshopStore(mem.db());
   const settings = store.getSettings();
   if (!settings.category_id) {
      console.error("❌ no hay WORKSHOP_CATEGORY_ID configurado");
      return 1;
   }
   const storage = createObjectStorage();
   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   let channelId: string | null = null;
   const wsRoot = mkdtempSync(join(tmpdir(), "workshop-deliver-proof-"));
   let failures = 0;
   try {
      await client.login(config.DISCORD_TOKEN);
      await new Promise((res) => client.once("clientReady", res));

      const category = await client.channels.fetch(settings.category_id);
      if (!category || category.type !== ChannelType.GuildCategory) {
         console.error("❌ la categoría del workshop no es una categoría");
         return 1;
      }
      const me = client.user;
      const channel = await category.guild.channels.create({
         name: `taller-prueba-entrega-${Date.now().toString(36)}`,
         type: ChannelType.GuildText,
         parent: category.id,
         permissionOverwrites: [
            {
               id: category.guild.roles.everyone.id,
               deny: [PermissionFlagsBits.ViewChannel],
            },
            ...(me
               ? [
                    {
                       id: me.id,
                       allow: [
                          PermissionFlagsBits.ViewChannel,
                          PermissionFlagsBits.SendMessages,
                          PermissionFlagsBits.AttachFiles,
                       ],
                    },
                 ]
               : []),
         ],
      });
      channelId = channel.id;
      console.log(`canal temporal: #${channel.name} (${channel.id})`);

      // The model's real workspace layout for a turn: one deliverable, the
      // LibreOffice copy it recalcs, and a preview it converts.
      const workspace = new SessionWorkspace(wsRoot);
      workspace.writeText("presupuesto.csv", "concepto,importe\ntotal,100\n");
      workspace.writeText(
         "grafica.svg",
         "<svg xmlns='http://www.w3.org/2000/svg'/>",
      );
      workspace.writeText(
         "recalc/presupuesto.csv",
         "concepto,importe\nrecalculado,100\n",
      );
      workspace.writeText(".scratch/vista_previa/presupuesto.csv", "preview");

      const port: DeliverPort = {
         channelId: channel.id,
         channel: channel as unknown as DeliverPort["channel"],
         workspace,
         store,
         storage,
         venvDir: null,
         now: () => Date.now(),
      };
      const outcome = await autoDeliverForgotten(port, {
         before: new Map(),
         skip: new Set(),
         maxBytes: 9_500_000,
      });

      // ── 1. one grouped message, exactly the two real deliverables ──────────
      const messages = [
         ...(await channel.messages.fetch({ limit: 20 })).values(),
      ].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const attachmentNames = messages.flatMap((m) =>
         [...m.attachments.values()].map((a) => a.name),
      );
      const okCount = messages.length === 1 && attachmentNames.length === 2;
      if (!okCount) failures += 1;
      log(
         okCount,
         `un solo mensaje con 2 adjuntos (mensajes=${messages.length}, adjuntos=${attachmentNames.join(", ") || "ninguno"})`,
      );
      const singleGrouped =
         messages.filter((m) => m.attachments.size > 0).length === 1;
      if (!singleGrouped) failures += 1;
      log(singleGrouped, "los entregables viajaron juntos en UN mensaje");
      const namesOk =
         attachmentNames.includes("presupuesto.csv") &&
         attachmentNames.includes("grafica.svg");
      if (!namesOk) failures += 1;
      log(namesOk, "contenido agrupado con nombres correctos");

      // ── 2. no scratch/work copy leaked ────────────────────────────────────
      const manifestPaths = store
         .fileManifest(channel.id)
         .map((f) => f.rel_path)
         .sort();
      const noScratch = manifestPaths.every(
         (p) => !p.startsWith("recalc/") && !p.startsWith(".scratch/"),
      );
      if (!noScratch) failures += 1;
      log(
         noScratch,
         `el manifiesto solo tiene entregables reales: ${manifestPaths.join(", ")}`,
      );
      console.log(
         `   elegidos por la red: ${outcome.sent.join(", ")} | bloqueados por revisión: ${outcome.blocked.join(", ") || "ninguno"}`,
      );

      // ── 3. durable copies: Discord carrier + MinIO ────────────────────────
      const rows = store.fileManifest(channel.id);
      const carriersOk =
         rows.length === 2 &&
         rows.every((r) => messages.some((m) => m.id === r.message_id));
      if (!carriersOk) failures += 1;
      log(carriersOk, "cada archivo apunta al mensaje que lo transporta");

      if (storage) {
         const keysOk = rows.every((r) => typeof r.storage_key === "string");
         if (!keysOk) failures += 1;
         log(keysOk, "MinIO tiene la copia primaria de cada archivo");
         for (const r of rows) {
            if (!r.storage_key) continue;
            const back = await storage.get(r.storage_key).catch(() => null);
            const same = back !== null && back.length > 0;
            if (!same) failures += 1;
            log(same, `lectura de vuelta desde MinIO: ${r.storage_key}`);
         }
      } else {
         console.log(
            "· MinIO no configurado: solo se comprobó el portador de Discord",
         );
      }

      console.log(
         failures === 0
            ? "\nPROOF OK — la red de entrega agrupa, no filtra copias de trabajo y deja las dos copias durables."
            : `\nPROOF FAILED — ${failures} comprobación(es) en rojo.`,
      );
   } finally {
      if (channelId && !KEEP) {
         if (storage) await deleteSessionObjects(storage, channelId);
         store.deleteFileRecords(channelId);
         const ch = await client.channels.fetch(channelId).catch(() => null);
         await ch?.delete("prueba de entrega del taller").catch(() => {});
      }
      if (!KEEP) rmSync(wsRoot, { recursive: true, force: true });
      else {
         mkdirSync(wsRoot, { recursive: true });
         writeFileSync(join(wsRoot, ".kept"), "proof kept");
         console.log(`workspace conservado: ${wsRoot}`);
      }
      await client.destroy();
      mem.close();
   }
   return failures === 0 ? 0 : 1;
}

main()
   .then((code) => process.exit(code))
   .catch((err) => {
      console.error("FAILED:", err);
      process.exit(1);
   });
