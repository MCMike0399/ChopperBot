/**
 * Fitting a day's events into one cell of the month template.
 *
 * The templates give each day a fixed, small band (≈41 pt on the 6-row months,
 * ≈57 pt on the 5-row ones), so "how many events fit" is a real packing problem
 * and NOT something a per-event greedy loop can answer: laying out the first
 * event as generously as possible is exactly what starves the second one.
 * (Live case, Agosto 2026: Aug 10 had two events, the first wrapped to two
 * lines — 24 pt + 2.5 pt gap — leaving 14.48 pt where a one-line chip needs
 * 14.5. The day rendered one event and "+1 más" with a whole chip's worth of
 * space visually free below it.)
 *
 * So this module plans the WHOLE cell at once, budget-first:
 *
 *  1. Every event starts at one line. That maximizes how many events are shown,
 *     which is the property that matters most — a hidden event is invisible,
 *     a clipped title is still a legible event.
 *  2. Leftover height is then handed back out as extra title lines, one pass at
 *     a time (fair round-robin), so a long title only takes a second line when
 *     nothing else needs that space.
 *  3. If the events still don't fit, the plan is retried on a ladder of denser
 *     "tiers" — first tightening padding, then stepping the type down — and a
 *     denser tier is only accepted if it actually shows MORE events. Type never
 *     shrinks just to un-clip a title, so a normal day keeps the design's
 *     default look.
 *  4. Only when even the tightest tier can't show everything does the cell fall
 *     back to a grey "+N más" line, whose height is reserved up front rather
 *     than being drawn into whatever happens to be left.
 *
 * Pure and font-agnostic: the caller injects a {@link TextMeasurer}, so the
 * planner is unit-testable and the pdf-lib types stay in render.ts.
 */

/** One event to place in the cell (text already sanitized for the PDF font). */
export interface CellItem {
  /** Bold time prefix, e.g. "8:00 PM". */
  time: string;
  /** Event title, drawn after the time and wrapped as space allows. */
  title: string;
}

/** Width lookup for the two faces the chips use. */
export interface TextMeasurer {
  width(text: string, size: number): number;
  boldWidth(text: string, size: number): number;
}

/** The metrics the chosen tier settled on; the renderer draws with these. */
export interface CellStyle {
  fontSize: number;
  /** Baseline-to-baseline distance inside a chip. */
  lineH: number;
  /** Chip top/bottom padding. */
  vPad: number;
  /** Vertical gap between stacked chips. */
  gap: number;
}

/** One laid-out chip. `lines[0]` shares its row with the bold time. */
export interface CellBlock {
  time: string;
  /** Width of the time prefix (including its trailing space) at `style.fontSize`. */
  timeWidth: number;
  lines: string[];
  height: number;
  /** True when the title had to be cut with an ellipsis. */
  truncated: boolean;
}

export interface CellPlan {
  style: CellStyle;
  blocks: CellBlock[];
  /** Events that did not fit → rendered as "+N más". 0 when everything fits. */
  hidden: number;
  /** Gap between the last chip and the "+N más" line. */
  overflowGap: number;
  /** Font size of the "+N más" line. */
  overflowSize: number;
  /** Index of the density tier that won (0 = the roomy default). */
  tier: number;
}

export interface CellLayoutInput {
  /** Horizontal room for text inside a chip (chip width minus side padding). */
  innerWidth: number;
  /** Vertical room in the cell. */
  height: number;
  /** The month's default type size (tiers step down from here). */
  baseFontSize: number;
  measurer: TextMeasurer;
}

/** Leading added to the font size for baseline-to-baseline distance. */
const LINE_LEADING = 2.5;
/** Type never shrinks below this — past it a chip stops being readable in the PNG. */
const MIN_FONT_SIZE = 5.5;
/** A single title never takes more than this many lines, however roomy the cell. */
const MAX_LINES = 3;
/** Space between the last chip and the "+N más" line. */
const OVERFLOW_GAP = 1;
/**
 * Sub-pixel slack (¼ pt ≈ ½ px in the 150-DPI PNG) so a layout that misses the
 * cell by a rounding error still counts as fitting. The cell already keeps a
 * 7 pt pad above the next row's day number, so this can never collide.
 */
const FIT_EPSILON = 0.25;

interface Tier {
  sizeDelta: number;
  vPad: number;
  gap: number;
  maxLines: number;
}

