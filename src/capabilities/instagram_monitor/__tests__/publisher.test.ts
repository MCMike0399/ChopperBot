import { describe, test, expect } from 'vitest';
import { renderText } from '../publisher.js';
import type { Classification } from '../classifier.js';
import type { RecentPost } from '../fetcher.js';

const POST: RecentPost = {
  igPostId: '123_456',
  shortcode: 'ABC123',
  caption: 'irrelevant — the card is built from the classification',
  takenAtMs: Date.UTC(2026, 4, 27, 21, 37, 0), // 27 may 2026, 15:37 CDMX
  mediaType: 'image',
  displayUrl: 'https://example.com/cover.jpg',
};

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    relevant: true,
    type: 'acuerpamiento',
    title: 'Acuerpamiento urgente para protesta de trabajadores sexuales en Parque Elevado',
    summary: 'Trabajadores sexuales realizan un cierre en el Parque Elevado de CDMX.',
    when: '2026-05-27',
    where: 'Parque Elevado, CDMX',
    tags: ['trabajo sexual', 'cdmx'],
    ...overrides,
  };
}

describe('renderText', () => {
  test('bolds the location ("Dónde") value', () => {
    const text = renderText('yoxlas40horas', POST, classification());
    expect(text).toContain('Dónde: **Parque Elevado, CDMX**');
  });

  test('bolds the time ("Cuándo") value', () => {
    const text = renderText('yoxlas40horas', POST, classification());
    expect(text).toContain('Cuándo: **miércoles 27 de mayo**');
  });

  test('omits the "Dónde" field entirely when no location is stated', () => {
    const text = renderText('yoxlas40horas', POST, classification({ where: null }));
    expect(text).not.toContain('Dónde:');
  });
});
