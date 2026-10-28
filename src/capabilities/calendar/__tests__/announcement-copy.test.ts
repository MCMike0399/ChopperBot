import { describe, test, expect } from 'vitest';
import { unsupportedParticipation } from '../announcement-copy.js';

describe('audience instructions need event or moderator evidence', () => {
  test.each(['Trae tu cuento o poema de terror favorito para compartirlo.', 'Lleven sus libretas.',
    'Preparen un relato para la sesión.', 'Comparte tus poemas con la banda.', 'Hay micrófono abierto.', 'La participación abierta es para todxs.'])('%s is not implied by a reading circle', text => {
    expect(unsupportedParticipation(text, ['Círculo de lectura: Historias de terror'])).not.toHaveLength(0);
  });
  test.each(['Caiganle, ahí nos vemos. Lxs tqm.', 'Hoy leeremos historias de terror en Sala de Lectura.',
    'Nos vemos para leer y conversar sobre el libro.'])('keeps warm invitations: %s', text => {
    expect(unsupportedParticipation(text, [])).toEqual([]);
  });
  test('explicit instructions allow the same materials, but not additional ones', () => {
    expect(unsupportedParticipation('Trae tu poema favorito.', ['Traigan poemas para compartir.'])).toEqual([]);
    expect(unsupportedParticipation('Trae tu cuento o poema favorito.', ['Traigan poemas.'])).not.toHaveLength(0);
  });
  test('a prohibition does not authorize a positive contribution instruction', () => {
    expect(unsupportedParticipation('Trae tu poema favorito.', ['No les pidas que traigan poemas.'])).not.toHaveLength(0);
    expect(unsupportedParticipation('Hay micrófono abierto.', ['No hay micrófono abierto.'])).not.toHaveLength(0);
  });
});