/**
 * Density ladder, roomiest first. Padding tightens before the type does, and
 * the type only steps down in the last tiers — a denser tier is accepted only
 * when it shows strictly more events (see {@link planCell}).
 */
const TIERS: Tier[] = [
  { sizeDelta: 0, vPad: 2.5, gap: 2.5, maxLines: 3 },
  { sizeDelta: 0, vPad: 2, gap: 2, maxLines: 3 },
  { sizeDelta: -0.5, vPad: 2, gap: 1.75, maxLines: 2 },
  { sizeDelta: -1, vPad: 1.5, gap: 1.5, maxLines: 2 },
  { sizeDelta: -1.5, vPad: 1, gap: 1.25, maxLines: 1 },
];

/** Wrapped title lines plus whether anything had to be cut. */
export interface WrappedTitle {
  lines: string[];
  truncated: boolean;
}

/**
 * Plan the whole cell: how many events to draw, at what size, with how many
 * title lines each, and how many are left over. Always returns a plan — a cell
 * too small for even one chip still gets one (clipped) chip rather than a blank
 * day, matching the pre-existing "the first event always draws" behavior.
 */
export function planCell(items: CellItem[], input: CellLayoutInput): CellPlan {
  if (items.length === 0) {
    return {
      style: styleFor(input.baseFontSize, TIERS[0]),
      blocks: [],
      hidden: 0,
      overflowGap: OVERFLOW_GAP,
      overflowSize: input.baseFontSize - 0.5,
      tier: 0,
    };
  }

  const candidates: CellPlan[] = [];
  for (let i = 0; i < TIERS.length; i++) {
    const plan = planAtTier(items, input, TIERS[i], i);
    if (plan) candidates.push(plan);
  }
  if (candidates.length === 0) return forcedSinglePlan(items, input);

  // 1. Showing more events always wins.
  const bestShown = Math.max(...candidates.map((c) => c.blocks.length));
  const shownBest = candidates.filter((c) => c.blocks.length === bestShown);
  // 2. Never shrink the type unless the smaller type is what bought that count.
  const biggestFont = Math.max(...shownBest.map((c) => c.style.fontSize));
  const pool = shownBest.filter((c) => c.style.fontSize === biggestFont);
  // 3. Among equals: fewest clipped titles, then the most title lines drawn,
  //    then the earliest (airiest) tier — Array#sort is stable, so ties keep
  //    tier order.
  pool.sort((a, b) => clipped(a) - clipped(b) || totalLines(b) - totalLines(a));
  return pool[0];
}

function clipped(plan: CellPlan): number {
  return plan.blocks.filter((b) => b.truncated).length;
}

function totalLines(plan: CellPlan): number {
  return plan.blocks.reduce((n, b) => n + b.lines.length, 0);
}

function styleFor(baseFontSize: number, tier: Tier): CellStyle {
  const fontSize = Math.max(MIN_FONT_SIZE, baseFontSize + tier.sizeDelta);
  return { fontSize, lineH: fontSize + LINE_LEADING, vPad: tier.vPad, gap: tier.gap };
}

/**
 * Best plan at one density tier, or null if not even a single chip fits there.
 */
function planAtTier(
  items: CellItem[],
  input: CellLayoutInput,
  tier: Tier,
  tierIndex: number,
): CellPlan | null {
  const style = styleFor(input.baseFontSize, tier);
  const budget = input.height + FIT_EPSILON;
  const oneLineH = 2 * style.vPad + style.lineH;
  const overflowH = OVERFLOW_GAP + style.fontSize;

  // How many events fit at one line each (reserving the "+N más" line when we
  // already know some won't make it)?
  let shown = items.length;
  while (shown > 0) {
    const need =
      shown * oneLineH +
      (shown - 1) * style.gap +
      (shown < items.length ? overflowH : 0);
    if (need <= budget) break;
    shown--;
  }
  if (shown === 0) return null;

  const drawn = items.slice(0, shown);
  const timeWidths = drawn.map((it) => input.measurer.boldWidth(`${it.time} `, style.fontSize));
  const restW = Math.max(1, input.innerWidth);
  const firstW = timeWidths.map((w) => Math.max(1, input.innerWidth - w));
  let wrapped = drawn.map((it, i) =>
    wrapTitle(input.measurer, style.fontSize, it.title, firstW[i], restW, 1),
  );

  // Hand the leftover height back out as extra title lines, one pass per line:
  // every clipped title gets its 2nd line before any gets a 3rd.
  const used =
    shown * oneLineH + (shown - 1) * style.gap + (shown < items.length ? overflowH : 0);
  let slack = budget - used;
  const maxLines = Math.min(MAX_LINES, tier.maxLines);
  for (let cap = 2; cap <= maxLines; cap++) {
    for (let i = 0; i < shown && slack >= style.lineH; i++) {
      if (!wrapped[i].truncated) continue;
      const grown = wrapTitle(input.measurer, style.fontSize, drawn[i].title, firstW[i], restW, cap);
      const extra = grown.lines.length - wrapped[i].lines.length;
      if (extra <= 0 || extra * style.lineH > slack) continue;
      slack -= extra * style.lineH;
      wrapped[i] = grown;
    }
  }

  const blocks: CellBlock[] = drawn.map((it, i) => ({
    time: it.time,
    timeWidth: timeWidths[i],
    lines: wrapped[i].lines,
    height: 2 * style.vPad + Math.max(1, wrapped[i].lines.length) * style.lineH,
    truncated: wrapped[i].truncated,
  }));

  return {
    style,
    blocks,
    hidden: items.length - shown,
    overflowGap: OVERFLOW_GAP,
    overflowSize: style.fontSize - 0.5,
    tier: tierIndex,
  };
}

