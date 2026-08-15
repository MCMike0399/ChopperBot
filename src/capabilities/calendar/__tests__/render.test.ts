import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  renderMonthPdf,
  helveticaMeasurer,
  hasTemplateFor,
  availableMonthKeys,
  monthsWithOccurrences,
  sanitizeForPdf,
  type RenderEvent,
} from '../render.js';
import { cellBox } from '../template-geometry.js';
import { TEMPLATE_GEOMETRY } from '../template-geometry.generated.js';
import { planCell } from '../cell-layout.js';

const tpl = (file: string) => new Uint8Array(readFileSync(resolve('calendar', file)));

/** Every Canva template's MediaBox is [0, 7.92, 1440, 817.92]. */
const MEDIA_BOX_ORIGIN_Y = 7.92;

function ev(overrides: Partial<RenderEvent> = {}): RenderEvent {
  return {
    id: 1,
    title: 'Evento',
    start_at: Date.parse('2026-06-21T02:00:00Z'), // Sat Jun 20, 8pm CDMX
    end_at: null,
    recurrence_freq: null,
    recurrence_until: null,
    ...overrides,
  };
}

describe('template availability', () => {
  test('the seven 2026 templates are calibrated, others are not', () => {
    expect(availableMonthKeys()).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
    expect(hasTemplateFor('2026-06')).toBe(true);
    expect(hasTemplateFor('2026-05')).toBe(false);
    expect(hasTemplateFor('2027-01')).toBe(false);
  });
});

describe('monthsWithOccurrences', () => {
  test('a one-off only touches its own month', () => {
    expect(monthsWithOccurrences(ev(), availableMonthKeys())).toEqual(['2026-06']);
  });

  test('an open-ended weekly series touches every available month from its start', () => {
    const months = monthsWithOccurrences(
      ev({ recurrence_freq: 'weekly' }),
      availableMonthKeys(),
    );
    expect(months).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
    ]);
  });

  test('a bounded weekly series stops at recurrence_until', () => {
    const months = monthsWithOccurrences(
      ev({ recurrence_freq: 'weekly', recurrence_until: Date.parse('2026-07-15T02:00:00Z') }),
      availableMonthKeys(),
    );
    expect(months).toEqual(['2026-06', '2026-07']);
  });
});

describe('sanitizeForPdf', () => {
  test('keeps Spanish accents and ¿¡, drops emoji, normalizes punctuation', () => {
    expect(sanitizeForPdf('Asamblea: ¿vienes? ¡órale! niño café')).toBe(
      'Asamblea: ¿vienes? ¡órale! niño café',
    );
    expect(sanitizeForPdf('🔥 Fiesta 🏴 — “tardeada”')).toBe('Fiesta - "tardeada"');
    expect(sanitizeForPdf('a…b')).toBe('a...b');
    expect(sanitizeForPdf('  spaced   out  ')).toBe('spaced out');
  });
});

describe('cellBox', () => {
  test('every template page starts at a non-zero MediaBox origin', async () => {
    for (const key of availableMonthKeys()) {
      const doc = await PDFDocument.load(tpl(TEMPLATE_GEOMETRY[key].file));
      expect(doc.getPages()[0].getMediaBox().y).toBeCloseTo(MEDIA_BOX_ORIGIN_Y, 2);
    }
  });

  test('the cell lands between the printed week dividers (MediaBox origin applied)', () => {
    // Grid lines of the Agosto template, read off a 144-DPI raster of the page
    // in poppler bbox space: the week-of-Aug-10 band runs 420 → 499.5.
    const geom = TEMPLATE_GEOMETRY['2026-08'];
    const box = cellBox(geom, 2, 0, MEDIA_BOX_ORIGIN_Y)!;
    const topLine = MEDIA_BOX_ORIGIN_Y + geom.pageHeight - 420;
    const bottomLine = MEDIA_BOX_ORIGIN_Y + geom.pageHeight - 499.5;
    expect(box.top).toBeLessThanOrEqual(topLine);
    expect(box.bottom).toBeGreaterThanOrEqual(bottomLine);
    // Dropping the origin is exactly the old bug: the band fell 7.92 pt low and
    // a full cell's last chip crossed the divider into the next week.
    expect(cellBox(geom, 2, 0)!.bottom).toBeLessThan(bottomLine);
  });
});

describe('renderMonthPdf', () => {
  test('throws for a month without a template', async () => {
    await expect(
      renderMonthPdf({ monthKey: '2026-05', events: [], templateBytes: tpl('Junio 2026.pdf') }),
    ).rejects.toThrow(/No calendar template/);
  });

  test('produces a valid single-page PDF preserving the template page size', async () => {
    const out = await renderMonthPdf({
      monthKey: '2026-06',
      events: [
        ev({ id: 1, title: 'Asamblea constituyente' }),
        ev({ id: 2, title: 'Círculo semanal', start_at: Date.parse('2026-06-15T02:00:00Z'), recurrence_freq: 'weekly' }),
      ],
      templateBytes: tpl('Junio 2026.pdf'),
    });
    expect(Buffer.from(out.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPages()[0].getSize();
    expect(Math.round(width)).toBe(1440);
    expect(Math.round(height)).toBe(810);
  });

  test('a day with two events renders both, at the real geometry and font metrics', async () => {
    // The live 2026-08-10 pair, measured in the real Agosto cell (the tightest
    // grid there is) with the real Helvetica the renderer embeds.
    const doc = await PDFDocument.create();
    const measurer = helveticaMeasurer(
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
    const geom = TEMPLATE_GEOMETRY['2026-08'];
    const box = cellBox(geom, 2, 0, MEDIA_BOX_ORIGIN_Y)!; // week of Aug 10, Monday
    const plan = planCell(
      [
        { time: '3:00 PM', title: 'Circulo de Estudio: Burocracia (Primera sesión)' },
        { time: '8:30 PM', title: 'Repensar la burocracia: La utopía de las normas de David Graeber' },
      ],
      { innerWidth: box.width - 10, height: box.height, baseFontSize: 7, measurer },
    );
    expect(plan.blocks).toHaveLength(2);
    expect(plan.hidden).toBe(0);

    // …and the stack stays inside the printed cell.
    const stack =
      plan.blocks.reduce((h, b) => h + b.height, 0) + (plan.blocks.length - 1) * plan.style.gap;
    expect(box.top - stack).toBeGreaterThanOrEqual(box.bottom - 0.25);
  });

  test('does not throw on emoji / very long titles / a crowded day', async () => {
    const sameDay = Date.parse('2026-06-17T17:00:00Z');
    const events: RenderEvent[] = Array.from({ length: 8 }, (_, i) =>
      ev({ id: i + 1, title: `🔥 Evento larguísimo número ${i} con un título que no cabe en la celda`, start_at: sameDay + i * 3_600_000 }),
    );
    const out = await renderMonthPdf({ monthKey: '2026-06', events, templateBytes: tpl('Junio 2026.pdf') });
    expect(out.byteLength).toBeGreaterThan(0);
  });
});
