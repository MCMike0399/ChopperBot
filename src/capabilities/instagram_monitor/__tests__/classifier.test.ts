import { describe, test, expect } from 'vitest';
import { parseClassificationReply } from '../classifier.js';

describe('parseClassificationReply', () => {
  test('parses a clean JSON object', () => {
    const raw = JSON.stringify({
      relevant: true,
      type: 'evento',
      title: 'Marcha 8M',
      summary: 'Marcha en CDMX',
      when: '2026-03-08T18:00:00-06:00',
      where: 'CDMX',
      tags: ['cdmx', 'feminismo'],
    });
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.relevant).toBe(true);
    expect(c!.type).toBe('evento');
    expect(c!.title).toBe('Marcha 8M');
    expect(c!.tags).toEqual(['cdmx', 'feminismo']);
  });

  test('strips ```json fences', () => {
    const raw = '```json\n{"relevant":false,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":[]}\n```';
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.relevant).toBe(false);
  });

  test('tolerates leading prose before the JSON object', () => {
    const raw =
      'Aquí está el resultado:\n{"relevant":true,"type":"alerta","title":"X","summary":"y","when":null,"where":"CDMX","tags":["x"]}';
    const c = parseClassificationReply(raw);
    expect(c).not.toBeNull();
    expect(c!.type).toBe('alerta');
    expect(c!.where).toBe('CDMX');
  });

  test('coerces unknown type to "otro"', () => {
    const raw = '{"relevant":true,"type":"weird","title":"x","summary":"y","when":null,"where":null,"tags":[]}';
    const c = parseClassificationReply(raw);
    expect(c!.type).toBe('otro');
  });

  test('clamps tags to 5 strings, drops non-strings', () => {
    const raw =
      '{"relevant":true,"type":"otro","title":"","summary":"","when":null,"where":null,"tags":["a","b",3,"c","d","e","f"]}';
    const c = parseClassificationReply(raw);
    expect(c!.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('returns null on garbage text', () => {
    expect(parseClassificationReply('lol no json here')).toBeNull();
    expect(parseClassificationReply('')).toBeNull();
  });

  test('returns null on unbalanced braces', () => {
    expect(parseClassificationReply('{ "relevant": true ')).toBeNull();
  });
});
