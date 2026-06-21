/**
 * Calibrates the per-month grid geometry of the Revolución Z calendar PDF
 * templates in `calendar/` and writes it to
 * `src/capabilities/calendar/template-geometry.generated.ts`.
 *
 * The templates are Canva-style designs with the day numbers, weekday headers
 * and SEMANA (ISO week) column rendered as REAL embedded text (font
 * TTMarxiana-Antiqua). We extract every day-number word's bounding box with
 * poppler's `pdftotext -bbox`, cluster them into a regular lattice (7 columns
 * Mon→Sun, N rows), and derive each day cell's drawable rectangle.
 *
 * Why bake it instead of extracting at runtime: the templates are fixed repo
 * assets, so the geometry is static. Baking a generated .ts module keeps the
 * bot free of any PDF-text-extraction dependency (poppler is only needed here,
 * at dev time) and makes placement deterministic. Re-run this script if the
 * templates are ever replaced (e.g. a 2027 set):
 *
 *   tsx scripts/calibrate-calendar-templates.ts
 *
 * Coordinate system: poppler bbox coords are top-left origin, y growing DOWN,
 * in PDF points. We store them as-is; the renderer flips to pdf-lib's
 * bottom-left origin with `pdfY = pageHeight - bboxY`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const TEMPLATE_DIR = resolve(PROJECT_ROOT, 'calendar');
const OUT_FILE = resolve(
  PROJECT_ROOT,
  'src/capabilities/calendar/template-geometry.generated.ts',
);

const MONTHS_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

interface Word { text: string; xMin: number; yMin: number; xMax: number; yMax: number; }

function extractWords(pdfPath: string): { pageW: number; pageH: number; words: Word[] } {
  const xml = execFileSync('pdftotext', ['-bbox', pdfPath, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const page = /<page width="([0-9.]+)" height="([0-9.]+)">/.exec(xml);
  if (!page) throw new Error(`No <page> in pdftotext output for ${pdfPath}`);
  const pageW = Number(page[1]);
  const pageH = Number(page[2]);
  const words: Word[] = [];
  const re =
    /<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([^<]*)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    words.push({
      xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]),
      text: m[5].trim(),
    });
  }
  return { pageW, pageH, words };
}

/**
 * Detect the 7 day-cell column borders from the actual VECTOR grid by
 * rasterizing to grayscale and finding the bright vertical lines on the dark
 * background. The day numbers are right-aligned and inset ~8px from the real
 * cell border, so text-derived columns bleed left across the gridline — these
 * detected lines are the true cell boundaries. Returns 7 {left,right} pairs
 * (Mon→Sun), or null if detection looks off (caller falls back to text).
 */
function detectDayColumns(pdfPath: string): { left: number; right: number }[] | null {
  const dpi = 144;
  const scale = dpi / 72;
  const out = pdfPath.replace(/[^\w]/g, '_');
  const root = `/tmp/_calgrid_${out}`;
  execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-singlefile', pdfPath, root]);
  const buf = readFileSync(`${root}.pgm`);
  let p = 0;
  const tok = () => {
    while (buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x09 || buf[p] === 0x0d) p++;
    let s = '';
    while (p < buf.length && !(buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x09 || buf[p] === 0x0d)) s += String.fromCharCode(buf[p++]);
    return s;
  };
  if (tok() !== 'P5') return null;
  const W = Number(tok());
  const H = Number(tok());
  tok();
  p++;
  const px = buf.subarray(p);
  // Average each column's brightness over a gutter band well inside the grid.
  const yLo = Math.round(300 * scale);
  const yHi = Math.min(H, Math.round(690 * scale));
  const colAvg = new Float64Array(W);
  for (let y = yLo; y < yHi; y++) for (let x = 0; x < W; x++) colAvg[x] += px[y * W + x];
  let max = 0;
  for (let x = 0; x < W; x++) if (colAvg[x] > max) max = colAvg[x];
  const thresh = max * 0.5;
  const lines: number[] = [];
  let run: number[] = [];
  for (let x = 0; x < W; x++) {
    if (colAvg[x] >= thresh) run.push(x);
    else if (run.length) { lines.push(run.reduce((a, b) => a + b, 0) / run.length / scale); run = []; }
  }
  if (run.length) lines.push(run.reduce((a, b) => a + b, 0) / run.length / scale);
  // Expect 9 lines: [SEMANA-left, SEMANA/Mon, Mon/Tue, …, Sat/Sun, Sun-right].
  // The 7 day cells are between lines[1..8].
  if (lines.length !== 9) return null;
  const day = lines.slice(1); // 8 borders → 7 cells
  const pitches = day.slice(1).map((v, i) => v - day[i]);
  const avgP = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  if (pitches.some((q) => Math.abs(q - avgP) > 6)) return null; // non-uniform → distrust
  return day.slice(0, 7).map((left, i) => ({
    left: Math.round(left * 100) / 100,
    right: Math.round(day[i + 1] * 100) / 100,
  }));
}

