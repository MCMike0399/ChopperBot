import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  renderMonthPdf,
  hasTemplateFor,
  availableMonthKeys,
  monthsWithOccurrences,
  sanitizeForPdf,
  type RenderEvent,
} from '../render.js';

const tpl = (file: string) => new Uint8Array(readFileSync(resolve('calendar', file)));

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

  test('does not throw on emoji / very long titles / a crowded day', async () => {
    const sameDay = Date.parse('2026-06-17T17:00:00Z');
    const events: RenderEvent[] = Array.from({ length: 8 }, (_, i) =>
      ev({ id: i + 1, title: `🔥 Evento larguísimo número ${i} con un título que no cabe en la celda`, start_at: sameDay + i * 3_600_000 }),
    );
    const out = await renderMonthPdf({ monthKey: '2026-06', events, templateBytes: tpl('Junio 2026.pdf') });
    expect(out.byteLength).toBeGreaterThan(0);
  });
});
