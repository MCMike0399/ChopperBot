/**
 * Visual proof harness for the calendar renderer + ICS generator. NOT a test —
 * it writes real PDFs/PNGs/ICS to /tmp so the rendering can be eyeballed.
 *
 *   tsx scripts/render-calendar-sample.ts
 *
 * Seeds the three real Revolución Z events (which fall on Jun 14/15/20 2026)
 * plus stress cases (long titles, a crowded day, weekly series spilling into
 * later months), renders June (5-row) and August (6-row), and emits the ICS.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMonthPdf, type RenderEvent } from '../src/capabilities/calendar/render.js';
import { buildCalendar, type IcsEvent } from '../src/capabilities/calendar/ics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TPL = resolve(ROOT, 'calendar');
const OUT = '/tmp/chopper-cal';
execFileSync('mkdir', ['-p', OUT]);

const iso = (s: string) => Date.parse(s);

// Real events (CDMX 8pm = 02:00Z next day), plus stress cases.
const events: RenderEvent[] = [
  // Sun Jun 14, weekly — Círculo "Repensar la Pobreza"
  { id: 1, title: 'Círculo: Repensar la Pobreza', start_at: iso('2026-06-15T02:00:00Z'), end_at: null, recurrence_freq: 'weekly', recurrence_until: null },
  // Mon Jun 15, weekly — Círculo "Las venas abiertas de América Latina"
  { id: 2, title: 'Círculo: Las venas abiertas de América Latina', start_at: iso('2026-06-16T02:00:00Z'), end_at: null, recurrence_freq: 'weekly', recurrence_until: null },
  // Sat Jun 20, one-off — Asamblea constituyente
  { id: 3, title: 'Asamblea constituyente', start_at: iso('2026-06-21T02:00:00Z'), end_at: iso('2026-06-21T04:00:00Z'), recurrence_freq: null, recurrence_until: null },
  // Crowd test: Wed Jun 17 has several events (forces stacking + overflow).
  { id: 4, title: 'Taller de serigrafía', start_at: iso('2026-06-17T17:00:00Z'), end_at: null, recurrence_freq: null, recurrence_until: null },
  { id: 5, title: 'Comida colectiva', start_at: iso('2026-06-17T19:00:00Z'), end_at: null, recurrence_freq: null, recurrence_until: null },
  { id: 6, title: 'Proyección + debate: cine documental latinoamericano contemporáneo', start_at: iso('2026-06-17T01:00:00Z'), end_at: null, recurrence_freq: null, recurrence_until: null },
  { id: 7, title: 'Cierre de jornada', start_at: iso('2026-06-17T23:30:00Z'), end_at: null, recurrence_freq: null, recurrence_until: null },
  // Daily series (mornings) to show recurrence density on weekdays.
  { id: 8, title: 'Brigada de limpieza', start_at: iso('2026-06-08T15:00:00Z'), end_at: null, recurrence_freq: 'daily', recurrence_until: iso('2026-06-13T15:00:00Z') },
  // Emoji + smart punctuation, to prove sanitization.
  { id: 9, title: '🔥 ¡Fiesta! — “tardeada” antifa 🏴', start_at: iso('2026-06-27T20:00:00Z'), end_at: null, recurrence_freq: null, recurrence_until: null },
];

async function renderMonth(monthKey: string, file: string) {
  const templateBytes = new Uint8Array(readFileSync(resolve(TPL, file)));
  const bytes = await renderMonthPdf({ monthKey, events, templateBytes });
  const pdfPath = resolve(OUT, `${monthKey}.pdf`);
  writeFileSync(pdfPath, bytes);
  // Rasterize at 110 DPI for inspection.
  execFileSync('pdftoppm', ['-png', '-r', '110', pdfPath, resolve(OUT, monthKey)]);
  console.log(`rendered ${monthKey} → ${pdfPath} (+ PNG)`);
}

await renderMonth('2026-06', 'Junio 2026.pdf');
await renderMonth('2026-08', 'Agosto 2026.pdf');

const ics: IcsEvent[] = events.map((e) => ({
  id: e.id, title: e.title, description: null, location: null,
  start_at: e.start_at, end_at: e.end_at,
  recurrence_freq: e.recurrence_freq, recurrence_until: e.recurrence_until,
}));
const icsText = buildCalendar(ics, { nowMs: iso('2026-06-21T18:00:00Z') });
writeFileSync(resolve(OUT, 'revolucion-z.ics'), icsText);
console.log(`wrote ICS → ${resolve(OUT, 'revolucion-z.ics')} (${ics.length} events)`);
console.log(`\nInspect: ${OUT}`);
