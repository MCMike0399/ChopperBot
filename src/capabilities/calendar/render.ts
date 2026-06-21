/**
 * Renders the global calendar's events into a month's PDF template.
 *
 * The templates in `calendar/` ship with the grid, day numbers, weekday headers
 * and Revolución Z branding already drawn. This module overlays each day's
 * events as compact red "event blocks" inside the correct cell, using the
 * pre-calibrated geometry (see template-geometry.ts). Recurring events are
 * expanded so a weekly series lands in every week's cell within the month.
 *
 * Text is drawn with the standard Helvetica font, so anything outside WinAnsi
 * (emoji, CJK, smart quotes) is normalized or stripped first — calendar titles
 * stay legible and pdf-lib never throws on an unencodable glyph.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { cellBox, type MonthTemplateGeometry } from './template-geometry.js';
import { TEMPLATE_GEOMETRY } from './template-geometry.generated.js';
import { dayToCell, localParts, monthWindowUtc } from './grid.js';
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
const MAX_INSTANCES_PER_MONTH = 40; // safety cap on a daily series within a month

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

  // Smaller type in the denser 6-row months.
  const fontSize = geom.rowPitch >= 90 ? 8 : 7;
  const lineH = fontSize + 2.5;          // baseline-to-baseline within a block
  const vPad = 2.5;                       // block top/bottom padding
  const gap = 2.5;                        // gap between stacked blocks
  const padX = 5;
  const maxLinesPerEvent = fontSize >= 8 ? 3 : 2; // long titles wrap up to this

  for (const [key, list] of cells) {
    const [row, col] = key.split(',').map(Number);
    const box = cellBox(geom, row, col);
    if (!box) continue;
    list.sort((a, b) => a.startMs - b.startMs);
    const innerW = box.width - 2 * padX;

    let curTop = box.top;
    let i = 0;
    for (; i < list.length; i++) {
      const time = formatLocalClock(list[i].startMs);
      const timeW = bold.widthOfTextAtSize(time + ' ', fontSize);
      // Title wraps: line 1 shares space with the time; the rest use full width.
      const lines = wrapEventLines(font, fontSize, list[i].title, innerW - timeW, innerW, maxLinesPerEvent);
      const nLines = Math.max(1, lines.length);
      const blockH = 2 * vPad + nLines * lineH;

      // Stop if this block won't fit (the first one always fits — maxLines is
      // capped so a single event never exceeds the smallest cell).
      if (i > 0 && blockH > curTop - box.bottom) break;

      const blockBottom = curTop - blockH;
      page.drawRectangle({
        x: box.x, y: blockBottom, width: box.width, height: blockH,
        color: BLOCK_COLOR, borderColor: BLOCK_BORDER, borderWidth: 0.5,
      });
      for (let k = 0; k < nLines; k++) {
        const baseY = curTop - vPad - (k + 1) * lineH + (lineH - fontSize) / 2 + 0.5;
        if (k === 0) {
          page.drawText(time, { x: box.x + padX, y: baseY, size: fontSize, font: bold, color: TEXT_COLOR });
          if (lines[0]) page.drawText(lines[0], { x: box.x + padX + timeW, y: baseY, size: fontSize, font, color: TEXT_COLOR });
        } else if (lines[k]) {
          page.drawText(lines[k], { x: box.x + padX, y: baseY, size: fontSize, font, color: TEXT_COLOR });
        }
      }
      curTop = blockBottom - gap;
    }

    if (i < list.length) {
      const more = `+${list.length - i} más`;
      const baseY = curTop - fontSize;
      if (baseY >= box.bottom - 1) {
        page.drawText(more, { x: box.x + padX, y: baseY, size: fontSize - 0.5, font: bold, color: OVERFLOW_COLOR });
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

/**
 * Word-wrap a title into up to `maxLines` lines. Line 0 has `firstWidth`
 * available (it shares the row with the bold time); later lines use `restWidth`.
 * If the title doesn't fit, the last line is cut with an ellipsis.
 */
function wrapEventLines(
  font: PDFFont,
  size: number,
  title: string,
  firstWidth: number,
  restWidth: number,
  maxLines: number,
): string[] {
  const words = sanitizeForPdf(title).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const width = Math.max(1, lines.length === 0 ? firstWidth : restWidth);
    let line = '';
    while (i < words.length) {
      const trial = line ? `${line} ${words[i]}` : words[i];
      if (font.widthOfTextAtSize(trial, size) <= width) {
        line = trial;
        i++;
      } else if (!line) {
        // A single word too wide even for an empty line → hard-cut it.
        line = hardTruncate(font, size, words[i], width);
        i++;
        break;
      } else {
        break;
      }
    }
    lines.push(line);
  }
  if (i < words.length && lines.length > 0) {
    const last = lines.length - 1;
    const width = Math.max(1, last === 0 ? firstWidth : restWidth);
    lines[last] = withEllipsis(font, size, lines[last], width);
  }
  return lines;
}

/** Longest prefix of a single (unbreakable) word + "..." that fits `width`. */
function hardTruncate(font: PDFFont, size: number, word: string, width: number): string {
  if (width <= 0) return '';
  if (font.widthOfTextAtSize(word, size) <= width) return word;
  const ell = '...';
  let t = word;
  while (t.length && font.widthOfTextAtSize(t + ell, size) > width) t = t.slice(0, -1);
  return t ? t + ell : '';
}

/** Append "..." to a line, dropping trailing chars until it fits `width`. */
function withEllipsis(font: PDFFont, size: number, text: string, width: number): string {
  const ell = '...';
  if (font.widthOfTextAtSize(text + ell, size) <= width) return text + ell;
  let t = text;
  while (t.length && font.widthOfTextAtSize(t + ell, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}${ell}`;
}
