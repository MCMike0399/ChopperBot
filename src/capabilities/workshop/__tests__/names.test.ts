import { describe, test, expect } from 'vitest';
import { channelNameFor, sanitizeFileName } from '../watcher.js';

describe('channelNameFor', () => {
  test('lowercases, strips accents/symbols, prefixes taller-', () => {
    expect(channelNameFor('Miguel Ángel', 1)).toBe('taller-miguel-angel');
    expect(channelNameFor('user#1234', 1)).toBe('taller-user-1234');
    expect(channelNameFor('ñoño!!', 1)).toBe('taller-nono');
  });

  test('numbers additional sessions', () => {
    expect(channelNameFor('ana', 2)).toBe('taller-ana-2');
  });

  test('degenerate names fall back to sesion', () => {
    expect(channelNameFor('!!!', 1)).toBe('taller-sesion');
  });
});

describe('sanitizeFileName', () => {
  test('keeps simple names, flattens weird chars, blocks dot-prefixes', () => {
    expect(sanitizeFileName('datos.csv')).toBe('datos.csv');
    expect(sanitizeFileName('mi archivo (1).xlsx')).toBe('mi_archivo_1_.xlsx');
    expect(sanitizeFileName('../../etc/passwd')).toBe('__.._etc_passwd');
    expect(sanitizeFileName('.bashrc')).toBe('_bashrc');
    expect(sanitizeFileName('')).toBe('archivo');
  });
});
