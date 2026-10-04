import { test, expect } from "vitest";
import { CalendarCapability } from "../capability.js";
import { SqliteMemoryStore } from "../../../memory/store.js";
import { CapabilityRegistry } from "../../registry.js";
import { buildRouter } from "../../routing.js";

const GESTION = "1483694810253492235";

test("calendar opts into context; write tools follow the caller's live events authority, not phrasing", async () => {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   const cap = new CalendarCapability();
   await cap.init({ memory, projectRoot: process.cwd(), getRegistry: () => new CapabilityRegistry(), getRouter: () => buildRouter(new Map()) });
   const base = { guildId: null, channelId: "channel", userId: "caller", userTag: "fixture", now: new Date() };
   expect(cap.channelContext).toBe(true);
   const names = async (ctx: Record<string, unknown>) =>
      (await cap.buildTurn({ ...base, ...ctx } as never)).tools.tools.map((t) => t.name);
   // Real mod phrasings the old phrase gate refused (review 2026-10-04).
   for (const requestText of ["créalo", "agrégalo al calendario", "cámbialo a las 8", "oye, crea el evento", "a las 7"])
      expect(await names({ requestText, memberRoles: [{ id: GESTION, name: "Rol ficticio" }] })).toContain("calendar_create_event");
   // No events authority → read-only, whatever the text says.
   expect(await names({ requestText: "crea el evento", memberRoles: [] })).not.toContain("calendar_create_event");
   expect(await names({ requestText: "crea el evento" })).not.toContain("calendar_create_event");
   memory.close();
});
