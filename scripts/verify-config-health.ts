/**
 * READ-ONLY preview of `config_system action:health` against the LIVE database.
 *
 * Builds the same report the admin console returns, using the real bindings from
 * SQLite and a registry standing in for the boot-time one. Touches no Discord and
 * writes nothing — run it to sanity-check the health view (or to triage the bot
 * from a shell when Discord itself is the thing that's broken).
 *
 *   npx tsx scripts/verify-config-health.ts          # summary
 *   npx tsx scripts/verify-config-health.ts --json    # full report
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { collectHealth } from '../src/capabilities/configuration/health.js';
import { CapabilityRegistry } from '../src/capabilities/registry.js';
import { buildRouter } from '../src/capabilities/routing.js';
import { ConfigurationStore } from '../src/capabilities/configuration/store.js';
import type { Capability } from '../src/capabilities/capability.js';

const DB_PATH = process.env.CHOPPERBOT_DB ?? resolve(config.CHOPPERBOT_DATA_DIR, 'chopperbot.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Stand-in for the boot registry: everything the running bot would register when
// its config is complete. A capability the live bot actually skipped still shows
// as "enabled" here — the real tool gets the true list, this is a data check.
const registry = new CapabilityRegistry();
for (const id of [
  'configuration', 'calendar', 'instagram_monitor', 'file_scanner',
  'event_intake', 'general_chat',
]) {
  registry.register({ id, description: `${id}`, init: async () => {}, buildTurn: async () => ({ system: '', tools: { tools: [], handle: async () => ({ status: 'success', payload: {} }) } }) } as unknown as Capability);
}

const bindings = new Map(new ConfigurationStore(db).list().map((r) => [r.channel_id, r.capability_id]));
const report = collectHealth({
  db,
  registry,
  router: buildRouter(bindings),
  client: { guilds: { cache: new Map() } } as never,
  startedAtMs: Date.now() - 3 * 86_400_000, // pretend 3 d uptime: skips the "recent boot" note
  dbPath: DB_PATH,
  skipped: [],
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const g = '\x1b[32m', y = '\x1b[33m', r = '\x1b[31m', dim = '\x1b[2m', rst = '\x1b[0m';
  const color = report.status === 'ok' ? g : report.status === 'degraded' ? y : r;
  console.log(`\nstatus: ${color}${report.status.toUpperCase()}${rst}   ${dim}(db: ${DB_PATH})${rst}`);
  if (report.problems.length === 0) console.log(`${g}sin problemas${rst}`);
  for (const p of report.problems) console.log(`  ${y}•${rst} ${p}`);
  for (const [name, block] of Object.entries(report)) {
    if (name === 'status' || name === 'problems') continue;
    console.log(`\n${dim}── ${name} ──${rst}`);
    console.log(
      JSON.stringify(block, null, 2)
        .split('\n').slice(1, -1)
        .map((l) => l.replace(/^  /, '  '))
        .join('\n'),
    );
  }
  console.log();
}
db.close();
