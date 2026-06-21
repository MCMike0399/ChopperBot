/**
 * End-to-end proof of the global calendar pipeline — NOT a unit test.
 *
 *   tsx scripts/calendar-e2e-proof.ts
 *
 * Drives the REAL tool handlers (CalendarToolSource) against a REAL on-disk
 * SQLite DB with a fake publisher that renders to /tmp, simulating a mod
 * conversation: create the three real Revolución Z events, edit one, delete one.
 * Then it REOPENS the DB in a fresh connection to prove persistence, renders the
 * final state to PDF/PNG, and writes + structurally validates the ICS.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../src/capabilities/calendar/store.js';
import { CalendarToolSource } from '../src/capabilities/calendar/source.js';
import {
  renderMonthPdf, availableMonthKeys, monthsWithOccurrences, templateFileFor, hasTemplateFor,
  type RenderEvent,
} from '../src/capabilities/calendar/render.js';
import { buildCalendar } from '../src/capabilities/calendar/ics.js';
import type { CalendarPublisher, PublishSummary } from '../src/capabilities/calendar/publisher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TPL = resolve(ROOT, 'calendar');
const OUT = '/tmp/chopper-cal';
execFileSync('mkdir', ['-p', OUT]);
const DB_PATH = resolve(OUT, 'proof.db');
rmSync(DB_PATH, { force: true });

const NOW = Date.parse('2026-06-10T18:00:00Z');

/** Renders affected months to disk instead of posting to Discord. */
class FakePublisher implements CalendarPublisher {
  constructor(private store: CalendarStore) {}
  outputChannelId() { return '1518328211165941912'; }
  monthsForEvent(e: RenderEvent) { return monthsWithOccurrences(e, availableMonthKeys()); }
  async publishAll() { return this.run(availableMonthKeys()); }
  async publish(monthKeys: string[]) { return this.run(monthKeys); }
  private async run(monthKeys: string[]): Promise<PublishSummary> {
    const events = this.store.listAll();
    const posted: string[] = [];
    const skipped: string[] = [];
    for (const key of [...new Set(monthKeys)].sort()) {
      if (!hasTemplateFor(key)) { skipped.push(key); continue; }
      const bytes = await renderMonthPdf({
        monthKey: key, events,
        templateBytes: new Uint8Array(readFileSync(resolve(TPL, templateFileFor(key)!))),
      });
      writeFileSync(resolve(OUT, `final-${key}.pdf`), bytes);
      posted.push(key);
    }
    posted.push('ics');
    return { posted, skipped, ok: true };
  }
}

const memory = new SqliteMemoryStore({ path: DB_PATH });
await memory.migrate('calendar', CALENDAR_MIGRATIONS);
const store = new CalendarStore(memory.db());
const src = new CalendarToolSource(store, 'MOD_alice', NOW, new FakePublisher(store));

async function call(tool: string, input: unknown) {
  const res = await src.handle(tool, input);
  const pub = (res.payload as { published?: PublishSummary }).published;
  console.log(`• ${tool} → ${res.status}${pub ? `  published=${JSON.stringify({ posted: pub.posted, skipped: pub.skipped, ok: pub.ok })}` : ''}`);
  return res;
}

console.log('=== Simulated mod conversation (real tool handlers) ===');
// 1) Asamblea constituyente — Sat Jun 20, 8pm, one-off.
await call('calendar_create_event', { title: 'Asamblea constituyente', start_at_iso: '2026-06-21T02:00:00Z', end_at_iso: '2026-06-21T04:00:00Z', location: 'Asamblea-Z' });
// 2) Weekly Sunday circle.
const repensar = await call('calendar_create_event', { title: 'Círculo: Repensar la Pobreza', start_at_iso: '2026-06-15T02:00:00Z', recurrence_freq: 'weekly', location: 'Sala de eventos' });
// 3) Weekly Monday circle.
await call('calendar_create_event', { title: 'Círculo: Las venas abiertas de América Latina', start_at_iso: '2026-06-16T02:00:00Z', recurrence_freq: 'weekly', location: 'Sala de eventos' });
// 4) Edit: move the Sunday circle to 7pm.
const repensarId = (repensar.payload as { event: { id: number } }).event.id;
await call('calendar_update_event', { id: repensarId, start_at_iso: '2026-06-15T01:00:00Z' });
// 5) A one-off to delete.
const doomed = await call('calendar_create_event', { title: 'Evento de prueba', start_at_iso: '2026-06-25T18:00:00Z' });
await call('calendar_delete_event', { id: (doomed.payload as { event: { id: number } }).event.id });
// 6) Duplicate guard + listing.
await call('calendar_search_events', { query: 'Asamblea' });
await call('calendar_list_upcoming', {});

memory.close();

// ── Prove on-disk persistence: reopen in a fresh connection ─────────────────
console.log('\n=== Reopened DB (proves persistence to disk) ===');
const memory2 = new SqliteMemoryStore({ path: DB_PATH });
const store2 = new CalendarStore(memory2.db());
const rows = store2.listAll();
for (const r of rows) {
  console.log(`  #${r.id} "${r.title}" ${new Date(r.start_at).toISOString()} freq=${r.recurrence_freq ?? '-'} by=${r.created_by} @${r.location ?? '-'}`);
}
console.log(`  total master rows persisted: ${rows.length}`);

// ── Render final state from the persisted DB + emit/validate ICS ────────────
for (const key of ['2026-06', '2026-07', '2026-08']) {
  const bytes = await renderMonthPdf({
    monthKey: key, events: store2.listAll(),
    templateBytes: new Uint8Array(readFileSync(resolve(TPL, templateFileFor(key)!))),
  });
  const pdf = resolve(OUT, `final-${key}.pdf`);
  writeFileSync(pdf, bytes);
  execFileSync('pdftoppm', ['-png', '-r', '110', pdf, resolve(OUT, `final-${key}`)]);
}

const ics = buildCalendar(
  store2.listAll().map((e) => ({ id: e.id, title: e.title, description: e.description, location: e.location, start_at: e.start_at, end_at: e.end_at, recurrence_freq: e.recurrence_freq, recurrence_until: e.recurrence_until })),
  { nowMs: NOW },
);
writeFileSync(resolve(OUT, 'final.ics'), ics);

const checks: [string, boolean][] = [
  ['BEGIN:VCALENDAR', ics.startsWith('BEGIN:VCALENDAR')],
  ['has VTIMEZONE UTC-6', ics.includes('TZOFFSETTO:-0600')],
  ['VEVENT count == rows', (ics.split('BEGIN:VEVENT').length - 1) === rows.length],
  ['weekly RRULE present', ics.includes('RRULE:FREQ=WEEKLY')],
  ['CRLF line endings', ics.includes('\r\n')],
  ['all lines <=75 octets', ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)],
];
console.log('\n=== ICS validation ===');
for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
memory2.close();
console.log(`\nArtifacts in ${OUT}: final-2026-06.png, final-2026-08.png, final.ics`);
if (!checks.every(([, ok]) => ok)) process.exit(1);
