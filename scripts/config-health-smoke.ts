/**
 * Admin-console smoke against the REAL text model (Kimi).
 *
 * The one behavior worth proving live: when an operator asks a general "¿cómo va
 * el bot?", the model must call **`config_system action:health` once** and answer
 * from it — not chain the four per-capability `status` tools (the pre-2026-08-03
 * behavior), and not dump the raw JSON into Discord.
 *
 * Runs against an in-memory SQLite store with a stubbed Discord client, so it
 * mutates nothing and posts nowhere.
 *
 * Usage:  LOG_LEVEL=warn npx tsx scripts/config-health-smoke.ts
 */
import "dotenv/config";
import type { Client, Guild } from "discord.js";
import { SqliteMemoryStore, NamespacedMemory } from "../src/memory/store.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { buildRouter } from "../src/capabilities/routing.js";
import { ConfigurationCapability } from "../src/capabilities/configuration/capability.js";
import { CalendarCapability } from "../src/capabilities/calendar/capability.js";
import { InstagramMonitorCapability } from "../src/capabilities/instagram_monitor/capability.js";
import {
   FRAMEWORK_CAPABILITY_ID,
   USERS_MIGRATIONS,
   UserDirectory,
} from "../src/users/store.js";
import { InstagramMonitorStore } from "../src/capabilities/instagram_monitor/store.js";
import { ask } from "../src/llm/client.js";
import type { CapabilityInitDeps } from "../src/capabilities/capability.js";
import type { ComposedTools } from "../src/tools/source.js";
import type { Turn } from "../src/discord/history.js";

const NOW = new Date("2026-08-03T18:00:00.000Z");
const OPERATOR = "OPERATOR_1";
const g = "\x1b[32m",
   y = "\x1b[33m",
   r = "\x1b[31m",
   dim = "\x1b[2m",
   rst = "\x1b[0m";
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
   if (ok)
      console.log(
         `  ${g}✓${rst} ${label}${detail ? `  ${dim}${detail}${rst}` : ""}`,
      );
   else {
      failures++;
      console.log(`  ${r}✗ ${label}${rst}${detail ? `  ${detail}` : ""}`);
   }
};
const warn = (label: string, detail = "") =>
   console.log(
      `  ${y}~ ${label}${rst}${detail ? `  ${dim}${detail}${rst}` : ""}`,
   );

const memory = new SqliteMemoryStore({ path: ":memory:" });
await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
const userDirectory = new UserDirectory(memory.db());
userDirectory.upsert(OPERATOR, "op#0001", NOW.getTime());

const registry = new CapabilityRegistry();
const configCap = new ConfigurationCapability();
const calCap = new CalendarCapability();
const igCap = new InstagramMonitorCapability();
let router: ReturnType<typeof buildRouter> | null = null;
const fakeGuild = {
   id: "G1",
   name: "Revolución Z",
   memberCount: 300,
   channels: { cache: new Map() },
} as unknown as Guild;
const client = {
   guilds: { cache: new Map([["G1", fakeGuild]]) },
   channels: { cache: new Map(), fetch: async () => null },
} as unknown as Client;

const initDeps = (id: string): CapabilityInitDeps => ({
   memory: new NamespacedMemory(memory, id),
   projectRoot: ".",
   getDiscordClient: () => client,
   getRegistry: () => registry,
   getRouter: () => {
      if (!router) throw new Error("router not yet built");
      return router;
   },
   getUserDirectory: () => userDirectory,
});

for (const cap of [configCap, calCap, igCap]) {
   await cap.init(initDeps(cap.id));
   registry.register(cap);
}
// Pretend file_scanner failed to boot for the usual reason — health must name it.
configCap.recordSkippedCapabilities([
   { id: "file_scanner", error: "VIRUSTOTAL_API_KEY not set" },
]);
router = buildRouter(
   new Map([
      ["CH_CAL", "calendar"],
      ["CH_IG", "instagram_monitor"],
   ]),
);

