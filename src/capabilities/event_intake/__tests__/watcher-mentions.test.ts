/**
 * Watcher-level proof of the mod ping: what actually lands in Discord (message
 * content + `allowedMentions`), not just the pure helpers. `ask` is mocked, so
 * no model is called; the store/calendar run on a real in-memory SQLite.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, type Message } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../../memory/store.js";
import { EventIntakeStore, EVENT_INTAKE_MIGRATIONS } from "../store.js";
import { CalendarStore, CALENDAR_MIGRATIONS } from "../../calendar/store.js";
import { EventIntakeWatcher } from "../watcher.js";
import { MOD_PING_COOLDOWN_MS } from "../../../discord/mod-roles.js";

// The watcher swallows its own errors into the log (it must never throw into
// the gateway), so silence the logger — a swallowed failure surfaces as an
// assertion miss below, not as noise.
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
const MOD_ROLE = "1436055845392879778"; // 🚓Moderación🚓 (mentionable)
const ADMIN_ROLE = "1436259908222713917"; // ⭐Administrador⭐ (mentionable)
const TECH_ROLE = "1517610228969902130"; // Técnico (NOT mentionable)
const REQUESTER = "187289179871248384";

const FORM_EMBED = {
   description: [
      "**¿Cuál es el título o tema del evento?**\n```Conversatorio: DataCenters```",
      "**¿Qué día?**\n```martes 11 de agosto```",
      "**¿A qué hora?**\n```8pm```",
      "**¿Quién es el/la ponente?**\n```Burbuja```",
      "**¿Harás tú el flyer?**\n```no```",
   ].join("\n"),
   fields: [],
};

const GUILD_ROLES = [
   { id: "111111111111111111", name: "Miembro", mentionable: true },
   { id: ADMIN_ROLE, name: "⭐Administrador⭐", mentionable: true },
   { id: MOD_ROLE, name: "🚓Moderación🚓", mentionable: true },
   { id: TECH_ROLE, name: "Técnico", mentionable: false },
];

interface Sent {
   content: string;
   allowedMentions?: {
      roles?: string[];
      parse?: string[];
      repliedUser?: boolean;
   };
}

function makeMessage(opts: {
   authorId: string;
   bot: boolean;
   content?: string;
   embeds?: unknown[];
   canMentionAny?: boolean;
   sent: Sent[];
   memberRoles?: string[];
}): Message {
   const reply = vi.fn(async (payload: string | Sent) => {
      const norm = typeof payload === "string" ? { content: payload } : payload;
      opts.sent.push(norm);
      return { id: "posted-1", reply: vi.fn() } as unknown as Message;
   });
   const roles = GUILD_ROLES;
   return {
      id: "msg-1",
      channelId: CHANNEL,
      guildId: GUILD,
      author: { id: opts.authorId, bot: opts.bot, tag: "tester" },
      content: opts.content ?? "",
      embeds: opts.embeds ?? [],
      member: {
         roles: {
            cache: {
               map: <T>(fn: (r: { id: string; name: string }) => T) =>
                  (opts.memberRoles ?? []).map((id) => fn({ id, name: id })),
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
               size: roles.length,
               map: <T>(fn: (r: (typeof roles)[number]) => T) => roles.map(fn),
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
         // The bot may always post here; MentionEveryone is the flag under test.
         permissionsFor: () => ({
            has: (flag: bigint) =>
               flag === PermissionFlagsBits.MentionEveryone
                  ? (opts.canMentionAny ?? false)
                  : true,
         }),
      },
      reply,
   } as unknown as Message;
}

async function newWatcher(overrides: { now?: () => number } = {}) {
   const mem = new SqliteMemoryStore({ path: ":memory:" });
   const ns = new NamespacedMemory(mem, "event_intake");
   await ns.migrate("event_intake", EVENT_INTAKE_MIGRATIONS);
   await new NamespacedMemory(mem, "calendar").migrate(
      "calendar",
      CALENDAR_MIGRATIONS,
   );
   const store = new EventIntakeStore(mem.db());
   const watcher = new EventIntakeWatcher({
      store,
      calendarStore: new CalendarStore(mem.db()),
      client: { user: { id: BOT } } as never,
      botUserId: BOT,
      ticketBotId: TICKET_BOT,
      getModRoles: () => store.getModRoles(),
      getAgitpropChannelId: () => null,
      getAgitpropRoles: () => [],
      now: overrides.now ?? (() => Date.parse("2026-08-04T18:00:00Z")),
   });
   return { watcher, store, mem };
}

beforeEach(() => askMock.mockReset());

describe("proposal ping", () => {
   test("pings the mentionable approver roles and allows exactly those mentions", async () => {
      askMock.mockResolvedValue(
         "Hola, tu solicitud llegó. Resumen para lxs mods: …",
      );
      const { watcher, mem } = await newWatcher();
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            authorId: TICKET_BOT,
            bot: true,
            content: `Bienvenidx <@${REQUESTER}>`,
            embeds: [FORM_EMBED],
            sent,
         }),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toContain(`<@&${ADMIN_ROLE}>`);
      expect(sent[0].content).toContain(`<@&${MOD_ROLE}>`);
      // an approver role Discord won't notify is never rendered as a silent chip
      expect(sent[0].content).not.toContain(TECH_ROLE);
      expect(sent[0].allowedMentions?.roles).toEqual([ADMIN_ROLE, MOD_ROLE]);
      // user mentions still work; @everyone/@here never do (absent from `parse`)
      expect(sent[0].allowedMentions?.parse).toEqual(["users"]);
      mem.close();
   });

   test("MentionEveryone lets it reach the unmentionable approver role too", async () => {
      askMock.mockResolvedValue("Propuesta.");
      const { watcher, mem } = await newWatcher();
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            authorId: TICKET_BOT,
            bot: true,
            embeds: [FORM_EMBED],
            canMentionAny: true,
            sent,
         }),
      );
      expect(sent[0].allowedMentions?.roles).toEqual([
         ADMIN_ROLE,
         MOD_ROLE,
         TECH_ROLE,
      ]);
      mem.close();
   });

   test("a role mention the model invented is stripped before posting", async () => {
      askMock.mockResolvedValue("Propuesta <@&123456789012345678> lista.");
      const { watcher, mem } = await newWatcher();
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            authorId: TICKET_BOT,
            bot: true,
            embeds: [FORM_EMBED],
            sent,
         }),
      );
      expect(sent[0].content).not.toContain("123456789012345678");
      expect(sent[0].content).toContain(`<@&${MOD_ROLE}>`);
      mem.close();
   });
});

describe("conversation ping", () => {
   const humanMsg = (sent: Sent[]) =>
      makeMessage({
         authorId: REQUESTER,
         bot: false,
         content: `<@${BOT}> no le sé al flyer, ¿me ayudan?`,
         sent,
         memberRoles: [],
      });

   async function seedTicket(store: EventIntakeStore) {
      store.recordProposal({
         channelId: CHANNEL,
         guildId: GUILD,
         requesterId: REQUESTER,
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
   }

   test("a non-mod asking for help reaches the mods (the flyer case)", async () => {
      askMock.mockResolvedValue(
         `Claro, les pedimos apoyo. <@&${ADMIN_ROLE}> <@&${MOD_ROLE}> ¿alguien puede con el flyer?`,
      );
      const { watcher, store, mem } = await newWatcher();
      await seedTicket(store);
      const sent: Sent[] = [];
      await watcher.handleMessage(humanMsg(sent));
      expect(sent[0].allowedMentions?.roles).toEqual([ADMIN_ROLE, MOD_ROLE]);
      mem.close();
   });

   test("a repeat mention inside the cooldown renders but does NOT ping again", async () => {
      askMock.mockResolvedValue(`ping <@&${MOD_ROLE}>`);
      let now = Date.parse("2026-08-04T18:00:00Z");
      const { watcher, store, mem } = await newWatcher({ now: () => now });
      await seedTicket(store);

      const first: Sent[] = [];
      await watcher.handleMessage(humanMsg(first));
      expect(first[0].allowedMentions?.roles).toEqual([MOD_ROLE]);

      now += 60_000; // one minute later, model echoes the mention from history
      const second: Sent[] = [];
      await watcher.handleMessage(humanMsg(second));
      expect(second[0].content).toContain(`<@&${MOD_ROLE}>`); // still readable
      expect(second[0].allowedMentions?.roles).toEqual([]); // but silent

      now += MOD_PING_COOLDOWN_MS; // cooldown elapsed → mods can be paged again
      const third: Sent[] = [];
      await watcher.handleMessage(humanMsg(third));
      expect(third[0].allowedMentions?.roles).toEqual([MOD_ROLE]);
      mem.close();
   });

   test("approving the event tags the team, even inside the cooldown", async () => {
      let now = Date.parse("2026-08-04T18:00:00Z");
      const { watcher, store, mem } = await newWatcher({ now: () => now });
      await seedTicket(store);

      // First, a normal ping so the cooldown is armed…
      askMock.mockResolvedValue(`ping <@&${MOD_ROLE}>`);
      const first: Sent[] = [];
      await watcher.handleMessage(humanMsg(first));
      expect(first[0].allowedMentions?.roles).toEqual([MOD_ROLE]);

      // …then a MOD approves a minute later: the model calls the real create tool
      // and writes a plain confirmation with no mention of its own.
      now += 60_000;
      askMock.mockImplementation(async (input) => {
         await input?.tools?.handle("calendar_create_event", {
            title: "Conversatorio: DataCenters",
            start_at_iso: "2026-08-12T02:00:00Z",
         });
         return "Listo, quedó el martes 11 de agosto a las 8:00 PM.";
      });
      const sent: Sent[] = [];
      await watcher.handleMessage(
         makeMessage({
            authorId: "mod-1",
            bot: false,
            content: `<@${BOT}> créalo`,
            sent,
            memberRoles: [MOD_ROLE],
         }),
      );

      expect(sent[0].content).toContain("agendado");
      expect(sent[0].allowedMentions?.roles).toEqual([ADMIN_ROLE, MOD_ROLE]); // cooldown does not apply
      expect(store.getTicket(CHANNEL)?.status).toBe("created");
      mem.close();
   });

   test("an ordinary reply pings nobody", async () => {
      askMock.mockResolvedValue("Listo, queda anotado el martes 11 a las 8pm.");
      const { watcher, store, mem } = await newWatcher();
      await seedTicket(store);
      const sent: Sent[] = [];
      await watcher.handleMessage(humanMsg(sent));
      expect(sent[0].allowedMentions?.roles).toEqual([]);
      mem.close();
   });
});
