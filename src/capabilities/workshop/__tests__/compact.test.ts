import { describe, test, expect } from 'vitest';
import { shouldCompact, COMPACT_MIN_OLD_TURNS, COMPACT_MIN_OLD_CHARS } from '../compact.js';
import type { Turn } from '../../../discord/history.js';

const turn = (content: string): Turn => ({ role: 'user', content });

describe('shouldCompact', () => {
  test('empty overflow never compacts', () => {
    expect(shouldCompact([])).toBe(false);
  });

  test('compacts from the turn-count threshold', () => {
    const few = Array.from({ length: COMPACT_MIN_OLD_TURNS - 1 }, () => turn('corto'));
    expect(shouldCompact(few)).toBe(false);
    expect(shouldCompact([...few, turn('uno más')])).toBe(true);
  });

  test('compacts from the char threshold even with few turns', () => {
    expect(shouldCompact([turn('x'.repeat(COMPACT_MIN_OLD_CHARS))])).toBe(true);
    expect(shouldCompact([turn('x'.repeat(100))])).toBe(false);
  });
});
