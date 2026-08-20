/**
 * Post an ADVANCE announcement for one calendar event — the "avísale ya a la
 * comunidad" tool the daily announcer deliberately doesn't cover (it only
 * posts on the day itself, and only if the occurrence hasn't started yet).
 *
 * Drives the same machinery as the daily path where it exists: the voice
 * prompt (`renderAnnouncementPrompt` with the 'advance' framing), the
 * announce-channel settings, the mention policy, and the Discord-event link
 * appended at the end. Preview by default; `--post` actually sends.
 *
 *   npx tsx scripts/announce-upcoming-event.ts <eventId>                 # preview, first future occurrence
 *   npx tsx scripts/announce-upcoming-event.ts 33 --date 2026-08-20      # preview a specific occurrence
 *   npx tsx scripts/announce-upcoming-event.ts 33 --post                 # actually post
 *
 * It NEVER writes to the announcements ledger: the same occurrence still gets
 * its automatic day-of announcement that morning. This tool is the early
 * heads-up, not a replacement for it.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../src/config.js";
import { SqliteMemoryStore } from "../src/memory/store.js";
import {
   CALENDAR_MIGRATIONS,
   CalendarStore,
} from "../src/capabilities/calendar/store.js";
import { resolveAnnounceSettings } from "../src/capabilities/calendar/announce-settings.js";
import {
   appendEventLink,
   prefixMentions,
   renderAnnounceMentions,
   renderAnnouncementPrompt,
   type AnnounceTarget,
} from "../src/capabilities/calendar/announce.js";
import {
   fetchScheduledEvent,
   fetchScheduledEvents,
} from "../src/capabilities/calendar/discord-events.js";
import { localParts } from "../src/capabilities/calendar/grid.js";
import { formatInTimezone } from "../src/capabilities/calendar/time.js";
import { ask } from "../src/llm/client.js";
import { composeToolSources } from "../src/tools/source.js";

const NO_TOOLS = composeToolSources([]);

const args = process.argv.slice(2);
const POST = args.includes("--post");
const dateIdx = args.indexOf("--date");
const dateArg = dateIdx >= 0 ? args[dateIdx + 1] : null;
const eventId = Number(args.find((a) => !a.startsWith("--") && a !== dateArg));

async function main(): Promise<void> {
   if (!Number.isInteger(eventId)) {
      console.error(
         "Uso: npx tsx scripts/announce-upcoming-event.ts <eventId> [--date YYYY-MM-DD] [--post]",
      );
      process.exit(1);
   }

   const dbPath = resolve(
      process.cwd(),
      config.CHOPPERBOT_DATA_DIR,
      "chopperbot.db",
   );
   const memory = new SqliteMemoryStore({ path: dbPath });
   await memory.migrate("calendar", CALENDAR_MIGRATIONS);
   const store = new CalendarStore(memory.db());

   const event = store.get(eventId);
   if (!event) {
      console.error(`No existe el evento #${eventId}.`);
      memory.close();
      process.exit(1);
   }

   // Pick the occurrence: the one on --date's local day, else the first future one.
   const now = Date.now();
   const occurrences = store
      .listOccurrences(now, now + 90 * 86_400_000)
      .filter((o) => o.id === eventId);
   let picked = occurrences[0];
   if (dateArg) {
      picked = occurrences.find((o) => {
         const p = localParts(o.start_at);
         return (
            `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` ===
            dateArg
         );
      });
   }
   if (!picked) {
      console.error(
         `El evento #${eventId} no tiene ocurrencias futuras${dateArg ? ` el ${dateArg}` : ""} (ventana de 90 días).`,
      );
      memory.close();
      process.exit(1);
   }
   console.log(`=== Aviso anticipado de evento ===`);
   console.log(`evento            : #${event.id} ${event.title}`);
   console.log(`ocurrencia        : ${formatInTimezone(picked.start_at)}`);
   console.log(
      `modo              : ${POST ? "PUBLICAR" : "PREVIEW (no publica)"}`,
   );

   const settings = resolveAnnounceSettings(store);
   if (!settings.channelId) {
      console.error("No hay canal de anuncios configurado.");
      memory.close();
      process.exit(1);
   }

   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   await new Promise<void>((res, rej) => {
      client.once("clientReady", () => res());
      client.once("error", rej);
      void client.login(config.DISCORD_TOKEN).catch(rej);
   });

   const channel = await client.channels
      .fetch(settings.channelId)
      .catch(() => null);
   const guildId =
      channel && "guildId" in channel
         ? (channel.guildId as string | null)
         : null;
   if (!channel || !channel.isTextBased() || !("send" in channel) || !guildId) {
      console.error("El canal de anuncios no es accesible.");
      await client.destroy();
      memory.close();
      process.exit(1);
   }

   // The Discord-event link: only a stored, verified link (no guessing — a wrong
   // link sends the community to somebody else's event).
   let discordEvent = null;
   if (event.discord_event_id) {
      const events = await fetchScheduledEvents(client, guildId);
      discordEvent =
         events?.find((e) => e.id === event.discord_event_id) ??
         (await fetchScheduledEvent(client, guildId, event.discord_event_id));
   }
   if (!discordEvent) {
      console.log(
         "aviso            : sin evento de Discord enlazado — el aviso saldría SIN enlace",
      );
   }

   const target: AnnounceTarget = {
      occurrence: {
         id: picked.id,
         title: picked.title,
         description: picked.description,
         location: picked.location,
         startAtMs: picked.start_at,
      },
      discordEvent,
      discordEventUrl: discordEvent?.url ?? null,
   };

   const body = (
      await ask({
         system: renderAnnouncementPrompt(target, now, "advance"),
         messages: [{ role: "user", content: "Escribe el aviso." }],
         tools: NO_TOOLS,
      })
   ).trim();
   if (body.length < 20) {
      // No same-day template fallback here (its framing would be wrong) — a human
      // is running this, so fail loudly instead.
      console.error(
         `El modelo devolvió un texto demasiado corto (${body.length} chars): "${body}"`,
      );
      await client.destroy();
      memory.close();
      process.exit(1);
   }

   const mentions = renderAnnounceMentions(settings.mentions);
   const text = prefixMentions(
      appendEventLink(body, target.discordEventUrl),
      mentions.text,
   );

   console.log("  ──── mensaje ────");
   console.log(
      text
         .split("\n")
         .map((l) => `  │ ${l}`)
         .join("\n"),
   );

   if (POST) {
      const sent = await (
         channel as {
            send(o: {
               content: string;
               allowedMentions: { parse: string[]; roles: string[] };
               nonce?: string;
               enforceNonce?: boolean;
            }): Promise<{ id: string }>;
         }
      ).send({
         content: text,
         allowedMentions: {
            parse: mentions.everyone ? ["everyone"] : [],
            roles: mentions.roleIds,
         },
         // Idempotent within Discord's dedup window: a retried run can't double-post.
         nonce: `manual:${eventId}@${picked.start_at}`,
         enforceNonce: true,
      });
      console.log(
         `\nPublicado: mensaje ${sent.id} en #${"name" in channel ? channel.name : settings.channelId}`,
      );
      console.log(
         "(sin fila en el ledger — el anuncio automático del día sigue programado)",
      );
   } else {
      console.log(
         "\nPreview — nada publicado. Repite con --post para publicar.",
      );
   }

   await client.destroy();
   memory.close();
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
