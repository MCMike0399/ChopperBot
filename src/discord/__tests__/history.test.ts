import { describe, test, expect } from 'vitest';
import { normalizeTurns, type Turn } from '../history.js';
import { ImageAttachable } from '../../attachments/attachable.js';

describe('normalizeTurns', () => {
  test('drops a leading assistant turn', () => {
    const turns: Turn[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'a question' },
    ];
    expect(normalizeTurns(turns)).toEqual([{ role: 'user', content: 'a question' }]);
  });

  test('drops multiple leading assistant turns', () => {
    const turns: Turn[] = [
      { role: 'assistant', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'question' },
    ];
    expect(normalizeTurns(turns)).toEqual([{ role: 'user', content: 'question' }]);
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
