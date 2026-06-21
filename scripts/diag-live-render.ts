/** Diagnostic: render months-with-events straight from a DB snapshot. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { renderMonthPdf, availableMonthKeys, templateFileFor, hasTemplateFor } from '../src/capabilities/calendar/render.js';
import { monthWindowUtc } from '../src/capabilities/calendar/grid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TPL = resolve(ROOT, 'calendar');
const OUT = '/tmp/chopper-cal';
const db = new Database(process.argv[2] ?? resolve(ROOT, 'data/chopperbot.db'), { readonly: true });
const events = db.prepare('SELECT * FROM calendar_events ORDER BY start_at').all() as any[];
console.log(`events: ${events.length}`);

for (const key of availableMonthKeys()) {
  if (!hasTemplateFor(key)) continue;
  const [y, m] = key.split('-').map(Number);
  const { startMs, endMs } = monthWindowUtc(y, m);
  const has = events.some((e) => {
    if (e.recurrence_freq) return e.start_at <= endMs && (e.recurrence_until == null || e.recurrence_until >= startMs);
    return e.start_at >= startMs && e.start_at < endMs;
  });
  if (!has) continue;
  const bytes = await renderMonthPdf({ monthKey: key, events, templateBytes: new Uint8Array(readFileSync(resolve(TPL, templateFileFor(key)!))) });
  const pdf = resolve(OUT, `diag-${key}.pdf`);
  writeFileSync(pdf, bytes);
  execFileSync('pdftoppm', ['-png', '-r', '200', pdf, resolve(OUT, `diag-${key}`)]);
  console.log(`rendered ${key}`);
}
