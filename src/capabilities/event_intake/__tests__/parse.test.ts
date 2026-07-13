import { describe, test, expect } from 'vitest';
import {
  collectPairs,
  parseTicketForm,
  isEventForm,
  extractRequesterId,
  type MessageLike,
} from '../parse.js';

const TICKET_BOT = '557628352828014614';
const REQUESTER = '187289179871248384';

// The EXACT embed description Ticket Tool posts (from ticket-0002): bold
// question, a space, then the answer in a ``` code fence.
const FORM_DESCRIPTION = [
  '**¿Cuál es el título o tema de tu círculo?** ```',
  'la limpieza étnica de palestina```',
  '**¿Qué día gustas realizarlo?** ```',
  'domingo```',
  '**¿A qué hora gustas realizarlo?** ```',
  '8pm```',
  '**Escribe el nombre del ponente(s)** ```',
  'Burbuja```',
  '**¿Quieres hacer tú el flyer/imagen del evento?** ```',
  'No```',
].join('\n');

function formMessage(over: Partial<MessageLike> = {}): MessageLike {
  return {
    authorId: TICKET_BOT,
    authorBot: true,
    content: `Bienvenidx <@${REQUESTER}> :D`,
    embeds: [
      { description: 'Nuestra comisión revisará tu formulario' },
      { description: FORM_DESCRIPTION },
    ],
    ...over,
  };
}

describe('parseTicketForm', () => {
  test('maps the real Ticket Tool form to fields', () => {
    const parsed = parseTicketForm(formMessage())!;
    expect(parsed.title).toBe('la limpieza étnica de palestina');
    expect(parsed.dayRaw).toBe('domingo');
    expect(parsed.timeRaw).toBe('8pm');
    expect(parsed.speaker).toBe('Burbuja');
    expect(parsed.flyerSelf).toBe(false); // "No" → the requester won't make it
    expect(parsed.pairs).toHaveLength(5);
  });

  test('flyer "Sí" → true', () => {
    const desc = ['**¿Título?** ```', 'X```', '**¿Harás el flyer?** ```', 'Sí```'].join('\n');
    const parsed = parseTicketForm(formMessage({ embeds: [{ description: desc }] }))!;
    expect(parsed.flyerSelf).toBe(true);
  });

  test('tolerates an embed-fields layout', () => {
    const pairs = collectPairs({
      fields: [
        { name: '¿Cuál es el tema?', value: '```\nTaller```' },
        { name: '¿A qué hora?', value: '5pm' },
      ],
    });
    expect(pairs).toEqual([
      { question: '¿Cuál es el tema?', answer: 'Taller' },
      { question: '¿A qué hora?', answer: '5pm' },
    ]);
  });

  test('returns null for a message with no form embed', () => {
    expect(parseTicketForm(formMessage({ embeds: [{ description: 'hola equipo' }] }))).toBeNull();
  });
});

describe('isEventForm', () => {
  test('true for the ticket bot form', () => {
    expect(isEventForm(formMessage(), TICKET_BOT)).toBe(true);
  });

  test('false when authored by someone else (even with the same embed)', () => {
    expect(isEventForm(formMessage({ authorId: '999' }), TICKET_BOT)).toBe(false);
  });

  test('false for a normal chat message', () => {
    const chat: MessageLike = { authorId: '42', authorBot: false, content: 'hola', embeds: [] };
    expect(isEventForm(chat, TICKET_BOT)).toBe(false);
  });

  test('false for a NON-event ticket form (report/support) — the guardrail', () => {
    // A report form has questions but no día/hora → must not be treated as an event.
    const report = [
      '**¿Qué deseas reportar?** ```',
      'acoso en el chat```',
      '**¿Contra quién?** ```',
      'usuario X```',
    ].join('\n');
    expect(isEventForm(formMessage({ embeds: [{ description: report }] }), TICKET_BOT)).toBe(false);

    // Even a report that happens to have a "título" but no scheduling fields.
    const titledReport = ['**Título del reporte** ```', 'spam```', '**Detalle** ```', 'X```'].join('\n');
    expect(isEventForm(formMessage({ embeds: [{ description: titledReport }] }), TICKET_BOT)).toBe(false);
  });
});

describe('extractRequesterId', () => {
  test('reads the first non-excluded mention from the welcome content', () => {
    expect(extractRequesterId(`Bienvenidx <@${REQUESTER}> :D`, [TICKET_BOT])).toBe(REQUESTER);
  });

  test('skips excluded ids (the bots)', () => {
    expect(extractRequesterId(`<@${TICKET_BOT}> abrió el ticket para <@${REQUESTER}>`, [TICKET_BOT])).toBe(
      REQUESTER,
    );
  });

  test('null when there is no mention', () => {
    expect(extractRequesterId('sin menciones', [])).toBeNull();
  });
});
