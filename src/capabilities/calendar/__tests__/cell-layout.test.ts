import { describe, test, expect } from 'vitest';
import { planCell, wrapTitle, type CellItem, type CellPlan, type TextMeasurer } from '../cell-layout.js';

/**
 * Deterministic stand-in for Helvetica: every glyph is 0.5 em wide, bold 0.55.
 * Keeps the packing assertions about the ALGORITHM rather than about font
 * metrics (render.test.ts covers the planner against the real embedded font
 * and the real template geometry).
 */
const measurer: TextMeasurer = {
  width: (text, size) => text.length * size * 0.5,
  boldWidth: (text, size) => text.length * size * 0.55,
};

/** The real 6-row (Agosto/Noviembre) cell: ~41 pt of usable height. */
const TIGHT = { innerWidth: 163, height: 40.98, baseFontSize: 7, measurer };
/** The real 5-row (Junio…Diciembre) cell: ~57 pt, one type size larger. */
const ROOMY = { innerWidth: 163, height: 57.14, baseFontSize: 8, measurer };

function items(...titles: string[]): CellItem[] {
  return titles.map((title, i) => ({ time: `${3 + i}:00 PM`, title }));
}

/** Total vertical space a plan consumes, including the "+N más" line. */
function usedHeight(plan: CellPlan): number {
  const chips = plan.blocks.reduce((h, b) => h + b.height, 0);
  const gaps = Math.max(0, plan.blocks.length - 1) * plan.style.gap;
  const overflow = plan.hidden > 0 ? plan.overflowGap + plan.overflowSize : 0;
  return chips + gaps + overflow;
}

