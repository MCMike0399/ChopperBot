/**
 * Recovering a ticket whose form was MISSED live (downtime, a wedged gateway —
 * ticket-0007, 2026-08-10: the form's MessageCreate never arrived, no row was
 * ever recorded). The history rescan now PAGES backwards (the old 25-message
 * window was buried by one evening of chatter, and the not-an-event-ticket
 * guardrail then went silent on a real event request), and a form found this
 * way is PERSISTED so recognition no longer depends on how much people chat.
 *
 * `ask` is mocked; the calendar tool handlers are real (in-memory store).
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
const CHANNEL = "1536476816636776458";
const GUILD = "1435843683541979248";
const MOD_ROLE = "1436055845392879778";
const REQUESTER = "954931114395447318";
const FORM_ID = "1536476819690360923";

const FORM_DESCRIPTION = [
   "**¿Cuál es el título o tema de tu círculo?** ```La deshumanisante vivencia de la mente neurodivergente```",
   "**¿Qué día gustas realizarlo?** ```Domingo y Lunes```",
   "**¿A qué hora gustas realizarlo?** ```5 pm```",
   "**Escribe el nombre del ponente(s)** ```Mermelada```",
   "**¿Quieres hacer tú el flyer/imagen del evento?** ```Nel```",
].join(" ");

/** A raw history entry, as shallow as toMessageLike/isEventForm need. */
interface HistoryMsg {
   id: string;
   authorId: string;
   bot: boolean;
   content: string;
   embeds: Array<{ description: string }>;
   createdTimestamp: number;
}

function formMessage(): HistoryMsg {
   return {
      id: FORM_ID,
      authorId: TICKET_BOT,
      bot: true,
      content: `Bienvenidx <@${REQUESTER}> :D`,
      embeds: [{ description: FORM_DESCRIPTION }],
      createdTimestamp: Number(BigInt(FORM_ID) >> 22n),
   };
}

/** `count` chatter messages newer than the form, newest first. */
function chatter(count: number, fromId: bigint): HistoryMsg[] {
   const out: HistoryMsg[] = [];
   for (let i = 0; i < count; i++) {
      const id = (fromId + BigInt(count - i)).toString();
      out.push({
         id,
         authorId: "user-1",
         bot: false,
         content: "cotorreo",
         embeds: [],
         createdTimestamp: i + 1,
      });
   }
   return out;
}

/**
 * Serves `history` (newest first) in `limit`-sized pages like the Discord API.
 * Plain Map — the watcher only needs size/iteration.
 */
function pagedFetch(history: HistoryMsg[]) {
   return vi.fn(async (opts: { limit: number; before?: string }) => {
      const beforeId = opts.before !== undefined ? BigInt(opts.before) : null;
      const page = history
         .filter((m) => beforeId === null || BigInt(m.id) < beforeId)
         .slice(0, opts.limit);
      const map = new Map<string, unknown>();
      for (const m of page) {
         map.set(m.id, {
            id: m.id,
            author: { id: m.authorId, bot: m.bot },
            content: m.content,
            embeds: m.embeds,
            attachments: new Map(),
            createdTimestamp: m.createdTimestamp,
         });
      }
      return map;
   });
}

interface Sent {
   content: string;
   allowedMentions?: {
      roles?: string[];
      parse?: string[];
      repliedUser?: boolean;
   };
}

function makeMention(history: HistoryMsg[], sent: Sent[]): Message {
   const reply = vi.fn(async (payload: string | Sent) => {
      sent.push(typeof payload === "string" ? { content: payload } : payload);
      return { id: "posted-1", reply: vi.fn() } as unknown as Message;
   });
   return {
      id: history[0]?.id ?? "msg-1",
      channelId: CHANNEL,
      guildId: GUILD,
      author: { id: "mod-1", bot: false, tag: "mod#0001" },
      content: `<@${BOT}> revisa el evento`,
      embeds: [],
      attachments: new Map(),
      member: {
         roles: {
            cache: {
               map: <T>(fn: (r: { id: string; name: string }) => T) =>
                  [MOD_ROLE].map((id) => fn({ id, name: id })),
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
         messages: { fetch: pagedFetch(history) },
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
   const fakeSyncer: DiscordEventSyncer = {
      sync: vi.fn(
         async () =>
            ({
               ok: true,
               discordEventId: "DE9",
               url: "u",
               created: true,
            }) as never,
      ),
      refresh: vi.fn(async () => ({ ok: true, action: "not_linked" }) as never),
      remove: vi.fn(async () => ({ ok: true, action: "deleted" }) as never),
   };
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
      now: () => Date.parse("2026-08-15T18:00:00Z"),
   });
   return { watcher, store, calendarStore, mem };
}

beforeEach(() => {
   askMock.mockReset();
});

describe("ticket form recovery from history", () => {
   test("a form buried past the first 100 messages is found, answered, and PERSISTED", async () => {
      const { watcher, store, mem } = await newWatcher();
      // The form sits 130 messages back — invisible to the old 25-message window
      // and even to a single 100-message page.
      const history = [...chatter(130, BigInt(FORM_ID)), formMessage()];
      askMock.mockImplementation(async () => "Va, lo reviso.");
      const sent: Sent[] = [];

      await watcher.handleMessage(makeMention(history, sent));

      expect(askMock).toHaveBeenCalledTimes(1);
      expect(sent.length).toBeGreaterThan(0);
      const row = store.getTicket(CHANNEL);
      expect(row?.status).toBe("proposed");
      expect(row?.requester_id).toBe(REQUESTER);
      expect(row?.parsed_form_json).toContain("neurodivergente");
      mem.close();
   });

   test("approval on a RECOVERED row completes the ticket bookkeeping (markCreated lands)", async () => {
      const { watcher, store, mem } = await newWatcher();
      const history = [...chatter(30, BigInt(FORM_ID)), formMessage()];
      let createdId: number | undefined;
      askMock.mockImplementation(async (input) => {
         const res = await input?.tools?.handle("calendar_create_event", {
            title: "La deshumanisante vivencia de la mente neurodivergente",
            start_at_iso: "2026-08-16T23:00:00Z",
         });
         createdId = (res?.payload as { event?: { id?: number } })?.event?.id;
         return "Listo, quedó agendado.";
      });
      const sent: Sent[] = [];

      await watcher.handleMessage(makeMention(history, sent));

      expect(typeof createdId).toBe("number");
      const row = store.getTicket(CHANNEL);
      expect(row?.status).toBe("created");
      expect(row?.created_event_id).toBe(createdId);
      mem.close();
   });

   test("a ticket with NO form anywhere stays silent and persists nothing", async () => {
      const { watcher, store, mem } = await newWatcher();
      const history = chatter(60, BigInt(FORM_ID));
      const sent: Sent[] = [];

      await watcher.handleMessage(makeMention(history, sent));

      expect(askMock).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      expect(store.getTicket(CHANNEL)).toBeUndefined();
      mem.close();
   });
});
