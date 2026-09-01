/**
 * `config_system action:health` — the cross-capability snapshot.
 *
 * The point of these tests is the *triage* behavior: an operator asking "¿cómo
 * va el bot?" must get one verdict plus actionable problems, and the report must
 * still come back when a subsystem is broken (that's exactly when it's needed).
 */
import { describe, test, expect, beforeEach } from "vitest";
import { SqliteMemoryStore } from "../../../memory/store.js";
import { CapabilityRegistry } from "../../registry.js";
import { buildRouter } from "../../routing.js";
import { collectHealth, humanAge, type HealthDeps } from "../health.js";
import { llmHealth } from "../../../llm/health.js";
import { config, textBackend, textBrainDisplayName } from "../../../config.js";
import { CALENDAR_MIGRATIONS, CalendarStore } from "../../calendar/store.js";
import {
   INSTAGRAM_MONITOR_MIGRATIONS,
   InstagramMonitorStore,
} from "../../instagram_monitor/store.js";
import { FILE_SCANNER_MIGRATIONS } from "../../file_scanner/store.js";
import {
   EVENT_INTAKE_MIGRATIONS,
   EventIntakeStore,
} from "../../event_intake/store.js";
import type { Capability } from "../../capability.js";

const NOW = Date.parse("2026-08-03T18:00:00.000Z");
const UP_2_DAYS = NOW - 2 * 86_400_000;

function stubCapability(id: string): Capability {
   return {
      id,
      description: `${id} (stub)`,
      init: async () => {},
      buildTurn: async () => ({
         system: "",
         tools: {
            tools: [],
            handle: async () => ({ status: "success", payload: {} }),
         },
      }),
   } as unknown as Capability;
}

/** A fully migrated DB + registry with every capability present. */
async function healthyDeps(over: Partial<HealthDeps> = {}) {
   const memory = new SqliteMemoryStore({ path: ":memory:" });
   for (const [id, migrations] of [
      ["calendar", CALENDAR_MIGRATIONS],
      ["instagram_monitor", INSTAGRAM_MONITOR_MIGRATIONS],
      ["file_scanner", FILE_SCANNER_MIGRATIONS],
      ["event_intake", EVENT_INTAKE_MIGRATIONS],
   ] as const) {
      await memory.migrate(id, migrations);
   }
   const registry = new CapabilityRegistry();
   for (const id of [
      "configuration",
      "calendar",
      "instagram_monitor",
      "file_scanner",
      "event_intake",
      "general_chat",
   ]) {
      registry.register(stubCapability(id));
   }
   const router = buildRouter(
      new Map([
         ["CH_CAL", "calendar"],
         ["CH_IG", "instagram_monitor"],
      ]),
   );
   const client = {
      guilds: { cache: new Map([["G1", { id: "G1", name: "Revolución Z" }]]) },
   };

   // Make the two things that would otherwise legitimately be "problems" healthy:
   // the calendar needs an output channel + a published current month.
   const cal = new CalendarStore(memory.db());
   cal.setOutputChannelId("CH_OUT");
   cal.setAnnounceChannelId("CH_ANNOUNCE");
   cal.setPublished("pdf:2026-08", "CH_OUT", "MSG_1");
   const ei = new EventIntakeStore(memory.db());
   ei.setWatchedCategories(["CAT_1"]);

   const deps: HealthDeps = {
      db: memory.db(),
      registry,
      router,
      client: client as never,
      startedAtMs: UP_2_DAYS,
      dbPath: "/nonexistent/chopperbot.db", // statSync fails → db_size_bytes null, not a throw
      skipped: [],
      nowMs: NOW,
      ...over,
   };
   return { memory, deps, registry, router };
}

