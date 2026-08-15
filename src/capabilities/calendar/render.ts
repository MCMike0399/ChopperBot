/**
 * Renders the global calendar's events into a month's PDF template.
 *
 * The templates in `calendar/` ship with the grid, day numbers, weekday headers
 * and Revolución Z branding already drawn. This module overlays each day's
 * events as compact red "event blocks" inside the correct cell, using the
 * pre-calibrated geometry (see template-geometry.ts). Recurring events are
 * expanded so a weekly series lands in every week's cell within the month.
 *
 * How many chips a day shows, at what size, and with how many title lines each
 * is decided by `cell-layout.ts` — it plans the cell as a whole so a day with
 * two events shows two events, and "+N más" appears only when the day is
 * genuinely full. This module owns the drawing and the WinAnsi text hygiene.
 *
 * Text is drawn with the standard Helvetica font, so anything outside WinAnsi
 * (emoji, CJK, smart quotes) is normalized or stripped first — calendar titles
 * stay legible and pdf-lib never throws on an unencodable glyph.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { cellBox } from './template-geometry.js';
import { TEMPLATE_GEOMETRY } from './template-geometry.generated.js';
import { dayToCell, localParts, monthWindowUtc } from './grid.js';
import { planCell, type CellItem, type TextMeasurer } from './cell-layout.js';
import { expandOccurrences } from './recurrence.js';
import { formatLocalClock } from './time.js';
import type { OccurrenceOverride, RecurrenceFreq } from './recurrence.js';

/** Minimal event shape the renderer needs (a superset of MasterEventLike). */
export interface RenderEvent {
  id: number;
  title: string;
  start_at: number; // UTC ms (master/anchor start)
  end_at: number | null;
  recurrence_freq: RecurrenceFreq | null;
  recurrence_until: number | null;
}

export interface RenderMonthInput {
  monthKey: string; // "2026-06"
  events: RenderEvent[];
  /** Raw bytes of the month's template PDF. */
  templateBytes: Uint8Array;
  /** Per-occurrence overrides: master id → (original occurrence ms → override). */
  overrides?: ReadonlyMap<number, ReadonlyMap<number, OccurrenceOverride>>;
}

// Theme: deep red blocks (matching the template's red bars) with white text.
const BLOCK_COLOR = rgb(0.66, 0.07, 0.13);
const BLOCK_BORDER = rgb(0.92, 0.16, 0.22);
const TEXT_COLOR = rgb(1, 1, 1);
const OVERFLOW_COLOR = rgb(0.75, 0.75, 0.78);
const PAD_X = 5; // horizontal text inset inside an event block
const MAX_INSTANCES_PER_MONTH = 40; // safety cap on a daily series within a month

/** Adapt the two embedded Helvetica faces to the planner's measuring interface. */
export function helveticaMeasurer(regular: PDFFont, bold: PDFFont): TextMeasurer {
  return {
    width: (text, size) => regular.widthOfTextAtSize(text, size),
    boldWidth: (text, size) => bold.widthOfTextAtSize(text, size),
  };
}

/** Whether a month template exists for this key. */
export function hasTemplateFor(monthKey: string): boolean {
  return monthKey in TEMPLATE_GEOMETRY;
}

/** All calibrated month keys, sorted. */
export function availableMonthKeys(): string[] {
  return Object.keys(TEMPLATE_GEOMETRY).sort();
}

/** The template filename under `calendar/` for a month, or null if none. */
export function templateFileFor(monthKey: string): string | null {
  return TEMPLATE_GEOMETRY[monthKey]?.file ?? null;
}

/**
 * Subset of `monthKeys` in which `event` has at least one (expanded) occurrence.
 * Used by the publisher to know which month PDFs to re-render after an edit.
 */
export function monthsWithOccurrences(event: RenderEvent, monthKeys: string[]): string[] {
  const out: string[] = [];
  for (const key of monthKeys) {
    const [y, m] = key.split('-').map(Number);
    const { startMs, endMs } = monthWindowUtc(y, m);
    const occ = expandOccurrences(event, startMs, endMs - 1, MAX_INSTANCES_PER_MONTH);
    if (occ.length > 0) out.push(key);
  }
  return out;
}

interface CellEvent {
  startMs: number;
  title: string;
}

/**
 * Render the month's events onto its template. Throws if no template is
 * calibrated for `monthKey` (callers should gate on {@link hasTemplateFor}).
 */
