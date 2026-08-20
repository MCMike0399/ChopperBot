// READ-ONLY survey of the Revolución Z Discord server. Prints to a markdown
// file under /tmp so the operator (or an agent) can understand the community:
// guild info, roles, every channel grouped by category (with topics), a sample
// of recent messages per text channel, and a deeper pull of the general
// channel. Also dumps the live channel→capability bindings from the bot DB.
//
// Sends NOTHING, mutates NOTHING. Run:
//   npx tsx scripts/survey-revz-server.ts [outFile]
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
   ChannelType,
   Client,
   GatewayIntentBits,
   type Guild,
   type GuildBasedChannel,
   type Message,
} from "discord.js";
import { config } from "../src/config.js";

const REVZ_GUILD_ID = "1435843683541979248";
const GENERAL_CHANNEL_ID = "1437237844966899742";
const OUT_FILE = process.argv[2] ?? "/tmp/revz-survey.md";

const MSG_LIMIT_PER_CHANNEL = 25;
const MSG_LIMIT_GENERAL = 100;
const MSG_TRUNC = 220;
const MSG_TRUNC_GENERAL = 400;

const lines: string[] = [];
const out = (line = "") => lines.push(line);

function fmtTime(m: Message): string {
   return m.createdAt.toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      hour12: false,
   });
}

function fmtMsg(m: Message, trunc: number): string {
   const author = m.author?.globalName ?? m.author?.username ?? "desconocido";
   let content = (m.content ?? "").replace(/\n+/g, " ⏎ ").trim();
   if (m.embeds.length > 0) content += ` [+${m.embeds.length} embed]`;
   if (m.attachments.size > 0) content += ` [+${m.attachments.size} adjunto]`;
   if (content.length > trunc) content = content.slice(0, trunc) + "…";
   return `- \`${fmtTime(m)}\` **${author}**: ${content || "_(sin texto)_"}`;
}

async function sampleChannel(
   ch: GuildBasedChannel,
   limit: number,
   trunc: number,
): Promise<void> {
   if (!ch.isTextBased() || !("messages" in ch)) return;
   try {
      const msgs = await ch.messages.fetch({ limit });
      const ordered = [...msgs.values()].reverse();
      for (const m of ordered) out(fmtMsg(m, trunc));
      if (ordered.length === 0) out("_(sin mensajes recientes)_");
   } catch (err) {
      out(
         `_(no se pudo leer: ${err instanceof Error ? err.message : String(err)})_`,
      );
   }
}