describe("humanAge", () => {
   test("scales the unit to the magnitude", () => {
      expect(humanAge(45_000)).toBe("45 s");
      expect(humanAge(90_000)).toBe("1 m");
      expect(humanAge(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 m");
      expect(humanAge(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 d 3 h");
   });
});

describe("collectHealth", () => {
   beforeEach(() => {
      llmHealth.reportSuccess(NOW); // clear any degraded state leaked between tests
   });

   test("a healthy bot reports ok with no problems", async () => {
      const { memory, deps } = await healthyDeps();
      const r = collectHealth(deps);
      expect(r.problems).toEqual([]);
      expect(r.status).toBe("ok");
      memory.close();
   });

   test("reports the ACTUAL two backends, not the legacy Bedrock model", async () => {
      const { memory, deps } = await healthyDeps();
      const llm = collectHealth(deps).llm as {
         text: { backend: string; model: string; display_name: string };
         vision: { backend: string; model: string };
      };
      expect(llm.text.backend).toBe(textBackend.provider);
      expect(llm.text.model).toBe(textBackend.modelId);
      expect(llm.text.display_name).toBe(textBrainDisplayName());
      expect(llm.vision.backend).toBe("bedrock");
      // The legacy Sonnet id must not be presented as the model in use anywhere.
      expect(JSON.stringify(llm)).not.toContain("anthropic.claude");
      memory.close();
   });

   test('a failing LLM is "down" — the bot cannot answer at all', async () => {
      const { memory, deps } = await healthyDeps();
      const err = Object.assign(new Error("invalid api key"), { status: 401 }); // deterministic → alerts at once
      llmHealth.reportFailure(err, NOW);
      const r = collectHealth(deps);
      expect(r.status).toBe("down");
      expect(r.problems.join(" ")).toMatch(/LLM degradado/);
      expect(
         (r.llm as { health: { last_error: string } }).health.last_error,
      ).toContain("invalid api key");
      memory.close();
   });

   test("a capability that failed init is named WITH its reason", async () => {
      const { memory, deps } = await healthyDeps({
         skipped: [{ id: "file_scanner", error: "VIRUSTOTAL_API_KEY not set" }],
      });
      const r = collectHealth(deps);
      expect(r.status).toBe("degraded");
      expect(r.problems.join(" ")).toContain("file_scanner");
      expect(r.problems.join(" ")).toContain("VIRUSTOTAL_API_KEY not set");
      expect((r.capabilities as { skipped: unknown[] }).skipped).toHaveLength(
         1,
      );
      memory.close();
   });

   test("the IG kill-switch surfaces as a problem with the fix command", async () => {
      const { memory, deps } = await healthyDeps();
      new InstagramMonitorStore(deps.db).tripGlobalStop("require_login", NOW);
      const r = collectHealth(deps);
      expect(r.status).toBe("degraded");
      const problem = r.problems.find((p) => /Instagram DETENIDO/.test(p));
      expect(problem).toBeTruthy();
      expect(problem).toContain("require_login");
      expect(problem).toContain("resume_monitor"); // tells the operator how to fix it
      expect(
         (r.instagram_monitor as { polling_stopped: boolean }).polling_stopped,
      ).toBe(true);
      memory.close();
   });

   test("an unpublished current month is flagged — the Aug 1 miss", async () => {
      const { memory, deps } = await healthyDeps();
      new CalendarStore(deps.db).clearPublished("pdf:2026-08");
      const r = collectHealth(deps);
      expect(r.problems.join(" ")).toMatch(/falta publicar 2026-08/);
      expect(
         (r.calendar as { months_missing: string[] }).months_missing,
      ).toEqual(["2026-08"]);
      memory.close();
   });

   test("a calendar with no output channel is flagged (DB null AND no env fallback)", async () => {
      const { memory, deps } = await healthyDeps();
      new CalendarStore(deps.db).setOutputChannelId(null);
      // Resolution is DB → env → none, and dotenv loads the real .env into the
      // test process, so the env fallback has to be cleared for this to be the
      // "nothing configured" case rather than an env-dependent assertion.
      const envHolder = config as { CALENDAR_OUTPUT_CHANNEL_ID?: string };
      const saved = envHolder.CALENDAR_OUTPUT_CHANNEL_ID;
      envHolder.CALENDAR_OUTPUT_CHANNEL_ID = undefined;
      try {
         const r = collectHealth(deps);
         expect(r.problems.join(" ")).toMatch(/canal de salida/);
         expect(
            (r.calendar as { output_channel_id: string | null })
               .output_channel_id,
         ).toBeNull();
      } finally {
         envHolder.CALENDAR_OUTPUT_CHANNEL_ID = saved;
      }
      memory.close();
   });

   test("the env output channel is used when the DB setting is empty", async () => {
      const { memory, deps } = await healthyDeps();
      new CalendarStore(deps.db).setOutputChannelId(null);
      const envHolder = config as { CALENDAR_OUTPUT_CHANNEL_ID?: string };
      const saved = envHolder.CALENDAR_OUTPUT_CHANNEL_ID;
      envHolder.CALENDAR_OUTPUT_CHANNEL_ID = "12345678901234567890";
      try {
         const r = collectHealth(deps);
         expect(
            (r.calendar as { output_channel_id: string | null })
               .output_channel_id,
         ).toBe("12345678901234567890");
         expect(r.problems.join(" ")).not.toMatch(/canal de salida/);
      } finally {
         envHolder.CALENDAR_OUTPUT_CHANNEL_ID = saved;
      }
      memory.close();
   });

   test("a channel bound to an unregistered capability is caught", async () => {
      const { memory, deps } = await healthyDeps({
         router: buildRouter(new Map([["CH_GONE", "retired_capability"]])),
      });
      const r = collectHealth(deps);
      expect(r.status).toBe("degraded");
      expect(
         (r.capabilities as { orphan_bindings: unknown[] }).orphan_bindings,
      ).toEqual([{ channel_id: "CH_GONE", capability: "retired_capability" }]);
      memory.close();
   });

   test("a disabled capability reads as disabled, not as an error", async () => {
      const registry = new CapabilityRegistry();
      registry.register(stubCapability("configuration"));
      const { memory, deps } = await healthyDeps({ registry });
      const r = collectHealth(deps);
      expect((r.file_scanner as { enabled: boolean }).enabled).toBe(false);
      expect((r.event_intake as { enabled: boolean }).enabled).toBe(false);
      memory.close();
   });

   test("a recent boot is flagged, since it explains empty in-memory counters", async () => {
      const { memory, deps } = await healthyDeps({ startedAtMs: NOW - 60_000 });
      const r = collectHealth(deps);
      expect(r.problems.join(" ")).toMatch(/Reinicio reciente/);
      memory.close();
   });

   test("an un-migrated subsystem degrades ITS block only — the report still returns", async () => {
      // No migrations at all: every capability store hits missing tables.
      const memory = new SqliteMemoryStore({ path: ":memory:" });
      const registry = new CapabilityRegistry();
      for (const id of [
         "configuration",
         "instagram_monitor",
         "file_scanner",
         "event_intake",
      ]) {
         registry.register(stubCapability(id));
      }
      const r = collectHealth({
         db: memory.db(),
         registry,
         router: buildRouter(new Map()),
         client: { guilds: { cache: new Map() } } as never,
         startedAtMs: UP_2_DAYS,
         dbPath: "/nonexistent/db",
         skipped: [],
         nowMs: NOW,
      });
      // The blocks report their own failure...
      expect(r.instagram_monitor).toHaveProperty("error");
      expect(r.calendar).toHaveProperty("error");
      // ...while the report as a whole still answers, including the LLM block.
      expect(r.status).toBeDefined();
      expect(r.llm).toHaveProperty("text");
      expect(r.runtime).toHaveProperty("uptime_human");
      memory.close();
   });
});