export async function renderMonthPdf(input: RenderMonthInput): Promise<Uint8Array> {
  const geom = TEMPLATE_GEOMETRY[input.monthKey];
  if (!geom) throw new Error(`No calendar template for ${input.monthKey}`);
  const [year, month] = input.monthKey.split('-').map(Number);
  const { startMs, endMs } = monthWindowUtc(year, month);

  // Bucket every occurrence into its grid cell, applying per-occurrence overrides.
  const cells = new Map<string, CellEvent[]>();
  for (const ev of input.events) {
    const ovs = ev.recurrence_freq !== null ? input.overrides?.get(ev.id) : undefined;
    const occs = expandOccurrences(ev, startMs, endMs - 1, MAX_INSTANCES_PER_MONTH, ovs);
    for (const occ of occs) {
      const p = localParts(occ.start_at);
      if (p.year !== year || p.month !== month) continue; // guard window edges
      const { row, col } = dayToCell(year, month, p.day);
      const key = `${row},${col}`;
      const list = cells.get(key) ?? [];
      list.push({ startMs: occ.start_at, title: sanitizeForPdf(occ.override?.title ?? ev.title) });
      cells.set(key, list);
    }
  }

  const pdf = await PDFDocument.load(input.templateBytes);
  const page = pdf.getPages()[0];
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Smaller type in the denser 6-row months. This is the cell's DEFAULT size;
  // planCell only steps below it on a day too crowded to fit otherwise.
  const baseFontSize = geom.rowPitch >= 90 ? 8 : 7;
  const measurer = helveticaMeasurer(font, bold);
  // The calibrated geometry is measured from the top of the page box, so the
  // flip to pdf-lib coordinates has to start at the MediaBox origin (7.92 on
  // every one of these templates), not at 0.
  const pageOriginY = page.getMediaBox().y;

  for (const [key, list] of cells) {
    const [row, col] = key.split(',').map(Number);
    const box = cellBox(geom, row, col, pageOriginY);
    if (!box) continue;
    list.sort((a, b) => a.startMs - b.startMs);

    const items: CellItem[] = list.map((e) => ({
      time: formatLocalClock(e.startMs),
      title: e.title,
    }));
    // The whole cell is planned at once (see cell-layout.ts): how many chips,
    // at what size, with how many title lines each.
    const plan = planCell(items, {
      innerWidth: box.width - 2 * PAD_X,
      height: box.height,
      baseFontSize,
      measurer,
    });
    const { fontSize, lineH, vPad, gap } = plan.style;

    let curTop = box.top;
    for (const block of plan.blocks) {
      const blockBottom = curTop - block.height;
      page.drawRectangle({
        x: box.x, y: blockBottom, width: box.width, height: block.height,
        color: BLOCK_COLOR, borderColor: BLOCK_BORDER, borderWidth: 0.5,
      });
      const nLines = Math.max(1, block.lines.length);
      for (let k = 0; k < nLines; k++) {
        const baseY = curTop - vPad - (k + 1) * lineH + (lineH - fontSize) / 2 + 0.5;
        if (k === 0) {
          page.drawText(block.time, { x: box.x + PAD_X, y: baseY, size: fontSize, font: bold, color: TEXT_COLOR });
          if (block.lines[0]) {
            page.drawText(block.lines[0], { x: box.x + PAD_X + block.timeWidth, y: baseY, size: fontSize, font, color: TEXT_COLOR });
          }
        } else if (block.lines[k]) {
          page.drawText(block.lines[k], { x: box.x + PAD_X, y: baseY, size: fontSize, font, color: TEXT_COLOR });
        }
      }
      curTop = blockBottom - gap;
    }

    if (plan.hidden > 0) {
      // The plan reserved this line's height, so it lands inside the cell; the
      // guard only covers the degenerate "not even one chip fits" fallback.
      const baseY = curTop + gap - plan.overflowGap - plan.overflowSize;
      if (baseY >= box.bottom - 2) {
        page.drawText(`+${plan.hidden} más`, {
          x: box.x + PAD_X, y: baseY, size: plan.overflowSize, font: bold, color: OVERFLOW_COLOR,
        });
      }
    }
  }

  return pdf.save();
}

/**
 * Map text into Helvetica's WinAnsi range: normalize, swap smart punctuation
 * for ASCII, and drop anything unencodable (emoji, CJK). Keeps Spanish accents
 * and ¿¡ which are valid WinAnsi.
 */
export function sanitizeForPdf(s: string): string {
  const swapped = s
    .normalize('NFC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/[•●‣]/g, '-');
  let out = '';
  for (const ch of swapped) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff)) out += ch;
    // else: dropped (emoji, CJK, control chars, …)
  }
  return out.replace(/\s+/g, ' ').trim();
}

