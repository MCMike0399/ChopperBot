// One-off proof for v1.20.0: drive the REAL text model with the ticket's mod
// prompt + the REAL calendar tool bundle a ticket now builds, and check that
// "cancélalo" actually reaches `calendar_delete_event`.
//
// Three scenes: cancel a whole event, cancel ONE session of a series (the model
// must confirm the scope first), then confirm it.
//
// Safe: an in-memory SQLite calendar (NEVER the live DB), no publisher, no
// Discord syncer, nothing posted anywhere. Spends a little model budget.
// NOTE: with no publisher wired, every tool result carries
// `published: {ok:false, error:'publishing_disabled'}`, so the model may say the
// calendar wasn't republished — that is the script, not the bot: the watcher
// passes the real publisher on a mod turn.
//
//   npx tsx scripts/verify-ticket-cancel.ts
import "dotenv/config";
import { SqliteMemoryStore, NamespacedMemory } from "../src/memory/store.js";
import {
   CalendarStore,
   CALENDAR_MIGRATIONS,
} from "../src/capabilities/calendar/store.js";
import { CalendarToolSource } from "../src/capabilities/calendar/source.js";
import { composeToolSources } from "../src/tools/source.js";
import { renderTicketConversationPrompt } from "../src/capabilities/event_intake/preamble.js";
import { ask } from "../src/llm/client.js";

const READ_TOOLS = [
   "calendar_search_events",
   "calendar_list_upcoming",
   "calendar_get_event",
];
const MOD_TOOLS = [
   "calendar_create_event",
   "calendar_update_event",
   "calendar_delete_event",
   "calendar_sync_discord_event",
   "calendar_set_session_theme",
   "calendar_publish",
];

async function main(): Promise<void> {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "calendar").migrate(
      "calendar",
      CALENDAR_MIGRATIONS,
   );
   const store = new CalendarStore(mem.db());
   const now = Date.now();
   const event = store.create({
      created_by: "mod-1",
      title: "Conversatorio: DataCenters",
      start_at: now + 4 * 86_400_000,
      location: "Sala de Eventos",
   });
   const weekly = store.create({
      created_by: "mod-1",
      title: "Cine Club",
      start_at: now + 2 * 86_400_000,
      recurrence_freq: "weekly",
   });
   console.log(`seed: #${event.id} one-off, #${weekly.id} weekly`);

   const calls: Array<{ name: string; input: unknown }> = [];
   const inner = new CalendarToolSource(store, "mod-1", now, undefined, {
      include: [...READ_TOOLS, ...MOD_TOOLS],
      allowWrite: true,
   });
   const tools = composeToolSources([
      {
         name: inner.name,
         systemPromptSection: () => inner.systemPromptSection(),
         tools: () => inner.tools(),
         async handle(name, input) {
            calls.push({ name, input });
            return inner.handle(name, input);
         },
      },
   ]);

   console.log("tools advertised:", tools.tools.map((t) => t.name).join(", "));

   const system = renderTicketConversationPrompt({
      now: new Date(now),
      parsed: {
         title: "Conversatorio: DataCenters",
         dayRaw: "martes",
         timeRaw: "8pm",
         speaker: "Burbuja",
         flyerSelf: false,
         pairs: [],
      },
      requesterId: "187289179871248384",
      isMod: true,
      modMention: "<@&1436055845392879778>",
   });

   // Scene 1 — whole-event cancellation, already confirmed by the mod.
   const reply1 = await ask({
      system,
      messages: [
         {
            role: "user",
            content:
               "oye, el conversatorio de DataCenters se cae, ya no se va a hacer",
         },
         {
            role: "assistant",
            content:
               "¿Te refieres a **Conversatorio: DataCenters**? Lo cancelo y lo saco del calendario.",
         },
         { role: "user", content: "sí, ese, cancélalo" },
      ],
      tools,
      effort: "high",
   });
   console.log("\n— escena 1 (cancelar todo) —\n" + reply1);
   console.log("tool calls:", JSON.stringify(calls, null, 0));

   // Scene 2 — only this week's session of a series.
   calls.length = 0;
   const reply2 = await ask({
      system,
      messages: [
         {
            role: "user",
            content:
               "esta semana no hay cine club, cancela solo esa sesión porfa",
         },
      ],
      tools,
      effort: "high",
   });
   console.log("\n— escena 2 (cancelar una sesión) —\n" + reply2);
   console.log("tool calls:", JSON.stringify(calls, null, 0));
   // Scene 3 — the mod confirms scene 2: only that session, series survives.
   const asked = calls.length === 1; // scene 2 asked instead of deleting (the confirm rule)
   calls.length = 0;
   const reply3 = await ask({
      system,
      messages: [
         {
            role: "user",
            content:
               "esta semana no hay cine club, cancela solo esa sesión porfa",
         },
         { role: "assistant", content: reply2 },
         { role: "user", content: "sí, solo esa sesión" },
      ],
      tools,
      effort: "high",
   });
   console.log("\n— escena 3 (confirmada) —\n" + reply3);
   console.log("tool calls:", JSON.stringify(calls, null, 0));

   const series = store.get(weekly.id);
   console.log("\nescena 2 confirmó antes de borrar:", asked);
   console.log(
      "serie sigue viva:",
      series !== null,
      "| one-off borrado:",
      store.get(event.id) === null,
   );
   console.log(
      "ocurrencias canceladas:",
      JSON.stringify(
         store
            .listOverridesForMaster(weekly.id)
            .map((o) => ({
               at: o.occurrence_start_at,
               cancelled: o.cancelled,
            })),
      ),
   );
   mem.close();
}

main().catch((err) => {
   console.error(err);
   process.exit(1);
});
