/**
 * READ-ONLY preview of what the next calendar reconcile will do to the output
 * channel: which month cards get posted/edited, which get DELETED, the
 * month-rollover verdict, and the range status of every recurring series.
 *
 * Opens the live SQLite read-only and never touches Discord — run it before a
 * restart/publish so a board change (especially a card deletion) is never a
 * surprise.
 *
 *   npx tsx scripts/preview-calendar-board.ts
 *   npx tsx scripts/preview-calendar-board.ts --render   # also write the PDFs+PNGs to /tmp/chopper-cal
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { renderMonthPdf, templateFileFor } from '../src/capabilities/calendar/render.js';
import { pdfToPng } from '../src/capabilities/calendar/raster.js';
import { desiredMonthKeys, monthPublishAction } from '../src/capabilities/calendar/publisher.js';
import { CalendarStore } from '../src/capabilities/calendar/store.js';
import { monthKeyOfUtc, monthWindowUtc } from '../src/capabilities/calendar/grid.js';
import { countOccurrencesUntil } from '../src/capabilities/calendar/recurrence.js';
import { formatInTimezone } from '../src/capabilities/calendar/time.js';

const DB_PATH = process.env.CHOPPERBOT_DB ?? 'data/chopperbot.db';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const store = new CalendarStore(db);
const now = Date.now();
const current = monthKeyOfUtc(now);

console.log(`db            : ${DB_PATH}`);
console.log(`now           : ${formatInTimezone(now)} (CDMX)`);
console.log(`current month : ${current}`);

const events = store.listAll();
const desired = desiredMonthKeys(events, now);
const tracked = store.listPublished().filter((r) => r.pub_key.startsWith('pdf:')).map((r) => r.pub_key.slice(4));
const verdict = monthPublishAction(current, (k) => store.getPublished(k) !== null);

console.log(`\n── board ──`);
console.log(`tracked now   : [${tracked.join(', ') || '—'}]`);
console.log(`desired       : [${desired.join(', ') || '—'}]`);
console.log(`→ post/edit   : [${desired.join(', ') || '—'}]`);
console.log(`→ DELETE      : [${tracked.filter((m) => !desired.includes(m)).join(', ') || '—'}]`);
console.log(`rollover      : ${verdict}`);

for (const key of desired) {
  const [y, m] = key.split('-').map(Number);
  const { startMs, endMs } = monthWindowUtc(y, m);
  console.log(`  ${key}: ${store.listOccurrences(startMs, endMs - 1).length} occurrence(s) will render`);
}

console.log(`\n── recurring series (range status) ──`);
const series = events.filter((e) => e.recurrence_freq !== null);
if (series.length === 0) console.log('  (none)');
for (const e of series) {
  const n = countOccurrencesUntil(e.start_at, e.recurrence_freq!, e.recurrence_until);
  const range = e.recurrence_until === null
    ? 'INDEFINIDA'
    : `hasta ${formatInTimezone(e.recurrence_until)} · ${n} ocurrencias`;
  console.log(
    `  #${String(e.id).padEnd(3)} ${e.title.slice(0, 42).padEnd(42)} ${e.recurrence_freq!.padEnd(7)}` +
      ` 1ª=${formatInTimezone(e.start_at).padEnd(24)} ${range}`,
  );
}

console.log(`\n── one-off events by month ──`);
const byMonth = new Map<string, number>();
for (const e of events) {
  if (e.recurrence_freq !== null) continue;
  const k = monthKeyOfUtc(e.start_at);
  byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byMonth].sort()) {
  const rel = k < current ? 'pasado (no se publica)' : k === current ? 'mes actual' : 'futuro (card propia)';
  console.log(`  ${k}: ${String(n).padStart(2)} evento(s) — ${rel}`);
}

// --render: produce the exact artifacts the publisher would attach, so the card
// can be eyeballed before it reaches the community channel.
if (process.argv.includes('--render')) {
  const outDir = '/tmp/chopper-cal';
  await mkdir(outDir, { recursive: true });
  const overrides = store.overridesByMaster();
  console.log(`\n── rendering desired cards → ${outDir} ──`);
  for (const monthKey of desired) {
    const file = templateFileFor(monthKey);
    if (!file) { console.log(`  ${monthKey}: no template, skipped`); continue; }
    const templateBytes = new Uint8Array(await readFile(resolve('calendar', file)));
    const pdf = await renderMonthPdf({ monthKey, events, overrides, templateBytes });
    await writeFile(`${outDir}/${monthKey}.pdf`, pdf);
    const png = await pdfToPng(pdf, 150);
    await writeFile(`${outDir}/${monthKey}.png`, png);
    console.log(`  ${monthKey}: ${outDir}/${monthKey}.png (${(png.length / 1024).toFixed(0)} KB)`);
  }
}
db.close();
