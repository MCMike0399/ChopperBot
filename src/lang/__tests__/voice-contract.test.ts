/**
 * The voice contract: every prompt whose output a community member can read
 * carries `SPANISH_VOICE_RULES`, verbatim.
 *
 * This is the test that would have made the 2026-08-13 regression a build
 * failure instead of a channel incident. Before the shared block, each
 * capability restated "responde en español" in its own words and none of them
 * said *which* Spanish — so a new text brain was free to answer in polite
 * usted, invent "elx", and quote its own rules back at the channel.
 *
 * Deliberately NOT covered: `configuration` (the admin console talks to
 * operators and is told to name tools and fields).
 */
import { describe, test, expect } from "vitest";

import { SPANISH_VOICE_RULES } from "../voice.js";
import { lintSpanish } from "../spanish-style.js";
import {
   renderGeneralChatPrompt,
   renderAssistantPrompt,
} from "../../capabilities/general_chat/preamble.js";
import {
   guildProfileFor,
   REVZ_GUILD_ID,
} from "../../capabilities/general_chat/profile.js";
import { renderWorkshopPrompt } from "../../capabilities/workshop/preamble.js";
import {
   renderProposalPrompt,
   renderTicketConversationPrompt,
} from "../../capabilities/event_intake/preamble.js";
import { renderInstagramMonitorPrompt } from "../../capabilities/instagram_monitor/preamble.js";
import { renderAnnouncementPrompt } from "../../capabilities/calendar/announce.js";
import { buildMinutesSystemPrompt } from "../../capabilities/minutas/minutes.js";
import { SqliteMemoryStore, NamespacedMemory } from "../../memory/store.js";
import { CalendarCapability } from "../../capabilities/calendar/capability.js";

const NOW = new Date("2026-08-14T02:00:00.000Z");

const EMPTY_FORM = {
   title: "Taller de zine",
   dayRaw: "sábado",
   timeRaw: "5pm",
   speaker: null,
   flyerSelf: null,
   pairs: [],
};

async function calendarPrompts(): Promise<{ mod: string; readOnly: string }> {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   const cap = new CalendarCapability();
   await cap.init({
      memory: new NamespacedMemory(memory, cap.id),
      projectRoot: ".",
   });
   const base = {
      channelId: "C1",
      guildId: null,
      userId: "U1",
      userTag: "mod",
      now: NOW,
   };
   const mod = await cap.buildTurn({ ...base, isAdministrator: true });
   const readOnly = await cap.buildTurn({ ...base, isAdministrator: false });
   memory.close?.();
   return { mod: mod.system, readOnly: readOnly.system };
}

describe("every community-facing prompt carries the voice contract", () => {
   test("calendar — moderator and read-only bundles", async () => {
      const { mod, readOnly } = await calendarPrompts();
      expect(mod).toContain(SPANISH_VOICE_RULES);
      expect(readOnly).toContain(SPANISH_VOICE_RULES);
   });

   test("general_chat — generic and community-assistant prompts", () => {
      expect(renderGeneralChatPrompt(NOW, [])).toContain(SPANISH_VOICE_RULES);
      const profile = guildProfileFor(REVZ_GUILD_ID);
      expect(profile).not.toBeNull();
      expect(renderAssistantPrompt(profile!, NOW, [], "general")).toContain(
         SPANISH_VOICE_RULES,
      );
   });

   test("workshop session", () => {
      const prompt = renderWorkshopPrompt({
         now: NOW,
         userTag: "alguien",
         userId: "U1",
         channelName: "taller-de-alguien",
         files: [],
         sandboxAvailable: true,
         venvAvailable: true,
         savedUploads: [],
      });
      expect(prompt).toContain(SPANISH_VOICE_RULES);
   });

   test("event_intake — proposal and ticket conversation", () => {
      expect(renderProposalPrompt(NOW, EMPTY_FORM, "U1")).toContain(
         SPANISH_VOICE_RULES,
      );
      for (const isMod of [true, false]) {
         const prompt = renderTicketConversationPrompt({
            now: NOW,
            parsed: EMPTY_FORM,
            requesterId: "U1",
            isMod,
         });
         expect(prompt, `isMod=${isMod}`).toContain(SPANISH_VOICE_RULES);
      }
   });

   test("instagram_monitor — moderator and read-only bundles", () => {
      expect(renderInstagramMonitorPrompt(NOW, true)).toContain(
         SPANISH_VOICE_RULES,
      );
      expect(renderInstagramMonitorPrompt(NOW, false)).toContain(
         SPANISH_VOICE_RULES,
      );
   });

   test("the daily calendar announcement", () => {
      const target = {
         occurrence: {
            id: 21,
            title: "Club de poesía",
            description: null,
            location: null,
            startAtMs: Date.parse("2026-08-14T02:00:00.000Z"),
         },
         discordEvent: null,
         discordEventUrl: null,
      };
      expect(renderAnnouncementPrompt(target, NOW.getTime())).toContain(
         SPANISH_VOICE_RULES,
      );
      expect(
         renderAnnouncementPrompt(target, NOW.getTime(), "advance"),
      ).toContain(SPANISH_VOICE_RULES);
   });

   test("minutas — the meeting-minutes writer (posted verbatim to #minutas)", () => {
      expect(buildMinutesSystemPrompt()).toContain(SPANISH_VOICE_RULES);
   });
});

describe("the contract and the linter say the same thing", () => {
   test("the block names each defect the linter catches", () => {
      // If a rule is dropped from the prompt, the linter would start failing
      // replies for something the model was never told.
      expect(SPANISH_VOICE_RULES).toContain("usted");
      expect(SPANISH_VOICE_RULES).toContain("elx");
      expect(SPANISH_VOICE_RULES).toContain("calendar_create_event");
      expect(SPANISH_VOICE_RULES).toContain("¿algo más?");
      expect(SPANISH_VOICE_RULES).toContain("proponlo");
   });

   test("the examples the block gives as CORRECT are lint-clean", () => {
      for (const good of [
         "lxs",
         "todxs",
         "compañerxs",
         "proponlo",
         "ponlo",
         "hazlo",
         "dilo",
      ]) {
         expect(lintSpanish(`Ya quedó, ${good}.`), good).toEqual([]);
      }
   });

   test("the examples it gives as WRONG are all caught", () => {
      for (const bad of [
         "se le habla",
         "elx",
         "unx",
         "estx",
         "propónlo",
         "¿algo más?",
         "quedo atento",
      ]) {
         expect(lintSpanish(`Listo. ${bad}`).length, bad).toBeGreaterThan(0);
      }
   });
});
