// One-command triage for "the monitor looks dead" — walks the exact three
// silent states that all present as an empty channel (see the 2026-09-10 note in
// docs/capabilities/instagram-monitor.md):
//
//   1. kill-switch engaged      → nothing is ever polled
//   2. forward-only seeding     → polls succeed, push NOTHING, forever
//   3. cadence decay            → polling normally, next poll up to 12 h away
//
// All three look identical from Discord. This prints which one you are in, and
// the query to act on it. Read-only: it never writes to the DB or to Instagram.
//
// Run: npx tsx scripts/ig-monitor-status.ts
import "dotenv/config";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const db = new Database("data/chopperbot.db", { readonly: true });
const fmt = (ms: number | null | undefined): string =>
   ms ? new Date(ms).toLocaleString("es-MX", { hour12: false }) : "—";
const ago = (ms: number | null | undefined): string =>
   ms ? `${Math.round((Date.now() - ms) / 1000)}s ago` : "never";

interface RuntimeRow {
   global_stop: number;
   stop_reason: string | null;
   requests_24h: number | null;
   heartbeat_at: number | null;
   poll_stretch: number | null;
}
const rt = db
   .prepare(
      `SELECT global_stop, stop_reason, requests_24h, heartbeat_at, poll_stretch
         FROM instagram_monitor_runtime WHERE id = 1`,
   )
   .get() as RuntimeRow | undefined;

const acct = db
   .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN last_post_id IS NULL THEN 1 ELSE 0 END) unseeded,
              SUM(CASE WHEN last_polled_at IS NULL THEN 1 ELSE 0 END) due_now,
              SUM(paused) paused
         FROM instagram_monitor_accounts`,
   )
   .get() as { total: number; unseeded: number | null; due_now: number | null; paused: number | null };

const soonest = db
   .prepare(
      `SELECT username, last_polled_at, poll_interval_ms
         FROM instagram_monitor_accounts
        WHERE last_polled_at IS NOT NULL AND paused = 0
        ORDER BY (last_polled_at + poll_interval_ms) ASC LIMIT 1`,
   )
   .get() as { username: string; last_polled_at: number; poll_interval_ms: number } | undefined;

// Best effort: the journal is the only place pushes are visible.
let pushCounts = "unavailable (journalctl not readable here)";
let recentEvents = "";
try {
   const j = execFileSync(
      "journalctl",
      ["--user", "-u", "chopperbot", "-o", "cat", "--since", "-30 min", "--no-pager"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
   );
   const counts = new Map<string, number>();
   for (const line of j.split("\n")) {
      // pino emits the bound fields BEFORE `msg`, so channelId precedes the
      // message key — match the two independently rather than in one regex.
      if (line.includes('"msg":"instagram_monitor.push"')) {
         const m = /"channelId":"(\d+)"/.exec(line);
         if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
         continue;
      }
      const e = /"msg":"(instagram_monitor\.[a-z_.]+)"/.exec(line);
      if (e) recentEvents = e[1]!; // last event seen in the window
   }
   pushCounts =
      counts.size === 0
         ? "0 in the last 30 min"
         : [...counts].map(([c, n]) => `${c}: ${n}`).join(", ");
} catch {
   /* journal unavailable — not fatal */
}

console.log("Instagram monitor — triage\n");
console.log(`  kill-switch     : ${rt?.global_stop === 1 ? `ENGAGED — ${rt.stop_reason}` : "off"}`);
console.log(`  requests_24h    : ${rt?.requests_24h ?? "—"}   (resets to 0 on restart — not a liveness signal)`);
console.log(`  heartbeat       : ${fmt(rt?.heartbeat_at)}  (${ago(rt?.heartbeat_at)}) ← scheduler liveness`);
console.log(`  poll_stretch    : ${rt?.poll_stretch?.toFixed(2) ?? "—"}`);
console.log(
   `  accounts        : ${acct.total} total | ${acct.unseeded ?? 0} unseeded | ${acct.due_now ?? 0} due now | ${acct.paused ?? 0} paused`,
);
if (soonest) {
   const due = soonest.last_polled_at + soonest.poll_interval_ms;
   console.log(
      `  next poll due   : ${fmt(due)} (${soonest.username}, every ${(soonest.poll_interval_ms / 3_600_000).toFixed(1)}h)`,
   );
}
console.log(`  pushes (30 min) : ${pushCounts}`);
if (recentEvents) console.log(`  last journal ev : ${recentEvents}`);

const unseeded = acct.unseeded ?? 0;
let verdict: string;
if (rt?.global_stop === 1) {
   verdict = "STOPPED — kill-switch. Nothing is polled. Resume: config_instagram action:resume_monitor confirm:true";
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
      "POLLING, NO PUSHES — healthy logs with an empty channel usually means cadence decay: " +
      "after a long outage intervals stretch to the 12 h ceiling, so pushes resume only on the " +
      "next poll. Check `next poll due` above.";
} else {
   verdict = "HEALTHY — polling and pushing.";
}
console.log(`\n  VERDICT: ${verdict}\n`);
db.close();
