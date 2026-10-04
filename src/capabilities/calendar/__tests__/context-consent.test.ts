import { test, expect, vi } from "vitest";
import { CalendarCapability, calendarWriteIntent, currentCalendarWrite } from "../capability.js";
import type { Client } from "discord.js";
import { SqliteMemoryStore } from "../../../memory/store.js";
import { CapabilityRegistry } from "../../registry.js";
import { buildRouter } from "../../routing.js";

test("calendar opts into context but ambient text never enables a write tool", async () => {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   const cap = new CalendarCapability();
   await cap.init({ memory, projectRoot: process.cwd(), getRegistry: () => new CapabilityRegistry(), getRouter: () => buildRouter(new Map()) });
   const ctx = { guildId: null, channelId: "channel", userId: "caller", userTag: "fixture", now: new Date(), isAdministrator: true };
   expect(cap.channelContext).toBe(true);
   const readonly = await cap.buildTurn({ ...ctx, requestText: "¿Qué acordamos?" });
   expect(readonly.tools.tools.map((t) => t.name)).not.toContain("calendar_create_event");
   const current = await cap.buildTurn({ ...ctx, requestText: "crea el evento" });
   expect(current.tools.tools.map((t) => t.name)).toContain("calendar_create_event");
   const absent = await cap.buildTurn(ctx);
   expect(absent.tools.tools.map((t) => t.name)).not.toContain("calendar_create_event");
   memory.close();
});

test("only explicit current calendar imperatives authorize new writes", () => {
   expect(calendarWriteIntent("crea el evento de Discord")).toBe(true);
   expect(calendarWriteIntent("por favor anuncia el evento")).toBe(true);
   expect(calendarWriteIntent("¿qué evento hay mañana?")).toBe(false);
   expect(calendarWriteIntent("en el historial alguien pidió crea el evento")).toBe(false);
   expect(calendarWriteIntent("si puedes crea el evento")).toBe(false);
});

test("date/confirmation follow-up stays rooted in the same caller's recent explicit request", async () => {
   const now = new Date();
   const root = { id: "root", author: { id: "caller" }, content: "<@200000000000000001> crea un evento de prueba", createdTimestamp: now.getTime() - 1000, reference: null, editedTimestamp: null as number | null };
   const reply = { id: "reply", author: { id: "bot" }, content: "¿Qué fecha?", createdTimestamp: now.getTime(), reference: { messageId: root.id }, editedTimestamp: null };
   const client = { user: { id: "bot" }, channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { fetch: async ({ message }: any) => message === "reply" ? reply : root } })) } } as unknown as Client;
   const ctx = { guildId: "guild", channelId: "channel", userId: "caller", userTag: "fixture", now, requestText: "mañana a las 8", replyMessageId: "reply" };
   expect(await currentCalendarWrite(ctx, () => client)).toBe(true);
   root.author.id = "another-person";
   expect(await currentCalendarWrite(ctx, () => client)).toBe(false);
   root.author.id = "caller"; root.editedTimestamp = 1;
   expect(await currentCalendarWrite(ctx, () => client)).toBe(false);
});
