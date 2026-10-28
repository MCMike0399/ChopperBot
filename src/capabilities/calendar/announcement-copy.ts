import { normalizeTitle } from './match.js';

export const ANNOUNCEMENT_FACT_RULES = `El tono puede ser cálido; las instrucciones al público son hechos del evento.
No agregues materiales que traer, preparación, tareas, poemas/cuentos propios, turnos para leer ni micrófono o participación abierta si los datos del evento o la solicitud real del moderador no lo dicen.
"Círculo de lectura" o "historias de terror" NO significan que cada asistente deba llevar un texto o compartirlo. Invitar a asistir ("caiganle", "ahí nos vemos") sí está permitido. Los ejemplos de estilo no aportan hechos sobre este evento.`;

const DIRECTIVE = /\b(trae|traigan|traer|lleva|lleven|llevar|prepara|preparen|preparar|desempolva|desempolven|comparte|compartan|compartir|recita|reciten|recitar|lee|lean|leer)\b(.{0,160})/g;
const OBJECT = /\b(cuentos?|poemas?|relatos?|versos?|textos?|libros?|libretas?|cuadernos?|materiales?|computadoras?|laptops?|audifonos?|disfraces?|tareas?)\b/g;
const OPEN_FORMAT = /\b(microfono abierto|participacion abierta|lectura de textos propios)\b/g;

function directives(source: string) {
  return source.split(/[.!?\n;:]+/u).flatMap((sentence) => {
    const normalized = normalizeTitle(sentence);
    return [...normalized.matchAll(DIRECTIVE)].map((m) => ({
      phrase: m[0], action: /^(tra|llev|prepar|desempolv)/.test(m[1]!) ? 'bring' : 'share',
      objects: [...m[2]!.matchAll(OBJECT)].map(([word]) => word.replace(/ces$/, 'z').replace(/es$|s$/g, '')),
      personal: /\b(tu|tus|su|sus|propio|propios|propias|cada|ustedes)\b/.test(m[2]!),
      negated: /\b(no|nunca|prohibido)\b/.test(normalized.slice(0, m.index)),
    }));
  });
}

/** A bounded guard for concrete audience requirements, not a general fact checker. */
export function unsupportedParticipation(text: string, facts: readonly string[]): string[] {
  const known = facts.flatMap(directives).filter((d) => !d.negated);
  const unsupported = directives(text).filter((d) => (d.action === 'bring' || (d.personal && d.objects.length)) && !known.some((k) => k.action === d.action &&
    (d.objects.length ? d.objects.every((o) => k.objects.includes(o)) : k.phrase === d.phrase)))
    .map((d) => d.phrase);
  const normalizedFacts = facts.flatMap((fact) => fact.split(/[.!?\n;:]+/u)).map(normalizeTitle)
    .filter((sentence) => !/\b(no|nunca|prohibido)\b/.test(sentence)).join('\n');
  for (const [phrase] of normalizeTitle(text).matchAll(OPEN_FORMAT)) {
    if (!normalizedFacts.includes(phrase)) unsupported.push(phrase);
  }
  return unsupported;
}
