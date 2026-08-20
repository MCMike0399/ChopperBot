/**
 * The ticket's "se refleja solo" guard: an edit in a ticket only REFRESHES a
 * live Discord event — it never creates one. When the ticket's own event lost
 * its card (Discord completes events whose date passed — ticket-0006, Calibán
 * rescheduled 2026-08-13 while the mod was told the Discord event "se refleja
 * solo"), the watcher must recreate it deterministically and append the link.
 *
 * `ask` is mocked (driving the REAL tool handlers against an in-memory store);
 * the syncer is a fake via the makeEventSyncer seam.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, type Message } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from "../store.js";
import { CalendarStore, CALENDAR_MIGRATIONS } from "../../calendar/store.js";
import { EventIntakeWatcher } from "../watcher.js";
import type { DiscordEventSyncer } from "../../calendar/discord-events.js";

vi.mock("../../../log.js", () => ({
   log: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../../llm/client.js", () => ({ ask: vi.fn() }));
const { ask } = await import("../../../llm/client.js");
const askMock = vi.mocked(ask);

const TICKET_BOT = "557628352828014614";
const BOT = "999999999999999999";
const CHANNEL = "1534262938313953425";
const GUILD = "1435843683541979248";
const MOD_ROLE = "1436055845392879778";
const START = Date.parse("2026-08-12T02:00:00Z"); // Aug 11, 8:00 PM CDMX

interface Sent {
   content: string;
   allowedMentions?: {
      roles?: string[];
      parse?: string[];
      repliedUser?: boolean;
   };
}

const syncMock = vi.fn();
const refreshMock = vi.fn();
const fakeSyncer: DiscordEventSyncer = {
   sync: syncMock,
   refresh: refreshMock,
   remove: vi.fn(async () => ({ ok: true, action: "deleted" }) as never),
};

function makeMessage(opts: {
   content: string;
   memberRoles: string[];
   sent: Sent[];
}): Message {
   const reply = vi.fn(async (payload: string | Sent) => {
      opts.sent.push(
         typeof payload === "string" ? { content: payload } : payload,
      );
      return { id: "posted-1", reply: vi.fn() } as unknown as Message;
   });
   return {
      id: "msg-1",
      channelId: CHANNEL,
      guildId: GUILD,
      author: { id: "mod-1", bot: false, tag: "mod#0001" },
      content: opts.content,
      embeds: [],
      member: {
         roles: {
            cache: {
               map: <T>(fn: (r: { id: string; name: string }) => T) =>
                  opts.memberRoles.map((id) => fn({ id, name: id })),
            },
         },
         permissions: { has: () => false },
      },
      mentions: {
         users: { has: (id: string) => id === BOT },
         repliedUser: null,
      },
      reference: null,
      inGuild: () => true,
      react: vi.fn(async () => null),
      guild: {
         id: GUILD,
         members: { me: { id: BOT }, fetch: vi.fn() },
         roles: {
            cache: {
               size: 1,
               map: <T>(
                  fn: (r: {
                     id: string;
                     name: string;
                     mentionable: boolean;
                  }) => T,
               ) => [
                  fn({
                     id: MOD_ROLE,
                     name: "🚓Moderación🚓",
                     mentionable: true,
                  }),
               ],
            },
            fetch: vi.fn(),
         },
      },
      channel: {
         isThread: () => false,
         isSendable: () => true,
         sendTyping: vi.fn(async () => {}),
         send: vi.fn(),
         messages: { fetch: vi.fn(async () => new Map()) },
         permissionsFor: () => ({
            has: (flag: bigint) =>
               flag === PermissionFlagsBits.MentionEveryone ? false : true,
         }),
      },
      reply,
   } as unknown as Message;
}

async function newWatcher() {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   await new NamespacedMemory(mem, "event_intake").migrate(
      "event_intake",
      EVENT_INTAKE_MIGRATIONS,
   );
   await new NamespacedMemory(mem, "calendar").migrate(
      "calendar",
      CALENDAR_MIGRATIONS,
   );
   const store = new EventIntakeStore(mem.db());
   const calendarStore = new CalendarStore(mem.db());
   const watcher = new EventIntakeWatcher({
      store,
      calendarStore,
      client: { user: { id: BOT } } as never,
      botUserId: BOT,
      ticketBotId: TICKET_BOT,
      getModRoles: () => [MOD_ROLE],
      getAgitpropChannelId: () => null,
      getAgitpropRoles: () => [],
      makeEventSyncer: () => fakeSyncer,
      now: () => Date.parse("2026-08-04T18:00:00Z"),
   });
   return { watcher, store, calendarStore, mem };
}

/** Seed the ticket + the calendar event the ticket approved. */
async function seedApprovedEvent(
   store: EventIntakeStore,
   calendarStore: InstanceType<typeof CalendarStore>,
   opts: { linked?: boolean } = {},
) {
   store.recordProposal({
      channelId: CHANNEL,
      guildId: GUILD,
      requesterId: "187289179871248384",
      parsedForm: {
         title: "Conversatorio: DataCenters",
         dayRaw: "martes 11 de agosto",
         timeRaw: "8pm",
         speaker: "Burbuja",
         flyerSelf: false,
         pairs: [],
      },
      resolvedStartAt: null,
      proposalMessageId: "posted-1",
   });
   const event = calendarStore.create({
      created_by: "mod-1",
      title: "Conversatorio: DataCenters",
      start_at: START,
   });
   if (opts.linked) calendarStore.setDiscordEventId(event.id, "DE1");
   store.markCreated(CHANNEL, event.id);
   return event;
}