/**
 * Degenerate fallback: a cell so short that no tier fits a chip still shows the
 * day's first event (clipped to one line at the tightest tier) instead of
 * rendering an empty day.
 */
function forcedSinglePlan(items: CellItem[], input: CellLayoutInput): CellPlan {
  const tier = TIERS[TIERS.length - 1];
  const style = styleFor(input.baseFontSize, tier);
  const timeWidth = input.measurer.boldWidth(`${items[0].time} `, style.fontSize);
  const wrapped = wrapTitle(
    input.measurer,
    style.fontSize,
    items[0].title,
    Math.max(1, input.innerWidth - timeWidth),
    Math.max(1, input.innerWidth),
    1,
  );
  return {
    style,
    blocks: [
      {
        time: items[0].time,
        timeWidth,
        lines: wrapped.lines,
        height: 2 * style.vPad + style.lineH,
        truncated: wrapped.truncated,
      },
    ],
    hidden: items.length - 1,
    overflowGap: OVERFLOW_GAP,
    overflowSize: style.fontSize - 0.5,
    tier: TIERS.length - 1,
  };
}

/**
 * Word-wrap a title into at most `maxLines` lines. Line 0 has `firstWidth`
 * available (it shares its row with the bold time); later lines use
 * `restWidth`. A title that doesn't fit is cut with an ellipsis and reported as
 * `truncated`, which is what drives the extra-line passes above.
 */
export function wrapTitle(
  measurer: TextMeasurer,
  size: number,
  title: string,
  firstWidth: number,
  restWidth: number,
  maxLines: number,
): WrappedTitle {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [], truncated: false };
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    const width = Math.max(1, lines.length === 0 ? firstWidth : restWidth);
    let line = '';
    while (i < words.length) {
      const trial = line ? `${line} ${words[i]}` : words[i];
      if (measurer.width(trial, size) <= width) {
        line = trial;
        i++;
      } else if (!line) {
        // A single word too wide even for an empty line → hard-cut it.
        line = hardTruncate(measurer, size, words[i], width);
        i++;
        break;
      } else {
        break;
      }
    }
    lines.push(line);
  }
  const truncated = i < words.length;
  if (truncated && lines.length > 0) {
    const last = lines.length - 1;
    const width = Math.max(1, last === 0 ? firstWidth : restWidth);
    lines[last] = withEllipsis(measurer, size, lines[last], width);
  }
  return { lines, truncated };
}

/** Longest prefix of a single (unbreakable) word + "..." that fits `width`. */
function hardTruncate(measurer: TextMeasurer, size: number, word: string, width: number): string {
  if (width <= 0) return '';
  if (measurer.width(word, size) <= width) return word;
  const ell = '...';
  let t = word;
  while (t.length && measurer.width(t + ell, size) > width) t = t.slice(0, -1);
  return t ? t + ell : '';
}

/** Append "..." to a line, dropping trailing chars until it fits `width`. */
function withEllipsis(measurer: TextMeasurer, size: number, text: string, width: number): string {
  const ell = '...';
  if (measurer.width(text + ell, size) <= width) return text + ell;
  let t = text;
  while (t.length && measurer.width(t + ell, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}${ell}`;
}