/** Greedy 1-D clustering: sorted values within `tol` of the running cluster mean. */
function cluster(values: { key: number; w: Word }[], tol: number): { w: Word }[][] {
  const sorted = [...values].sort((a, b) => a.key - b.key);
  const groups: { items: { key: number; w: Word }[]; mean: number }[] = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(v.key - g.mean) <= tol) {
      g.items.push(v);
      g.mean = g.items.reduce((s, x) => s + x.key, 0) / g.items.length;
    } else {
      groups.push({ items: [v], mean: v.key });
    }
  }
  return groups.map((g) => g.items.map((i) => ({ w: i.w })));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function calibrate(file: string): {
  monthKey: string; file: string; pageWidth: number; pageHeight: number;
  rowPitch: number; columns: { left: number; right: number }[];
  rows: { numberTop: number; numberBottom: number }[];
} {
  const base = file.replace(/\.pdf$/i, '');
  const [monthName, yearStr] = base.split(/\s+/);
  const month = MONTHS_ES[monthName.toLowerCase()];
  if (!month) throw new Error(`Unrecognized month name in "${file}"`);
  const monthKey = `${yearStr}-${String(month).padStart(2, '0')}`;

  const { pageW, pageH, words } = extractWords(resolve(TEMPLATE_DIR, file));

  // Day-number words: 1–2 digit integers, in the grid band (below the weekday
  // header at y≈259), to the right of the SEMANA column (xMin>150). This keeps
  // adjacent-month greyed days (they define real grid cells) and drops the
  // title, NOTAS, weekday names, and the SEMANA week-number column.
  const dayWords = words.filter(
    (w) => /^\d{1,2}$/.test(w.text) && Number(w.text) >= 1 && Number(w.text) <= 31
      && w.xMin > 150 && w.yMin > 245,
  );
  if (dayWords.length < 28) {
    throw new Error(`${file}: only found ${dayWords.length} day-number words (expected ≥28)`);
  }

  // Columns: prefer the TRUE cell borders detected from the vector grid lines
  // (day numbers are inset ~8px from the border, so text-derived columns bleed
  // left). Fall back to the text anchor only if line detection looks off.
  const detected = detectDayColumns(resolve(TEMPLATE_DIR, file));
  let columns: { left: number; right: number }[];
  let columnSource: string;
  if (detected) {
    columns = detected;
    columnSource = 'gridlines';
  } else {
    const colGroups = cluster(dayWords.map((w) => ({ key: w.xMax, w })), 25)
      .map((g) => median(g.map((x) => x.w.xMax)))
      .sort((a, b) => a - b);
    if (colGroups.length !== 7) {
      throw new Error(`${file}: expected 7 columns, got ${colGroups.length}: ${colGroups}`);
    }
    const colPitch = median(colGroups.slice(1).map((r, i) => r - colGroups[i]));
    columns = colGroups.map((right) => ({ left: right - colPitch, right }));
    columnSource = 'text-fallback';
  }
  // eslint-disable-next-line no-console
  console.log(`  ${monthKey}: columns via ${columnSource}`);

  // Rows: cluster by the day-number top (yMin).
  const rowGroups = cluster(dayWords.map((w) => ({ key: w.yMin, w })), 25)
    .map((g) => ({
      numberTop: median(g.map((x) => x.w.yMin)),
      numberBottom: median(g.map((x) => x.w.yMax)),
    }))
    .sort((a, b) => a.numberTop - b.numberTop);
  const rowPitch = median(rowGroups.slice(1).map((r, i) => r.numberTop - rowGroups[i].numberTop));

  return {
    monthKey, file, pageWidth: pageW, pageHeight: pageH,
    rowPitch: Math.round(rowPitch * 100) / 100,
    columns: columns.map((c) => ({
      left: Math.round(c.left * 100) / 100,
      right: Math.round(c.right * 100) / 100,
    })),
    rows: rowGroups.map((r) => ({
      numberTop: Math.round(r.numberTop * 100) / 100,
      numberBottom: Math.round(r.numberBottom * 100) / 100,
    })),
  };
}

const files = readdirSync(TEMPLATE_DIR).filter((f) => /\.pdf$/i.test(f)).sort();
const geometries = files.map((f) => {
  const g = calibrate(f);
  // eslint-disable-next-line no-console
  console.log(`${g.monthKey}  ${g.rows.length} rows  pitch=${g.rowPitch}  cols=${g.columns.length}`);
  return g;
});

// The horizontal grid is identical across all 7 templates, but the per-template
// grid-line detector can occasionally miscount lines (texture/scratches). Build
// a consensus column set from the templates whose columns came from real grid
// lines (right edge ≳ first-column 122) and apply it to ALL months, so a
// detection miss never leaves one month on the slightly-off text columns.
{
  const fromGrid = geometries.filter((g) => g.columns[0].left > 119 && g.columns[0].left < 126);
  if (fromGrid.length > 0) {
    const consensus = Array.from({ length: 7 }, (_, c) => ({
      left: median(fromGrid.map((g) => g.columns[c].left)),
      right: median(fromGrid.map((g) => g.columns[c].right)),
    }));
    for (const g of geometries) {
      g.columns = consensus.map((c) => ({
        left: Math.round(c.left * 100) / 100,
        right: Math.round(c.right * 100) / 100,
      }));
    }
    // eslint-disable-next-line no-console
    console.log(`\nApplied consensus columns from ${fromGrid.length} templates to all ${geometries.length}.`);
  }
}

const banner = `// AUTO-GENERATED by scripts/calibrate-calendar-templates.ts — DO NOT EDIT BY HAND.
// Per-month grid geometry of the Revolución Z calendar PDF templates in calendar/.
// Coords are poppler bbox space: top-left origin, y grows DOWN, PDF points.
// Re-run \`tsx scripts/calibrate-calendar-templates.ts\` if the templates change.
`;

const body = `${banner}
import type { MonthTemplateGeometry } from './template-geometry.js';

export const TEMPLATE_GEOMETRY: Record<string, MonthTemplateGeometry> = ${JSON.stringify(
  Object.fromEntries(geometries.map((g) => [g.monthKey, g])),
  null,
  2,
)};
`;

writeFileSync(OUT_FILE, body);
// eslint-disable-next-line no-console
console.log(`\nWrote ${OUT_FILE} (${geometries.length} months)`);
