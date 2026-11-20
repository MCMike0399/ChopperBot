/**
 * Live end-to-end proof of the workshop "starting up message" (🧭 plan line):
 * the REAL planner call against the REAL backend, plus the REAL status message
 * in Discord, in a TEMPORARY private channel that the script then deletes.
 *
 * What it proves:
 *   1. `planTurn` returns a usable one-line intent for representative requests
 *      (including a follow-up that only makes sense with context);
 *   2. the line reaches Discord as `-# 🧭 …` through the real edit path;
 *   3. the tool trace takes over from the plan, and a late plan never rewrites
 *      a running step;
 *   4. the status line still morphs into the reply.
 *
 * Spends a few hundred input tokens (three `low`-effort calls) and writes to
 * Discord, so run it deliberately, never in a loop.
 *
 *   npx tsx scripts/e2e-workshop-plan.ts [--keep]
 */
import "dotenv/config";
import { join, resolve } from "node:path";
import {
   ChannelType,
   Client,
   GatewayIntentBits,
   PermissionFlagsBits,
} from "discord.js";
import { config } from "../src/config.js";
import { WorkshopTurnPresenter } from "../src/discord/presenter.js";
import type { PresentableMessage } from "../src/discord/presenter.js";
import { planTurn } from "../src/capabilities/workshop/plan.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import { WorkshopStore } from "../src/capabilities/workshop/store.js";
import type { Turn } from "../src/discord/history.js";

const KEEP = process.argv.includes("--keep");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const log = (ok: boolean, msg: string) => {
   if (!ok) failures += 1;
   console.log(`${ok ? "✅" : "❌"} ${msg}`);
};

const SAMPLES: Array<{
   label: string;
   userText: string;
   uploads: string[];
   files: string[];
   contextTurns: Turn[];
}> = [
   {
      label: "documento subido",
      userText:
         "hola, te subí este libro de 40 páginas, ¿me haces un resumen por capítulos y me lo entregas en Word?",
      uploads: ["uploads/federici-caliban.pdf"],
      files: ["uploads/federici-caliban.pdf"],
      contextTurns: [],
   },
   {
      label: "seguimiento corto",
      userText: "dale, y agrégale una gráfica",
      uploads: [],
      files: ["uploads/ventas.xlsx", "resumen.docx"],
      contextTurns: [
         { role: "user", content: "tengo este Excel de ventas, ¿lo ordeno?" },
         {
            role: "assistant",
            content:
               "Listo, ya ordené la hoja y te dejé los totales por mes en resumen.docx.",
         },
      ],
   },
   {
      label: "tarea escolar",
      userText:
         "necesito una presentación de 5 diapositivas sobre la Revolución Mexicana para la prepa",
      uploads: [],
      files: [],
      contextTurns: [],
   },
];

async function main(): Promise<number> {
   let channelId: string | null = null;
   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   try {
      console.log("── 1. planificador real (backend real, effort low) ──");
      const plans: string[] = [];
      for (const sample of SAMPLES) {
         const plan = await planTurn({
            userText: sample.userText,
            uploads: sample.uploads,
            files: sample.files,
            contextTurns: sample.contextTurns,
         });
         log(
            typeof plan === "string" && plan.length > 10 && plan.length <= 141,
            `[${sample.label}] ${plan ?? "(sin plan)"}`,
         );
         if (plan) plans.push(plan);
      }
      if (plans.length === 0) {
         console.error(
            "❌ ningún plan utilizable: se aborta la parte de Discord",
         );
         return 1;
      }
      const plan = plans[0];

      console.log("\n── 2. la línea en Discord (canal temporal) ──");
      await client.login(config.DISCORD_TOKEN);
      await new Promise((res) => client.once("clientReady", res));

      const categoryId = new WorkshopStore(
         new SqliteMemoryStore({
            path: join(
               resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR),
               "chopperbot.db",
            ),
         }).db(),
      ).getSettings().category_id;
      if (!categoryId) {
         console.error("❌ no hay categoría de taller configurada");
         return 1;
      }
      const category = await client.channels.fetch(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
         console.error("❌ WORKSHOP_CATEGORY_ID no es una categoría");
         return 1;
      }
      const me = client.user;
      const channel = await category.guild.channels.create({
         name: `taller-prueba-plan-${Date.now().toString(36)}`,
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
                          PermissionFlagsBits.AddReactions,
                       ],
                    },
                 ]
               : []),
         ],
      });
      channelId = channel.id;
      console.log(`canal temporal: #${channel.name} (${channel.id})`);

      // The turn's "user message": the bot can't post as a member, so the
      // ephemeral one it posts stands in — the presenter only reacts to it and
      // types for it. Deleted with the channel.
      const userMessage = await channel.send("mensaje de prueba (efímero)");
      const presenter = new WorkshopTurnPresenter(
         userMessage as unknown as PresentableMessage,
         me?.id,
      );

      const statusContent = async (): Promise<string> => {
         const messages = [
            ...(await channel.messages.fetch({ limit: 10 })).values(),
         ];
         const status = messages.find((m) => m.content.startsWith("-# "));
         return status?.content ?? "";
      };

      await presenter.begin();
      await sleep(1_000);
      log(
         (await statusContent()).startsWith("-# 🤔"),
         "spinner inicial posteado",
      );

      presenter.announce(plan);
      await sleep(2_500); // edit throttle (1.5 s) + round-trip
      const announced = await statusContent();
      log(
         announced === `-# 🧭 ${plan}`,
         `la línea muestra el plan: "${announced}"`,
      );

      presenter.onPhase("tool", "workshop_run_python");
      await sleep(2_500);
      const trace = await statusContent();
      log(
         trace.includes("🐍 Ejecutando código"),
         `el rastro toma el control: "${trace}"`,
      );

      presenter.announce("un plan que llega tarde no debe pisar el paso");
      await sleep(2_500);
      log(
         !(await statusContent()).includes("tarde"),
         "un plan tardío no reescribe el paso en curso",
      );

      const anchor = await presenter.deliver([
         "✅ Verificación de la línea de arranque (se borra).",
      ]);
      log(
         anchor !== null && anchor.content.startsWith("✅ Verificación"),
         "la línea mutó en la respuesta",
      );

      await sleep(1_000);
      console.log(
         failures === 0
            ? "\nPROOF OK — el plan se genera, se ve en Discord y cede el paso al rastro de herramientas."
            : `\nPROOF FAILED — ${failures} comprobación(es) en rojo.`,
      );
      await userMessage.delete().catch(() => {});
      return failures === 0 ? 0 : 1;
   } finally {
      if (channelId && !KEEP) {
         const ch = await client.channels.fetch(channelId).catch(() => null);
         await ch?.delete().catch(() => {});
      }
      await client.destroy();
   }
}

process.exitCode = await main().catch((err) => {
   console.error("FAILED:", err);
   return 1;
});