async function main(): Promise<void> {
   const client = new Client({
      intents: [
         GatewayIntentBits.Guilds,
         GatewayIntentBits.GuildMessages,
         GatewayIntentBits.MessageContent,
      ],
   });
   await client.login(config.DISCORD_TOKEN);
   await new Promise<void>((r) =>
      client.isReady() ? r() : client.once("ready", () => r()),
   );

   try {
      out("# Barrido del servidor Revolución Z");
      out(
         `_Generado: ${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })} (hora CDMX)_`,
      );
      out();

      out("## Guilds donde está el bot");
      for (const g of client.guilds.cache.values())
         out(`- ${g.name} (\`${g.id}\`)`);
      out();

      const guild: Guild = await client.guilds.fetch(REVZ_GUILD_ID);
      out(`## Servidor: ${guild.name}`);
      out(`- id: \`${guild.id}\``);
      out(`- descripción: ${guild.description ?? "_(ninguna)_"}`);
      out(`- miembros (aprox): ${guild.memberCount}`);
      out(`- canal de reglas: ${guild.rulesChannelId ?? "_(ninguno)_"}`);
      out(`- canal de sistema: ${guild.systemChannelId ?? "_(ninguno)_"}`);
      out();

      out("## Roles (de mayor a menor jerarquía)");
      const roles = await guild.roles.fetch();
      const sortedRoles = [...roles.values()].sort(
         (a, b) => b.position - a.position,
      );
      for (const r of sortedRoles) {
         if (r.id === guild.id) continue; // @everyone
         out(
            `- ${r.name} (\`${r.id}\`) — mencionable: ${r.mentionable ? "sí" : "no"}, miembros: ${r.members.size}`,
         );
      }
      out();

      // Bindings from the live bot DB (read-only).
      out("## Bindings actuales canal → capacidad (DB en vivo)");
      try {
         const here = dirname(fileURLToPath(import.meta.url));
         const dbPath = resolve(
            here,
            "..",
            config.CHOPPERBOT_DATA_DIR,
            "chopperbot.db",
         );
         const db = new Database(dbPath, { readonly: true });
         const rows = db.prepare("SELECT * FROM configuration_bindings").all();
         for (const row of rows) out(`- ${JSON.stringify(row)}`);
         if (rows.length === 0) out("_(sin bindings persistidos)_");
         db.close();
      } catch (err) {
         out(
            `_(no se pudo leer la DB: ${err instanceof Error ? err.message : String(err)})_`,
         );
      }
      out();

      const channels = await guild.channels.fetch();
      const cats = [...channels.values()]
         .filter(
            (c): c is GuildBasedChannel =>
               c != null && c.type === ChannelType.GuildCategory,
         )
         .sort((a, b) => a.position - b.position);
      const orphan = [...channels.values()].filter(
         (c): c is GuildBasedChannel =>
            c != null &&
            c.parentId == null &&
            c.type !== ChannelType.GuildCategory,
      );

      out("## Estructura de canales (con topics)");
      const typeLabel = (t: ChannelType): string =>
         ({
            [ChannelType.GuildText]: "texto",
            [ChannelType.GuildAnnouncement]: "anuncios",
            [ChannelType.GuildForum]: "foro",
            [ChannelType.GuildMedia]: "media",
            [ChannelType.GuildVoice]: "voz",
            [ChannelType.GuildStageVoice]: "stage",
         })[t] ?? `tipo ${t}`;

      const renderChannelLine = (c: GuildBasedChannel) => {
         const topic = "topic" in c && c.topic ? ` — _${c.topic}_` : "";
         out(`  - **${c.name}** (\`${c.id}\`, ${typeLabel(c.type)})${topic}`);
      };

      if (orphan.length > 0) {
         out("### (sin categoría)");
         orphan
            .sort((a, b) => a.position - b.position)
            .forEach(renderChannelLine);
      }
      for (const cat of cats) {
         out(`### 📁 ${cat.name} (\`${cat.id}\`)`);
         const children = [...channels.values()]
            .filter(
               (c): c is GuildBasedChannel =>
                  c != null && c.parentId === cat.id,
            )
            .sort((a, b) => a.position - b.position);
         children.forEach(renderChannelLine);
         out();
      }

      // Recent messages per text/announcement channel.
      out("## Muestra de mensajes recientes por canal");
      for (const cat of cats) {
         const children = [...channels.values()]
            .filter(
               (c): c is GuildBasedChannel =>
                  c != null && c.parentId === cat.id,
            )
            .sort((a, b) => a.position - b.position);
         for (const ch of children) {
            if (
               ch.type === ChannelType.GuildForum ||
               ch.type === ChannelType.GuildMedia
            ) {
               out(`### 🧵 #${ch.name} (foro — hilos activos)`);
               try {
                  const threads = await (
                     ch as typeof ch & {
                        threads: {
                           fetchActive: () => Promise<{
                              threads: Map<
                                 string,
                                 { name: string; id: string }
                              >;
                           }>;
                        };
                     }
                  ).threads.fetchActive();
                  for (const t of threads.threads.values())
                     out(`  - "${t.name}" (\`${t.id}\`)`);
                  if (threads.threads.size === 0)
                     out("  _(sin hilos activos)_");
               } catch (err) {
                  out(
                     `  _(no se pudieron listar hilos: ${err instanceof Error ? err.message : String(err)})_`,
                  );
               }
               out();
               continue;
            }
            if (
               !ch.isTextBased() ||
               ch.type === ChannelType.GuildVoice ||
               ch.type === ChannelType.GuildStageVoice
            )
               continue;
            const isGeneral = ch.id === GENERAL_CHANNEL_ID;
            out(
               `### #${ch.name} (\`${ch.id}\`)${isGeneral ? " — GENERAL, últimas ~1–2 h" : ""}`,
            );
            await sampleChannel(
               ch,
               isGeneral ? MSG_LIMIT_GENERAL : MSG_LIMIT_PER_CHANNEL,
               isGeneral ? MSG_TRUNC_GENERAL : MSG_TRUNC,
            );
            out();
         }
      }
      // Orphan text channels too.
      for (const ch of orphan) {
         if (!ch.isTextBased()) continue;
         out(`### #${ch.name} (\`${ch.id}\`, sin categoría)`);
         await sampleChannel(ch, MSG_LIMIT_PER_CHANNEL, MSG_TRUNC);
         out();
      }

      writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
      console.log(`✅ Survey escrito en ${OUT_FILE} (${lines.length} líneas)`);
   } finally {
      await client.destroy();
   }
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
