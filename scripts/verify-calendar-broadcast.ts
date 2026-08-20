/**
 * Read-only proof for on-demand announcements (`calendar_draft_announcement` →
 * `calendar_send_announcement`), driven against the LIVE guild and the LIVE
 * calendar DB.
 *
 * It replays the exchange the feature came from — a mod naming an event and a
 * few channels, in their own words — through the REAL tool source, the REAL
 * channel matcher and the REAL model, and prints:
 *
 *   • how each channel word resolved (and why, when it didn't),
 *   • the exact message that would be posted, byte for byte,
 *   • the parked draft token and what `calendar_send_announcement` would do.
 *
 * It **posts nothing**: the draft step is by construction post-free, and the
 * send step is only *described* unless you pass `--send`. Use `--send` only
 * when you mean to put a real message in real community channels.
 *
 *   npx tsx scripts/verify-calendar-broadcast.ts 38 eventos general "foro poesia"
 *   npx tsx scripts/verify-calendar-broadcast.ts 38 general --say "que diga bandaaaa"
 *   npx tsx scripts/verify-calendar-broadcast.ts 38 general --send   # REALLY posts
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
import { CalendarToolSource } from "../src/capabilities/calendar/source.js";
import { createBroadcaster } from "../src/capabilities/calendar/broadcast-channels.js";
import { resolveAnnounceSettings } from "../src/capabilities/calendar/announce-settings.js";
import { fetchScheduledEvent } from "../src/capabilities/calendar/discord-events.js";
import { formatInTimezone } from "../src/capabilities/calendar/time.js";
import { ask } from "../src/llm/client.js";
import { composeToolSources } from "../src/tools/source.js";

const args = process.argv.slice(2);
const SEND = args.includes("--send");
const sayIdx = args.indexOf("--say");
const instruction = sayIdx >= 0 ? (args[sayIdx + 1] ?? null) : null;
const positional = args.filter(
   (a, i) => !a.startsWith("--") && i !== sayIdx + 1,
);
const eventId = Number(positional[0]);
const channels = positional.slice(1);

/** The live calendar management channel — where a mod would be asking. */
const CALENDAR_CHANNEL_ID = "1483675563871961248";

function box(label: string, text: string): void {
   console.log(`  ──── ${label} ────`);
   console.log(
      text
         .split("\n")
         .map((l) => `  │ ${l}`)
         .join("\n"),
   );
}

async function main(): Promise<void> {
   if (!Number.isInteger(eventId) || channels.length === 0) {
      console.error(
         'Uso: npx tsx scripts/verify-calendar-broadcast.ts <eventId> <canal…> [--say "lo que pidió la mod"] [--send]',
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

   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   await new Promise<void>((res, rej) => {
      client.once("clientReady", () => res());
      client.once("error", rej);
      void client.login(config.DISCORD_TOKEN).catch(rej);
   });

   const channel = await client.channels
      .fetch(CALENDAR_CHANNEL_ID)
      .catch(() => null);
   const guildId =
      channel && "guildId" in channel
         ? (channel.guildId as string | null)
         : null;
   if (!guildId) {
      console.error(
         "No pude resolver el servidor desde el canal del calendario.",
      );
      await client.destroy();
      memory.close();
      process.exit(1);
   }

   const settings = resolveAnnounceSettings(store);
   console.log("=== Anuncio a pedido (verificación) ===");
   console.log(`evento            : #${event.id} ${event.title}`);
   console.log(`inicio            : ${formatInTimezone(event.start_at)}`);
   console.log(`canales pedidos   : ${channels.join(", ")}`);
   console.log(`instrucción       : ${instruction ?? "(ninguna)"}`);
   console.log(
      `menciones permit. : ${settings.mentions.length > 0 ? settings.mentions.join(", ") : "(ninguna)"}`,
   );
   console.log(
      `modo              : ${SEND ? "PUBLICAR DE VERDAD" : "solo redactar (no publica)"}`,
   );

   const source = new CalendarToolSource(
      store,
      "verify-script",
      Date.now(),
      undefined,
      {
         broadcaster: createBroadcaster({ client, guildId }),
         writeAnnouncement: (system) =>
            ask({
               system,
               messages: [{ role: "user", content: "Escribe el anuncio." }],
               tools: composeToolSources([]),
            }),
         allowedMentionTokens: settings.mentions,
         sourceChannelId: CALENDAR_CHANNEL_ID,
         getDiscordEvent: (id) => fetchScheduledEvent(client, guildId, id),
      },
   );

   const draft = await source.handle("calendar_draft_announcement", {
      event_id: eventId,
      channels,
      ...(instruction ? { instruction } : {}),
   });
   const p = draft.payload as Record<string, unknown>;
   console.log(`\npaso 1 (draft)    : ${draft.status}`);
   if (draft.status !== "success") {
      console.log(JSON.stringify(p, null, 2));
      await client.destroy();
      memory.close();
      process.exit(1);
   }

   const targets = p.channels as Array<{
      name: string;
      mention: string;
      posts_as?: string;
      post_title?: string;
   }>;
   console.log(
      `canales resueltos : ${targets.map((c) => `#${c.name}${c.posts_as ? ` (${c.posts_as})` : ""}`).join(", ")}`,
   );
   const forum = targets.find((c) => c.post_title);
   if (forum) console.log(`título del post   : ${forum.post_title}`);
   if (p.problems)
      console.log(`sin resolver      : ${JSON.stringify(p.problems)}`);
   console.log(
      `enlace del evento : ${p.has_event_link ? "sí" : "NO (saldría sin botón de apuntarse)"}`,
   );
   console.log(`token             : ${p.token}`);
   console.log("");
   box("mensaje que se publicaría", String(p.draft));

   if (!SEND) {
      console.log("\nNada publicado (el paso 1 nunca publica).");
      console.log(
         `Para publicarlo de verdad: repite con --send, o en Discord confirma el token ${p.token}.`,
      );
      await client.destroy();
      memory.close();
      return;
   }

   const sent = await source.handle("calendar_send_announcement", {
      token: p.token,
   });
   console.log(`\npaso 2 (send)     : ${sent.status}`);
   console.log(JSON.stringify(sent.payload, null, 2));

   // Prove the single-use guarantee against the live DB, not just in tests.
   const again = await source.handle("calendar_send_announcement", {
      token: p.token,
   });
   console.log(
      `reintento         : ${again.status} — ${JSON.stringify(again.payload)}`,
   );

   await client.destroy();
   memory.close();
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
