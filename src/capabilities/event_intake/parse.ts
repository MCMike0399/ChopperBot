/**
 * Pure parsing of the Ticket Tool event-request form. No discord.js imports —
 * the watcher adapts a real `Message` into these minimal shapes so this stays
 * unit-testable. The form is delivered as an embed whose `.description` is a
 * run of `**<pregunta>** ```<respuesta>``` ` pairs (a `.fields` layout is also
 * tolerated in case a future ticket template uses embed fields).
 */

export interface EmbedLike {
  description?: string | null;
  fields?: Array<{ name: string; value: string }>;
}

export interface MessageLike {
  authorId: string | null;
  authorBot: boolean;
  content: string;
  embeds: EmbedLike[];
}

/** One raw question→answer pair as authored in the form. */
export interface FormPair {
  question: string;
  answer: string;
}

/** The parsed form: mapped known fields + every raw pair (for the prompt). */
export interface ParsedForm {
  title: string | null;
  dayRaw: string | null;
  timeRaw: string | null;
  speaker: string | null;
  /** true = the requester will make the flyer themselves; false = they won't; null = unknown. */
  flyerSelf: boolean | null;
  pairs: FormPair[];
}

/** Matches `**question** ```answer``` `, tolerant of an optional language tag / newline. */
const PAIR_RE = /\*\*(.+?)\*\*\s*```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;

/** Lowercase + strip diacritics for keyword matching. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Extract the `**q** ```a``` ` pairs from an embed description. */
export function parsePairsFromDescription(description: string): FormPair[] {
  const out: FormPair[] = [];
  for (const m of description.matchAll(PAIR_RE)) {
    const question = m[1].trim();
    const answer = m[2].trim();
    if (question) out.push({ question, answer });
  }
  return out;
}

/** Strip surrounding ``` fences from a field value (some templates wrap answers). */
function stripFences(value: string): string {
  const fenced = /^```[a-zA-Z0-9]*\n?([\s\S]*?)```$/.exec(value.trim());
  return (fenced ? fenced[1] : value).trim();
}

/** Collect the question→answer pairs from an embed (description first, then fields). */
export function collectPairs(embed: EmbedLike): FormPair[] {
  const fromDesc = embed.description ? parsePairsFromDescription(embed.description) : [];
  if (fromDesc.length > 0) return fromDesc;
  if (embed.fields && embed.fields.length > 0) {
    return embed.fields
      .map((f) => ({ question: f.name.trim(), answer: stripFences(f.value) }))
      .filter((p) => p.question);
  }
  return [];
}

/** Map raw pairs onto the known event fields by keyword. Wording-tolerant. */
export function mapPairs(pairs: FormPair[]): ParsedForm {
  const form: ParsedForm = {
    title: null,
    dayRaw: null,
    timeRaw: null,
    speaker: null,
    flyerSelf: null,
    pairs,
  };
  for (const { question, answer } of pairs) {
    const q = norm(question);
    const a = answer.trim();
    if (!a) continue;
    if (form.title === null && (q.includes('titulo') || q.includes('tema'))) {
      form.title = a;
    } else if (form.timeRaw === null && q.includes('hora')) {
      form.timeRaw = a;
    } else if (form.dayRaw === null && (q.includes('dia') || q.includes('fecha'))) {
      form.dayRaw = a;
    } else if (form.speaker === null && (q.includes('ponente') || q.includes('facilitad'))) {
      form.speaker = a;
    } else if (form.flyerSelf === null && (q.includes('flyer') || q.includes('imagen') || q.includes('cartel'))) {
      form.flyerSelf = interpretYesNo(a);
    }
  }
  return form;
}

/** "sí"/"si"/"claro"/"yes" → true, "no" → false, else null. */
function interpretYesNo(answer: string): boolean | null {
  const a = norm(answer);
  if (/^(no|nel|nop|nope)\b/.test(a)) return false;
  if (/^(si|sip|claro|yes|ok|sale|va)\b/.test(a) || a === 's') return true;
  return null;
}

/** Parse the first form-bearing embed of a message into a ParsedForm (null if none). */
export function parseTicketForm(message: MessageLike): ParsedForm | null {
  for (const embed of message.embeds) {
    const pairs = collectPairs(embed);
    if (pairs.length >= 2) return mapPairs(pairs);
  }
  return null;
}

/**
 * Whether this message is the ticket bot's EVENT-REQUEST form: authored by the
 * configured ticket bot, and parses to a título AND a día/hora. Requiring the
 * scheduling fields (not just any title) is the guardrail that keeps ChopperBot
 * OUT of other ticket types in the same category — a report/support form has a
 * subject but never asks "¿qué día?"/"¿a qué hora?", so it won't match.
 * Detection is by content shape, not exact wording, so a reworded event form
 * still works; a chat message never trips it.
 */
export function isEventForm(message: MessageLike, ticketBotId: string): boolean {
  if (message.authorId !== ticketBotId) return false;
  const parsed = parseTicketForm(message);
  if (!parsed) return false;
  return parsed.title !== null && (parsed.dayRaw !== null || parsed.timeRaw !== null);
}

/** The requester is the first user mention in the "Bienvenidx <@id>" open message. */
export function extractRequesterId(content: string, excludeIds: readonly string[] = []): string | null {
  for (const m of content.matchAll(/<@!?(\d+)>/g)) {
    const id = m[1];
    if (!excludeIds.includes(id)) return id;
  }
  return null;
}
