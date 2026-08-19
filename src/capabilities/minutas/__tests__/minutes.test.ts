import { describe, test, expect } from 'vitest';
import {
  BLOCK_MAX_CHARS,
  buildMinutesSystemPrompt,
  buildMinutesUserPrompt,
  renderMinutesPost,
  splitTranscriptIntoBlocks,
  stripMinutesChatSection,
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

  test('treats chat as unpublished context and forbids a chat section', () => {
    // 2026-08-18: the acta listed chat jokes («tomamos palacio nacional») as
    // record. Chat stays in the draft as 💬 context; it must not be a section.
    const p = buildMinutesSystemPrompt();
    expect(p).toMatch(/El chat NO se publica/);
    expect(p).toMatch(/Bromas, memes, hipérboles/);
    expect(p).not.toContain('## Comentarios del chat');
  });

  test('user prompt keeps chat in the draft as unpublished context', () => {
    const u = buildMinutesUserPrompt('[00:02] 💬 Carla (chat): jeje', META);
    expect(u).toContain('💬 Carla (chat): jeje');
    expect(u).toMatch(/no las copies al acta/);
  });
});

describe('stripMinutesChatSection', () => {
  test('drops a trailing Comentarios del chat section', () => {
    const body = [
      '## Resumen',
      'Nos organizamos.',
      '## Acuerdos y decisiones',
      'Seguir la asamblea.',
      '## Comentarios del chat',
      '- El 2do aniversario tomamos palacio nacional.',
    ].join('\n');
    const stripped = stripMinutesChatSection(body);
    expect(stripped).toContain('## Resumen');
    expect(stripped).toContain('## Acuerdos y decisiones');
    expect(stripped).not.toMatch(/Comentarios del chat/i);
    expect(stripped).not.toMatch(/palacio nacional/i);
  });

  test('drops a chat section sitting between other headings', () => {
    const body = [
      '## Resumen',
      'Ok.',
      '## Comentarios del chat',
      'jaja',
      '## Compromisos',
      'Sin compromisos.',
    ].join('\n');
    expect(stripMinutesChatSection(body)).toBe(
      '## Resumen\nOk.\n## Compromisos\nSin compromisos.',
    );
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
