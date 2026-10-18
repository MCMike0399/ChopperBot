import { parseFetchHealth } from "../src/capabilities/instagram_monitor/fetch-health.js";
// One-command triage for "the monitor looks dead" — checks the silent
// states that all present as an empty channel (see the 2026-09-10 note in
// docs/capabilities/instagram-monitor.md):
//
//   1. kill-switch engaged      → nothing is ever polled
//   2. forward-only seeding     → polls succeed, push NOTHING, forever
//   3. fetch failures           → scheduler alive, no posts reach classification
//   4. cadence / empty feed     → successful polls with no new relevant posts
//
// These look identical from Discord. This prints which one you are in, and
// the query to act on it. Read-only: it never writes to the DB or to Instagram.
//
// Run: npx tsx scripts/ig-monitor-status.ts
import "dotenv/config";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
   AUTH_PAUSE_THRESHOLD,
   CADENCE_COLD_START_INTERVAL_MS,
   HARD_PAUSE_THRESHOLD,
   effectiveBaseIntervalMs,
   nextDueAtMs,
   type MonitoredAccount,
} from "../src/capabilities/instagram_monitor/store.js";

const db = new Database("data/chopperbot.db", { readonly: true });
const fmt = (ms: number | null | undefined): string =>
   ms ? new Date(ms).toLocaleString("es-MX", { hour12: false }) : "—";
const ago = (ms: number | null | undefined): string =>
   ms ? `${Math.round((Date.now() - ms) / 1000)}s ago` : "never";

interface RuntimeRow {
   fetch_health_json?: string | null;
   global_stop: number;
   stop_reason: string | null;
   requests_24h: number | null;
   heartbeat_at: number | null;
   poll_stretch: number | null;
   poll_alloc_scale: number | null;
}
const rt = db
   .prepare(`SELECT * FROM instagram_monitor_runtime WHERE id = 1`)
   .get() as RuntimeRow | undefined;

