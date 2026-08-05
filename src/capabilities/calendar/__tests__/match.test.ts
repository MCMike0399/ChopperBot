import { describe, test, expect } from 'vitest';
import {
  candidatesFor,
  matchVerdict,
  normalizeTitle,
  parseMatchReply,
  titleSimilarity,
  type MatchableDiscordEvent,
  type MatchableOccurrence,
} from '../match.js';

/** 8:00 PM CDMX on 2026-08-05 (UTC-6 fixed). */
const AUG5_8PM = Date.UTC(2026, 7, 6, 2, 0, 0);

function occ(over: Partial<MatchableOccurrence> = {}): MatchableOccurrence {
  return {
    id: 21,
    title: 'Rosario Castellanos | Club de poesía',
    description: null,
    location: null,
    startAtMs: AUG5_8PM,
    ...over,
  };
}

function de(over: Partial<MatchableDiscordEvent> = {}): MatchableDiscordEvent {
  return { id: 'D1', name: 'Club de poesía abierto', description: null, startAtMs: AUG5_8PM, ...over };
}

describe('normalizeTitle', () => {
  test('folds accents, case, punctuation and emoji', () => {
    expect(normalizeTitle('Círculo de Lectura: ¡Raíz que no Desaparece!')).toBe(
      'circulo de lectura raiz que no desaparece',
    );
    expect(normalizeTitle('🫀 Sala de Club de Poesía 🫀')).toBe('sala de club de poesia');
  });
});

describe('titleSimilarity', () => {
  test('is symmetric', () => {
    const a = 'Club de poesía abierto';
    const b = 'Rosario Castellanos | Club de poesía';
    expect(titleSimilarity(a, b)).toBeCloseTo(titleSimilarity(b, a));
  });

  test('rates a real admin rewording as a strong match', () => {
    // The exact live pair: the calendar names the poet, Discord names the club.
    expect(titleSimilarity('Rosario Castellanos | Club de poesía', 'Club de poesía abierto')).toBeGreaterThan(0.4);
  });

  test('rewards the shorter title being fully contained in the longer', () => {
    expect(
      titleSimilarity('Círculo de Lectura: Raíz que no desaparece de Alma Delia', 'Raíz que no Desaparece'),
    ).toBeGreaterThanOrEqual(0.75);
  });

  test('does not confuse two different clubs that share only structure words', () => {
    // "club" survives stopword filtering, so this is not zero — but it must stay
    // well below the auto-match bar, which is the property that matters.
    expect(titleSimilarity('Club de Cine: Soul', 'Club de Poesía abierto')).toBeLessThan(0.4);
  });
});

describe('candidatesFor', () => {
  test('drops events outside the time window entirely', () => {
    const far = de({ id: 'FAR', startAtMs: AUG5_8PM + 3 * 86_400_000 });
    expect(candidatesFor(occ(), [far])).toEqual([]);
  });

  test('ranks the same-time same-topic event first', () => {
    const cands = candidatesFor(occ(), [
      de({ id: 'CINE', name: 'CineClub: I, Daniel Blake' }),
      de({ id: 'POESIA', name: 'Club de poesía abierto' }),
    ]);
    expect(cands[0]!.discordEventId).toBe('POESIA');
  });

  test('reads a title echoed in the description', () => {
    const [c] = candidatesFor(occ(), [
      de({ id: 'D9', name: 'Sesión de hoy', description: 'Club de poesía con Rosario Castellanos' }),
    ]);
    expect(c!.titleScore).toBeGreaterThan(0.3);
  });
});

describe('matchVerdict', () => {
  test('auto-matches a clear single candidate', () => {
    const v = matchVerdict(candidatesFor(occ(), [de({ name: 'Club de poesía: Rosario Castellanos' })]));
    expect(v.kind).toBe('matched');
  });

  test('escalates when nothing shares the topic — time alone must not carry it', () => {
    // A cine event at the same hour: exactly the case where linking on time
    // would send the community to the wrong room.
    const v = matchVerdict(candidatesFor(occ(), [de({ id: 'CINE', name: 'CineClub: I, Daniel Blake (2016)' })]));
    expect(v.kind).toBe('ambiguous');
  });

  test('escalates when two candidates score alike', () => {
    const v = matchVerdict(
      candidatesFor(occ(), [
        de({ id: 'A', name: 'Club de poesía: Rosario Castellanos' }),
        de({ id: 'B', name: 'Club de poesía Rosario Castellanos (repetido)' }),
      ]),
    );
    expect(v.kind).toBe('ambiguous');
  });

  test('reports none when there is nothing in the window', () => {
    expect(matchVerdict([]).kind).toBe('none');
  });
});

describe('parseMatchReply', () => {
  const allowed = ['D1', 'D2'];

  test('accepts a plain JSON pick', () => {
    expect(parseMatchReply('{"discord_event_id":"D2","reason":"mismo club"}', allowed)).toEqual({
      discordEventId: 'D2',
      reason: 'mismo club',
    });
  });

  test('accepts a fenced reply with prose around it', () => {
    const reply = 'Creo que es el segundo:\n```json\n{"discord_event_id": "D2", "reason": "x"}\n```\nlisto';
    expect(parseMatchReply(reply, allowed).discordEventId).toBe('D2');
  });

  test('treats real JSON null as no match', () => {
    expect(parseMatchReply('{"discord_event_id":null,"reason":"ninguno"}', allowed).discordEventId).toBeNull();
  });

  test('treats the STRING "null" as no match (the Nova-style failure)', () => {
    // The IG classifier was burned by exactly this: a model emitting "null" as a
    // string, which a naive parser keeps and downstream code renders literally.
    for (const token of ['"null"', '"none"', '"N/A"', '"ninguno"', '""']) {
      expect(
        parseMatchReply(`{"discord_event_id":${token},"reason":"x"}`, allowed).discordEventId,
      ).toBeNull();
    }
  });

  test('rejects an id that was not on the candidate list', () => {
    const out = parseMatchReply('{"discord_event_id":"999999","reason":"x"}', allowed);
    expect(out.discordEventId).toBeNull();
    expect(out.reason).toMatch(/fuera de la lista/);
  });

  test('returns no match on unparseable output instead of throwing', () => {
    expect(parseMatchReply('no tengo idea', allowed).discordEventId).toBeNull();
  });
});