describe('planCell — fitting the day', () => {
  test('two events both render in a tight cell (the Aug 10 regression)', () => {
    // Live board 2026-08-10: a long first title greedily took two lines and
    // starved the second event by 0.02 pt, so the day showed "+1 más" with a
    // chip's worth of empty space under it.
    const plan = planCell(
      items('Circulo de Estudio: Burocracia (Primera sesión)', 'Repensar la burocracia: La utopía de las normas'),
      TIGHT,
    );
    expect(plan.blocks).toHaveLength(2);
    expect(plan.hidden).toBe(0);
    expect(usedHeight(plan)).toBeLessThanOrEqual(TIGHT.height + 0.25);
  });

  test('a lone event keeps the default type and gets the roomiest tier', () => {
    const plan = planCell(items('Asamblea'), TIGHT);
    expect(plan.tier).toBe(0);
    expect(plan.style.fontSize).toBe(7);
    expect(plan.blocks[0].lines).toEqual(['Asamblea']);
  });

  test('type never shrinks just to un-clip a title', () => {
    // A single very long title could always be spelled out at 5.5 pt — it must
    // not be, because shrinking buys no extra EVENT.
    const plan = planCell(
      items(
        'Donde viven tus datos, arquitectura de redes y aplicaciones para público no técnico y también técnico, ' +
          'con una sobremesa larga sobre soberanía tecnológica y cooperativismo digital en el sur global',
      ),
      TIGHT,
    );
    expect(plan.style.fontSize).toBe(7);
    expect(plan.blocks[0].truncated).toBe(true);
  });

  test('spare height goes back into title lines', () => {
    const one = planCell(items('Círculo de estudio sobre la utopía de las normas de David Graeber'), ROOMY);
    expect(one.blocks[0].lines.length).toBeGreaterThan(1);
    expect(usedHeight(one)).toBeLessThanOrEqual(ROOMY.height + 0.25);
  });

  test('extra lines are shared fairly — every clipped title gets a 2nd line before any gets a 3rd', () => {
    const long = 'Conversatorio sobre centros de datos y modelos de lenguaje en el sur global';
    const plan = planCell(items(long, long), ROOMY);
    expect(plan.blocks).toHaveLength(2);
    const [a, b] = plan.blocks.map((x) => x.lines.length);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(Math.min(a, b)).toBeGreaterThanOrEqual(2);
  });

  test('a denser tier is taken only when it shows more events', () => {
    const three = planCell(items('Taller de serigrafía', 'Comida colectiva', 'Cierre de jornada'), TIGHT);
    expect(three.blocks).toHaveLength(3);
    expect(three.hidden).toBe(0);
    expect(three.style.fontSize).toBeLessThan(7); // stepped down to fit the third
    expect(three.style.fontSize).toBeGreaterThanOrEqual(5.5);
    expect(usedHeight(three)).toBeLessThanOrEqual(TIGHT.height + 0.25);
  });

  test('the 5-row months fit more before shrinking anything', () => {
    const plan = planCell(items('Taller', 'Comida', 'Cierre'), ROOMY);
    expect(plan.blocks).toHaveLength(3);
    expect(plan.style.fontSize).toBe(8);
    expect(plan.hidden).toBe(0);
  });

  test('a genuinely full day overflows, and the "+N más" line is inside the cell', () => {
    const plan = planCell(items('A', 'B', 'C', 'D', 'E', 'F'), TIGHT);
    expect(plan.hidden).toBeGreaterThan(0);
    expect(plan.blocks.length + plan.hidden).toBe(6);
    expect(plan.blocks.length).toBeGreaterThanOrEqual(3); // still better than the old 1–2
    expect(usedHeight(plan)).toBeLessThanOrEqual(TIGHT.height + 0.25);
  });

  test('events are never silently dropped — blocks + hidden always equals the input', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 12]) {
      const list = items(...Array.from({ length: n }, (_, i) => `Evento número ${i} de la jornada`));
      for (const opts of [TIGHT, ROOMY]) {
        const plan = planCell(list, opts);
        expect(plan.blocks.length + plan.hidden).toBe(n);
        expect(plan.blocks.length).toBeGreaterThanOrEqual(1);
        expect(usedHeight(plan)).toBeLessThanOrEqual(opts.height + 0.25);
      }
    }
  });

  test('a cell too small for any chip still shows the first event', () => {
    const plan = planCell(items('Asamblea', 'Otra cosa'), { ...TIGHT, height: 4 });
    expect(plan.blocks).toHaveLength(1);
    expect(plan.hidden).toBe(1);
  });

  test('an empty day plans nothing', () => {
    const plan = planCell([], TIGHT);
    expect(plan.blocks).toEqual([]);
    expect(plan.hidden).toBe(0);
  });
});

describe('wrapTitle', () => {
  test('reports truncation and ellipsizes the last line', () => {
    const short = wrapTitle(measurer, 8, 'Asamblea', 100, 100, 2);
    expect(short).toEqual({ lines: ['Asamblea'], truncated: false });

    const long = wrapTitle(measurer, 8, 'Asamblea general ordinaria de la comunidad', 40, 40, 1);
    expect(long.truncated).toBe(true);
    expect(long.lines).toHaveLength(1);
    expect(long.lines[0].endsWith('...')).toBe(true);
  });

  test('a second line takes the full width, not the time-shortened one', () => {
    const w = wrapTitle(measurer, 8, 'palabra otra tercera cuarta', 20, 120, 2);
    expect(w.lines).toHaveLength(2);
    expect(w.lines[1].split(' ').length).toBeGreaterThan(1);
  });

  test('an unbreakable word is hard-cut instead of overflowing', () => {
    const w = wrapTitle(measurer, 8, 'Contrahegemonicoantiimperialista', 40, 40, 1);
    expect(measurer.width(w.lines[0], 8)).toBeLessThanOrEqual(40);
    expect(w.lines[0].endsWith('...')).toBe(true);
  });

  test('an empty title yields no lines', () => {
    expect(wrapTitle(measurer, 8, '   ', 100, 100, 3)).toEqual({ lines: [], truncated: false });
  });
});