async function say(
   user: string,
   history: Turn[] = [],
): Promise<{ reply: string; tools: string[]; inputs: unknown[] }> {
   const bundle = await configCap.buildTurn({
      channelId: "CONFIG_CHAN",
      guildId: "G1",
      userId: OPERATOR,
      userTag: "op",
      now: NOW,
      // The console is mod-gated and fails closed (2026-08-13): an unresolvable
      // author gets the unauthorized prompt and ZERO tools, so without this the
      // smoke asserts the deny path instead of the console. See the fuller note in
      // scripts/text-backend-trial.ts.
      isAdministrator: true,
   });
   const tools: string[] = [];
   const inputs: unknown[] = [];
   const spied: ComposedTools = {
      tools: bundle.tools.tools,
      handle: (n, i) => {
         tools.push(n);
         inputs.push(i);
         return bundle.tools.handle(n, i);
      },
   };
   history.push({ role: "user", content: user });
   let reply: string;
   try {
      reply = await ask({
         system: bundle.system,
         messages: history,
         tools: spied,
      });
   } catch (err) {
      reply = `[ask() threw: ${err instanceof Error ? err.message : String(err)}]`;
   }
   history.push({ role: "assistant", content: reply });
   console.log(`\n${dim}operator:${rst} ${user}`);
   console.log(`${dim}bot:${rst} ${reply.replace(/\n/g, "\n     ")}`);
   if (tools.length) console.log(`${dim}     tools: ${tools.join(", ")}${rst}`);
   return { reply, tools, inputs };
}

const actionsOf = (inputs: unknown[]) =>
   inputs
      .map((i) => (i as { action?: string } | null)?.action)
      .filter(Boolean) as string[];

console.log("=== Admin console health smoke (real text model) ===");

// ── Scene 1: the general question routes to `health` ──────────────────────────
console.log('\n── Scene 1: "¿cómo va el bot?" → una sola llamada a health ──');
{
   const { reply, tools, inputs } = await say(
      "oye, ¿cómo va el bot? dame el estado general",
   );
   check(
      tools.includes("config_system"),
      "llamó a config_system",
      tools.join(", ") || "(ninguna)",
   );
   check(
      actionsOf(inputs).includes("health"),
      "usó action:health",
      actionsOf(inputs).join(", ") || "(sin action)",
   );
   const perCap = tools.filter((t) =>
      ["config_instagram", "config_filescanner", "config_eventintake"].includes(
         t,
      ),
   );
   check(
      perCap.length === 0,
      "no encadenó los status por capability",
      perCap.join(", ") || "ninguno",
   );
   // The whole point is a human summary, not a JSON dump.
   check(
      !reply.includes('"uptime_ms"') && !reply.includes('{"'),
      "resumió en vez de volcar JSON",
   );
   if (/file_scanner/i.test(reply))
      check(true, "reportó el capability que no arrancó");
   else
      warn(
         "no mencionó file_scanner",
         "estaba en skipped — se esperaba que lo reportara",
      );
}

// ── Scene 2: a real problem must be surfaced, with the fix ───────────────────
console.log(
   "\n── Scene 2: kill-switch de IG activo → lo reporta y dice cómo arreglarlo ──",
);
{
   new InstagramMonitorStore(memory.db()).tripGlobalStop(
      "require_login",
      NOW.getTime(),
   );
   const { reply, inputs } = await say(
      "¿todo bien con el monitor de instagram?",
   );
   check(
      /detenid|parad|stop|kill/i.test(reply),
      "dijo que el monitor está detenido",
   );
   check(/require_login|sesi[óo]n|cookies/i.test(reply), "nombró la causa");
   if (/resume_monitor/i.test(reply))
      check(true, "indicó el comando para reanudar");
   else warn("no citó resume_monitor", "aceptable si explicó el procedimiento");
   console.log(
      `${dim}     actions: ${actionsOf(inputs).join(", ") || "(ninguna)"}${rst}`,
   );
}

// ── Scene 3: "which model does it think with" — must not name legacy Sonnet ──
console.log(
   '\n── Scene 3: "¿con qué modelo piensa?" → Kimi (texto) + Nova (imágenes) ──',
);
{
   const { reply } = await say("¿con qué modelo piensa ChopperBot?");
   check(/kimi/i.test(reply), "nombró Kimi para texto");
   check(/nova/i.test(reply), "nombró Nova para imágenes");
   check(
      !/sonnet|claude-3|anthropic\.claude/i.test(reply),
      "NO citó el modelo legacy (Sonnet/Claude)",
   );
}

console.log();
if (failures === 0)
   console.log(`${g}✓ All admin health smoke checks passed.${rst}`);
else console.log(`${r}✗ ${failures} hard check(s) failed${rst}`);
memory.close();
process.exit(failures === 0 ? 0 : 1);