beforeEach(() => {
   askMock.mockReset();
   syncMock.mockReset().mockResolvedValue({
      ok: true,
      discordEventId: "DE2",
      url: "https://discord.com/events/G/DE2",
      created: true,
      startAtLocal: "Tue, Aug 11, 8:00 PM",
      imageSet: false,
      venue: { kind: "stage", name: "Sala de Eventos" },
   });
   refreshMock.mockReset().mockResolvedValue({
      ok: true,
      action: "updated",
      url: "https://discord.com/events/G/DE1",
      changed: ["fecha/hora"],
   });
});

describe("ticket edit → Discord event repair", () => {
   test("an edit to the ticket's OWN event with no live card recreates it and appends the link", async () => {
      const { watcher, store, calendarStore, mem } = await newWatcher();
      const event = await seedApprovedEvent(store, calendarStore); // unlinked, like the completed Calibán card
      refreshMock.mockResolvedValue({ ok: true, action: "not_linked" });
      askMock.mockImplementation(async (input) => {
         await input?.tools?.handle("calendar_update_event", {
            id: event.id,
            start_at_iso: "2026-08-17T02:00:00Z",
         });
         return "Listo, lo reagendé para el domingo 16 a las 8:00 PM.";
      });
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            content: `<@${BOT}> reagéndalo al domingo 16`,
            memberRoles: [MOD_ROLE],
            sent,
         }),
      );
      expect(syncMock).toHaveBeenCalledWith(event.id, expect.anything());
      expect(sent[0].content).toContain(
         "📅 Ya creé también el **evento de Discord**",
      );
      expect(sent[0].content).toContain("https://discord.com/events/G/DE2");
      mem.close();
   });

   test("an edit to a LINKED event appends nothing (the update propagation refreshed it)", async () => {
      const { watcher, store, calendarStore, mem } = await newWatcher();
      const event = await seedApprovedEvent(store, calendarStore, {
         linked: true,
      });
      askMock.mockImplementation(async (input) => {
         await input?.tools?.handle("calendar_update_event", {
            id: event.id,
            title: "Conversatorio: Data Centers",
         });
         return "Listo, corregí el título.";
      });
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            content: `<@${BOT}> corrige el título`,
            memberRoles: [MOD_ROLE],
            sent,
         }),
      );
      expect(refreshMock).toHaveBeenCalledWith(event.id);
      expect(syncMock).not.toHaveBeenCalled();
      expect(sent[0].content).not.toContain("📅");
      mem.close();
   });

   test("an edit to some OTHER event never spawns a card from the ticket", async () => {
      const { watcher, store, calendarStore, mem } = await newWatcher();
      await seedApprovedEvent(store, calendarStore); // the ticket's own event
      const other = calendarStore.create({
         created_by: "mod-1",
         title: "Otro evento",
         start_at: START,
      });
      refreshMock.mockResolvedValue({ ok: true, action: "not_linked" });
      askMock.mockImplementation(async (input) => {
         await input?.tools?.handle("calendar_update_event", {
            id: other.id,
            title: "Otro título",
         });
         return "Listo.";
      });
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            content: `<@${BOT}> cambia el otro evento`,
            memberRoles: [MOD_ROLE],
            sent,
         }),
      );
      expect(syncMock).not.toHaveBeenCalled();
      expect(sent[0].content).not.toContain("📅");
      mem.close();
   });

   test("the mod bundle includes calendar_set_session_theme; a non-mod bundle never does", async () => {
      const { watcher, store, calendarStore, mem } = await newWatcher();
      await seedApprovedEvent(store, calendarStore);
      let modTools: string[] = [];
      askMock.mockImplementation(async (input) => {
         modTools = (input?.tools?.tools ?? []).map((t) => t.name);
         return "Va.";
      });
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            content: `<@${BOT}> hola`,
            memberRoles: [MOD_ROLE],
            sent,
         }),
      );
      expect(modTools).toContain("calendar_set_session_theme");
      expect(modTools).toContain("calendar_create_event");

      let nonModTools: string[] = [];
      askMock.mockImplementation(async (input) => {
         nonModTools = (input?.tools?.tools ?? []).map((t) => t.name);
         return "Va.";
      });
      const msg = makeMessage({
         content: `<@${BOT}> hola`,
         memberRoles: [],
         sent,
      });
      (msg as { author: { id: string } }).author.id = "187289179871248384"; // the requester, not a mod
      await watcher.handleMessage(msg);
      expect(nonModTools).not.toContain("calendar_set_session_theme");
      expect(nonModTools).not.toContain("calendar_create_event");
      expect(nonModTools).toContain("calendar_search_events");
      mem.close();
   });
});
