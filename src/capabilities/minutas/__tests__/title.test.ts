import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Guild, VoiceBasedChannel } from "discord.js";
import { describe, expect, test, vi } from "vitest";
import { NamespacedMemory, SqliteMemoryStore } from "../../../memory/store.js";
import { MinutasSessions } from "../session.js";
import { MINUTAS_MIGRATIONS, MinutasStore } from "../store.js";
import { resolveSessionTitle } from "../title.js";

vi.mock("@discordjs/voice", () => ({
   EndBehaviorType: {},
   VoiceConnectionStatus: { Ready: "ready" },
   entersState: vi.fn(async () => {}),
   joinVoiceChannel: () => ({
      receiver: { speaking: new EventEmitter() },
      destroy: vi.fn(),
   }),
}));

const START = Date.parse("2026-10-20T03:00:00Z"); // 19 October, 21:00 CDMX
const DEFAULT_TITLE = "🎙️ Sala de Eventos 🎙️ — 19 de octubre de 2026";

describe("session titles", () => {
   test("uses the recording date in CDMX, including year rollover", () => {
      expect(
         resolveSessionTitle(null, "Sala", Date.parse("2027-01-01T02:00:00Z")),
      ).toBe("Sala — 31 de diciembre de 2026");
      expect(resolveSessionTitle(null, null, START)).toBe(
         "Sesión de voz — 19 de octubre de 2026",
      );
   });

   test.each([
      [undefined, DEFAULT_TITLE],
      [null, DEFAULT_TITLE],
      [" \n\t ", DEFAULT_TITLE],
      ["  Asamblea   de\noctubre  ", "Asamblea de octubre"],
   ])(
      "persists and announces title %j consistently",
      async (input, expected) => {
         const mem = new SqliteMemoryStore({ path: ":memory:" });
         const dir = mkdtempSync(join(tmpdir(), "minutas-title-"));
         const clock = vi.spyOn(Date, "now").mockReturnValue(START);
         const store = new MinutasStore(mem.db());
         const sessions = new MinutasSessions({
            store,
            sessionsDir: dir,
            onClosed: vi.fn(),
         });
         try {
            await new NamespacedMemory(mem, "minutas").migrate(
               "minutas",
               MINUTAS_MIGRATIONS,
            );
            const send = vi.fn(async () => {});
            const row = await sessions.start({
               guild: { id: "g1", members: { me: null } } as unknown as Guild,
               channel: {
                  id: "vc1",
                  name: "🎙️ Sala de Eventos 🎙️",
                  isSendable: () => true,
                  send,
               } as unknown as VoiceBasedChannel,
               startedBy: { id: "u1", tag: "Moderación" },
               title: input,
            });
            expect(row.title).toBe(expected);
            expect(store.getSession(row.id)?.title).toBe(expected);
            const manifest = JSON.parse(
               readFileSync(join(dir, row.id, "session.json"), "utf8"),
            );
            expect(manifest.title).toBe(expected);
            expect(send.mock.calls[0]?.[0]).toContain(expected);
         } finally {
            sessions.disposeAll();
            clock.mockRestore();
            mem.close();
            rmSync(dir, { recursive: true, force: true });
         }
      },
   );
});
