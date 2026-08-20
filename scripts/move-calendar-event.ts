/**
 * Move a calendar event to a new LOCAL start time, then republish the month
 * cards + ICS through the real publisher — the same code path the capability
 * runs after any calendar mutation, so the output channel ends up exactly as
 * if a mod had asked the bot to move it.
 *
 * For a recurring series this re-anchors the WHOLE series: occurrences are
 * derived from `start_at`, so shifting it shifts every occurrence. `end_at`
 * and `recurrence_until` (when set) shift by the same delta, preserving
 * duration and series length. It does NOT touch the linked Discord scheduled
 * event — check it still matches afterwards (the syncer owns that surface).
 *
 *   npx tsx scripts/move-calendar-event.ts <eventId> <YYYY-MM-DD> <HH:MM>
 *   npx tsx scripts/move-calendar-event.ts 33 2026-08-20 15:00 --no-publish
 *
 * Dates/times are America/Mexico_City wall clock (fixed UTC-6), matching how
 * the calendar tools take them from mods.
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
import { OutputChannelPublisher } from "../src/capabilities/calendar/publisher.js";
import {
   formatInTimezone,
   WALL_CLOCK_OFFSET_MS,
} from "../src/capabilities/calendar/time.js";

const [idArg, dateArg, timeArg] = process.argv
   .slice(2)
   .filter((a) => !a.startsWith("--"));
const NO_PUBLISH = process.argv.includes("--no-publish");

async function main(): Promise<void> {
   const eventId = Number(idArg);
   const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateArg ?? "");
   const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeArg ?? "");
   if (!Number.isInteger(eventId) || !dateMatch || !timeMatch) {
      console.error(
         "Uso: npx tsx scripts/move-calendar-event.ts <eventId> <YYYY-MM-DD> <HH:MM> [--no-publish]",
      );
      process.exit(1);
   }
   const [, ys, mos, ds] = dateMatch;
   const [, hs, mis] = timeMatch;
   // Local wall clock → true UTC instant (see time.ts for the fixed-offset rule).
   const newStartMs =
      Date.UTC(
         Number(ys),
         Number(mos) - 1,
         Number(ds),
         Number(hs),
         Number(mis),
      ) - WALL_CLOCK_OFFSET_MS;

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

   const delta = newStartMs - event.start_at;
   console.log(`#${event.id} ${event.title}`);
   console.log(`  inicio actual : ${formatInTimezone(event.start_at)}`);
   console.log(`  inicio nuevo  : ${formatInTimezone(newStartMs)}`);
   if (delta === 0) {
      console.log("Misma fecha — nada que hacer.");
      memory.close();
      return;
   }

   const updated = store.update(eventId, {
      start_at: newStartMs,
      ...(event.end_at != null ? { end_at: event.end_at + delta } : {}),
      ...(event.recurrence_until != null
         ? { recurrence_until: event.recurrence_until + delta }
         : {}),
   });
   console.log(
      `  guardado      : ${formatInTimezone(updated!.start_at)} (recurrencia: ${updated!.recurrence_freq ?? "no"})`,
   );

   console.log("\nPróximas ocurrencias (45 días):");
   const now = Date.now();
   for (const o of store.listOccurrences(now, now + 45 * 86_400_000)) {
      if (o.id === eventId) console.log(`  ${formatInTimezone(o.start_at)}`);
   }

   if (NO_PUBLISH) {
      console.log("\n--no-publish: tarjetas/ICS NO republicados.");
      memory.close();
      return;
   }

   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   await new Promise<void>((res, rej) => {
      client.once("clientReady", () => res());
      client.once("error", rej);
      void client.login(config.DISCORD_TOKEN).catch(rej);
   });
   const publisher = new OutputChannelPublisher({
      client,
      store,
      projectRoot: process.cwd(),
      getOutputChannelId: () =>
         store.getOutputChannelId() ??
         config.CALENDAR_OUTPUT_CHANNEL_ID ??
         null,
   });
   const summary = await publisher.reconcile();
   console.log(
      `\nRepublicación: ${summary.ok ? `ok — publicados [${summary.posted.join(", ")}]` : `FALLÓ: ${summary.error}`}` +
         (summary.removed.length > 0
            ? `, retirados [${summary.removed.join(", ")}]`
            : ""),
   );
   await client.destroy();
   memory.close();
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
