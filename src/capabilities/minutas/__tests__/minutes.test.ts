import { describe, test, expect } from 'vitest';
import {
  BLOCK_MAX_CHARS,
  buildMinutesSystemPrompt,
  renderMinutesPost,
  splitTranscriptIntoBlocks,
  type MinutesMeta,
} from '../minutes.js';
import { SPANISH_VOICE_RULES } from '../../../lang/voice.js';

const META: MinutesMeta = {
  title: 'Asamblea de prueba',
  channelName: '🔊 Ágora 🔊',
  dateLabel: '16 de agosto de 2026',
  durationLabel: '47 min',
  participants: ['Ana', 'Beto'],
};

describe('splitTranscriptIntoBlocks', () => {
  test('keeps short drafts in one block', () => {
    expect(splitTranscriptIntoBlocks('[00:00] Ana: hola')).toEqual(['[00:00] Ana: hola']);
  });

  test('splits on line boundaries, never mid-line', () => {
    const line = `[00:00] Ana: ${'x'.repeat(1000)}`;
    const text = Array.from({ length: 100 }, () => line).join('\n');
    const blocks = splitTranscriptIntoBlocks(text, 10_000);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(10_000 + 1);
      for (const l of b.split('\n')) expect(l.startsWith('[00:00] Ana:')).toBe(true);
    }
    expect(blocks.join('\n')).toBe(text);
  });

  test('a single line longer than the cap stays intact (never cut)', () => {
    const huge = `[00:00] Ana: ${'y'.repeat(BLOCK_MAX_CHARS * 2)}`;
    const blocks = splitTranscriptIntoBlocks(huge);
    expect(blocks).toEqual([huge]);
  });
});

describe('buildMinutesSystemPrompt', () => {
  test('carries the Spanish voice contract verbatim', () => {
    expect(buildMinutesSystemPrompt()).toContain(SPANISH_VOICE_RULES);
  });

  test('forbids inventing speakers and demands the minutes sections', () => {
    const p = buildMinutesSystemPrompt();
    expect(p).toContain('## Resumen');
    expect(p).toContain('## Acuerdos y decisiones');
    expect(p).toContain('## Compromisos');
    expect(p).toMatch(/Nunca inventes/i);
  });

  test('demands filtering greeting/filler chat lines out of the acta', () => {
    // Regression: the 2026-08-16 minute faithfully recorded "hola", "oki" and
    // "olo" as chat commentary. The prompt must order per-line filtering, not
    // just section omission when ALL chat is greetings.
    const p = buildMinutesSystemPrompt();
    expect(p).toMatch(/DESCARTA/);
    expect(p).toContain('«hola»');
    expect(p).toContain('«oki»');
    expect(p).toMatch(/omite la sección entera/);
  });
});

describe('renderMinutesPost', () => {
  test('header carries title, channel, date, duration and participants', () => {
    const post = renderMinutesPost('## Resumen\nCuerpo.', META);
    expect(post).toContain('# 📜 Minuta — Asamblea de prueba');
    expect(post).toContain('🔊 Ágora 🔊');
    expect(post).toContain('16 de agosto de 2026');
    expect(post).toContain('47 min');
    expect(post).toContain('Ana, Beto');
    expect(post.trimEnd().endsWith('Cuerpo.')).toBe(true);
  });
});
