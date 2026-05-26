import { describe, test, expect } from 'vitest';
import {
  chunkMessage,
  chunkBotReply,
  stripContinuationFooter,
  CONTINUATION_FOOTER,
} from '../chunk.js';

describe('chunkMessage', () => {
  test('returns the message unchanged when within the limit', () => {
    expect(chunkMessage('hello')).toEqual(['hello']);
    expect(chunkMessage('a'.repeat(2000))).toHaveLength(1);
  });

  test('splits on line boundaries when too long', () => {
    const text = ['line one', 'line two', 'line three'].join('\n');
    const chunks = chunkMessage(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12 + 5);
  });

  test('preserves an open code fence across a chunk boundary', () => {
    const text = '```python\n' + 'print("a")\n'.repeat(50) + '```';
    const chunks = chunkMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk except the first opens with the same fence,
    // every chunk except the last closes with ```.
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) expect(chunks[i].startsWith('```python')).toBe(true);
      if (i < chunks.length - 1) expect(chunks[i].trimEnd().endsWith('```')).toBe(true);
    }
  });

  test('handles plain text without fences', () => {
    const text = 'a\n'.repeat(2000);
    const chunks = chunkMessage(text, 1000);
    expect(chunks.join('\n')).toContain('a');
    expect(chunks.every((c) => !c.includes('```'))).toBe(true);
  });

  test('uses 2000 as default Discord limit', () => {
    const text = ('x'.repeat(50) + '\n').repeat(60); // 60 lines × 51 chars = 3060
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000 + 5);
  });
});

describe('chunkBotReply', () => {
  test('single-chunk reply passes through unchanged (no footer)', () => {
    expect(chunkBotReply('hello')).toEqual(['hello']);
    const oneChunk = 'a'.repeat(1500);
    const out = chunkBotReply(oneChunk);
    expect(out).toEqual([oneChunk]);
    expect(out[0].endsWith(CONTINUATION_FOOTER)).toBe(false);
  });

  test('multi-chunk reply: every chunk except the last gets the footer', () => {
    const text = ('linea de prueba ' + 'x'.repeat(40) + '\n').repeat(80); // ~4.5K chars
    const out = chunkBotReply(text);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 0; i < out.length; i++) {
      const isLast = i === out.length - 1;
      if (isLast) {
        expect(out[i].endsWith(CONTINUATION_FOOTER)).toBe(false);
      } else {
        expect(out[i].endsWith(CONTINUATION_FOOTER)).toBe(true);
      }
    }
  });

  test('multi-chunk reply: every chunk (with footer) is within Discord limit', () => {
    const text = ('y'.repeat(80) + '\n').repeat(120); // ~9.7K chars
    const out = chunkBotReply(text);
    for (const c of out) {
      // 2000 hard cap; allow a tiny headroom buffer just in case of rounding.
      expect(c.length).toBeLessThanOrEqual(2000);
    }
  });

  test('content reaches the user when the footer is stripped', () => {
    const text = ('z'.repeat(60) + '\n').repeat(120);
    const chunks = chunkBotReply(text);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.map(stripContinuationFooter).join('\n');
    expect(reassembled.replace(/\s+/g, '').length).toBeGreaterThanOrEqual(
      text.replace(/\s+/g, '').length - 5,
    );
  });
});

describe('stripContinuationFooter', () => {
  test('removes the footer when present at end of message', () => {
    const body = 'some bot answer';
    expect(stripContinuationFooter(body + CONTINUATION_FOOTER)).toBe(body);
  });

  test('is a no-op when the footer is absent', () => {
    expect(stripContinuationFooter('plain message')).toBe('plain message');
  });

  test('only strips a trailing footer, not occurrences mid-content', () => {
    const middle = 'first part' + CONTINUATION_FOOTER + ' more text';
    expect(stripContinuationFooter(middle)).toBe(middle);
  });
});
