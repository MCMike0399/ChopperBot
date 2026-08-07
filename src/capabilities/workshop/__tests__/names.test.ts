import { describe, test, expect } from 'vitest';
import { attachmentNameMatches, channelNameFor, sanitizeFileName } from '../watcher.js';

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

  test('truncation never amputates the extension', () => {
    const long =
      'Federici, Silvia_Calibán y la bruja _ mujeres, cuerpo y acumulación primitiva(2011).pdf';
    const out = sanitizeFileName(long);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
    // A name with no extension truncates plainly.
    expect(sanitizeFileName('a'.repeat(100))).toBe('a'.repeat(80));
  });
});

describe('attachmentNameMatches', () => {
  const REL = 'uploads/Federici_Silvia_Caliban_primitiva2011.';

  test('exact basename match', () => {
    expect(attachmentNameMatches('Federici_Silvia_Caliban_primitiva2011.', REL)).toBe(true);
    expect(attachmentNameMatches('otro.pdf', REL)).toBe(false);
  });

  test('Discord strips trailing dots/spaces from attachment names', () => {
    // The carrier's name lost the trailing dot that the manifest kept.
    expect(attachmentNameMatches('Federici_Silvia_Caliban_primitiva2011', REL)).toBe(true);
    // …and the symmetric case (trailing dot only on the Discord side).
    expect(attachmentNameMatches('archivo.', 'uploads/archivo')).toBe(true);
  });

  test('sanitized equivalence still works', () => {
    expect(attachmentNameMatches('mi archivo (1).xlsx', 'uploads/mi_archivo_1_.xlsx')).toBe(true);
  });
});