const acct = db
   .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN last_post_id IS NULL THEN 1 ELSE 0 END) unseeded,
              SUM(CASE WHEN last_polled_at IS NULL THEN 1 ELSE 0 END) due_now,
              SUM(paused) paused
         FROM instagram_monitor_accounts`,
   )
   .get() as {
   total: number;
   unseeded: number | null;
   due_now: number | null;
   paused: number | null;
};

const scale = rt?.poll_alloc_scale ?? null;
const pollable = (
   db
      .prepare("SELECT * FROM instagram_monitor_accounts")
      .all() as MonitoredAccount[]
).filter(
   (a) =>
      !a.paused &&
      a.consecutive_auth_failures < AUTH_PAUSE_THRESHOLD &&
      a.consecutive_hard_failures < HARD_PAUSE_THRESHOLD,
);
const soonest = pollable
   .map((account) => ({
      account,
      due:
         nextDueAtMs(account, CADENCE_COLD_START_INTERVAL_MS, scale) ??
         Date.now(),
   }))
   .sort((a, b) => a.due - b.due)[0];

// Best effort: the journal is the only place pushes are visible.
let pushCounts = "unavailable (journalctl not readable here)";
let recentEvents = "";
let lastFetchSuccess: number | null = null;
let consecutiveFetchFailures = 0;
let journalAvailable = false;
const thirtyMinutesAgo = Date.now() - 30 * 60_000;
try {
   const j = execFileSync(
      "journalctl",
      [
         "--user",
         "-u",
         "chopperbot",
         "-o",
         "cat",
         "--since",
         "-48 hours",
         "--no-pager",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
   );
   journalAvailable = true;
   const counts = new Map<string, number>();
   for (const line of j.split("\n")) {
      let event: { msg?: string; time?: number; channelId?: string };
      try {
         event = JSON.parse(line);
      } catch {
         continue;
      }
      if (event.msg === "instagram_monitor.fetch.ok") {
         lastFetchSuccess = event.time ?? null;
         consecutiveFetchFailures = 0;
      } else if (event.msg === "instagram_monitor.fetch.failed") {
         consecutiveFetchFailures++;
      }
      if ((event.time ?? 0) < thirtyMinutesAgo) continue;
      if (event.msg === "instagram_monitor.push" && event.channelId) {
         counts.set(event.channelId, (counts.get(event.channelId) ?? 0) + 1);
      }
      if (event.msg?.startsWith("instagram_monitor.")) recentEvents = event.msg;
   }
   pushCounts =
      counts.size === 0
         ? "0 in the last 30 min"
         : [...counts].map(([c, n]) => `${c}: ${n}`).join(", ");
} catch {
   /* journal unavailable — not fatal */
}

const persistentFetchHealth = rt?.fetch_health_json != null;
if (persistentFetchHealth) {
   const state = parseFetchHealth(rt.fetch_health_json);
   consecutiveFetchFailures = state.failures;
   lastFetchSuccess = state.lastSuccessAt;
}
const fetchHealthSource = persistentFetchHealth
   ? "persistent poll outcomes"
   : "48h journal window";

console.log("Instagram monitor — triage\n");
console.log(
   `  kill-switch     : ${rt?.global_stop === 1 ? `ENGAGED — ${rt.stop_reason}` : "off"}`,
);
console.log(
   `  requests_24h    : ${rt?.requests_24h ?? "—"}   (rolling 24h, restored across restarts since v10)`,
);
console.log(
   `  heartbeat       : ${fmt(rt?.heartbeat_at)}  (${ago(rt?.heartbeat_at)}) ← scheduler liveness`,
);
console.log(
   `  poll_stretch    : ${rt?.poll_stretch?.toFixed(2) ?? "—"}  (aggregate budget pressure; 1 = not binding)`,
);
console.log(
   `  poll_alloc_scale: ${rt?.poll_alloc_scale?.toFixed(4) ?? "— (unconstrained)"}`,
);
console.log(
   `  accounts        : ${acct.total} total | ${acct.unseeded ?? 0} unseeded | ${acct.due_now ?? 0} due now | ${acct.paused ?? 0} paused`,
);
if (soonest) {
   const interval = effectiveBaseIntervalMs(
      soonest.account,
      CADENCE_COLD_START_INTERVAL_MS,
      scale,
   );
   console.log(
      `  next poll after : ${fmt(soonest.due)} (${soonest.account.username}, base ${(interval / 3_600_000).toFixed(1)}h; jitter/quiet hours may delay it)`,
   );
}
console.log(
   `  fetch health    : ${persistentFetchHealth || journalAvailable ? `${consecutiveFetchFailures} consecutive failures; last success ${fmt(lastFetchSuccess)} (${fetchHealthSource})` : "unknown (journal unavailable)"}`,
);
console.log(`  pushes (30 min) : ${pushCounts}`);
if (recentEvents) console.log(`  last journal ev : ${recentEvents}`);

const unseeded = acct.unseeded ?? 0;
let verdict: string;
if (rt?.global_stop === 1) {
   verdict =
      "STOPPED — kill-switch. Nothing is polled. Resume: config_instagram action:resume_monitor confirm:true";
} else if (!rt?.heartbeat_at || Date.now() - rt.heartbeat_at > 10 * 60_000) {
   verdict =
      "SCHEDULER STALE — no heartbeat in the last 10 minutes. Check the service and journal.";
} else if (consecutiveFetchFailures > 0) {
   verdict =
      `FETCH FAILING — ${consecutiveFetchFailures} consecutive failed polls (${fetchHealthSource}). ` +
      "The scheduler is alive but fetching is broken; check instagram_monitor.fetch.failed before changing cadence or anchors.";
} else if (unseeded > 0) {
   verdict =
      `SEEDING — ${unseeded} account(s) have a NULL anchor. Their next poll is a silent ` +
      `first_poll_seed that pushes NOTHING, by design. A NULL anchor never delivers posts; ` +
      `for a recent window set last_post_id='' + last_post_at=<cutoff> + last_polled_at=NULL.`;
} else if ((acct.due_now ?? 0) === acct.total) {
   verdict =
      "ALL DUE (resume drip) — the drip is armed at scheduler START, so the first poll waits " +
      "up to RESUME_DRIP_GAP_MS (10 min). Then one account per ~10 min.";
} else if (/^0 in/.test(pushCounts)) {
   verdict =
      "NO RECENT PUSHES — check fetch health and next-poll estimate above. " +
      "A live heartbeat alone does not prove successful fetching; successful polls can also have no new relevant posts.";
} else {
   verdict = journalAvailable
      ? "HEALTHY — recent pushes and no subsequent fetch failures."
      : "UNKNOWN — journal unavailable.";
}
console.log(`\n  VERDICT: ${verdict}\n`);
db.close();
