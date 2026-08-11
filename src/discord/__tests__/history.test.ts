import { describe, test, expect } from 'vitest';
import { normalizeTurns, type Turn } from '../history.js';
import { ImageAttachable } from '../../attachments/attachable.js';

describe('normalizeTurns', () => {
  test('folds a leading assistant turn into the first user turn as context', () => {
    const turns: Turn[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'a question' },
    ];
    const result = normalizeTurns(turns);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('> hi');
    expect(result[0].content.endsWith('a question')).toBe(true);
  });

  test('folds multiple leading assistant turns, in order', () => {
    const turns: Turn[] = [
      { role: 'assistant', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'question' },
    ];
    const result = normalizeTurns(turns);
    expect(result).toHaveLength(1);
    expect(result[0].content.indexOf('one')).toBeLessThan(result[0].content.indexOf('two'));
    expect(result[0].content.endsWith('question')).toBe(true);
  });

  test('a reply to a bot-initiated nudge keeps the event id the nudge named', () => {
    // The live 2026-08-10 failure: the mod replied to the calendar's "falta el
    // evento de Discord" nudge with "crea el evento" and the bot, having lost
    // the nudge, asked for a title and a date.
    const nudge = '📌 **Falta crear el evento de Discord** para lo que viene:\n- **#29 Conversatorio**';
    const result = normalizeTurns([
      { role: 'assistant', content: nudge },
      { role: 'user', content: 'crea el evento' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('#29');
    expect(result[0].content).toContain('crea el evento');
  });

  test('quotes every line of the folded context so the boundary is unambiguous', () => {
    const result = normalizeTurns([
      { role: 'assistant', content: 'line one\nline two' },
      { role: 'user', content: 'ok' },
    ]);
    expect(result[0].content).toContain('> line one\n> line two');
  });

  test('merges consecutive same-role turns', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply' },
    ];
    expect(normalizeTurns(turns)).toEqual([
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  test('preserves a clean alternating sequence', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    expect(normalizeTurns(turns)).toEqual(turns);
  });

  test('handles an empty input', () => {
    expect(normalizeTurns([])).toEqual([]);
  });

  test('returns empty if there are only assistant turns', () => {
    expect(normalizeTurns([{ role: 'assistant', content: 'orphan' }])).toEqual([]);
  });

  test('preserves attachments on non-merged turns', () => {
    const img = new ImageAttachable('test.png', 'image/png', new Uint8Array([1]), 'png');
    const turns: Turn[] = [
      { role: 'user', content: 'a', attachments: [img] },
      { role: 'assistant', content: 'b' },
    ];
    expect(normalizeTurns(turns)).toEqual([
      { role: 'user', content: 'a', attachments: [img] },
      { role: 'assistant', content: 'b' },
    ]);
  });

  test('merges attachments when merging same-role turns', () => {
    const img1 = new ImageAttachable('a.png', 'image/png', new Uint8Array([1]), 'png');
    const img2 = new ImageAttachable('b.png', 'image/png', new Uint8Array([2]), 'png');
    const turns: Turn[] = [
      { role: 'user', content: 'first', attachments: [img1] },
      { role: 'user', content: 'second', attachments: [img2] },
      { role: 'assistant', content: 'reply' },
    ];
    const result = normalizeTurns(turns);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('first\n\nsecond');
    expect(result[0].attachments).toHaveLength(2);
    expect(result[0].attachments![0]).toBe(img1);
    expect(result[0].attachments![1]).toBe(img2);
  });

  test('merges turns where only one has attachments', () => {
    const img = new ImageAttachable('a.png', 'image/png', new Uint8Array([1]), 'png');
    const turns: Turn[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second', attachments: [img] },
    ];
    const result = normalizeTurns(turns);
    expect(result).toHaveLength(1);
    expect(result[0].attachments).toHaveLength(1);
    expect(result[0].attachments![0]).toBe(img);
  });
});
