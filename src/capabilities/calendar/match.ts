/**
 * Matching a calendar row to the Discord scheduled event that represents it.
 *
 * Why this is a real problem and not a lookup: **admins create the Discord
 * events by hand**, in their own words, while the calendar row was typed by
 * whoever booked it. The same evening shows up as "Rosario Castellanos | Club de
 * poesía" in the calendar and "Club de poesía abierto" on Discord; "Círculo de
 * Lectura: Raíz que no desaparece de Alma Delia" is just "Raíz que no
 * Desaparece" there. Titles rarely match literally, but the START TIME almost
 * always does — so time is the strong signal and the title is the tiebreaker.
 *
 * The module is pure so the policy is testable without Discord or a model, and
 * it is deliberately a *funnel*, mirroring how the IG classifier splits work:
 *
 *   exact stored link  →  deterministic score  →  (only if ambiguous) the model
 *
 * The model is the arbiter of last resort, not the default path: an unambiguous
 * same-hour title match costs zero tokens, and a decided match is persisted on
 * the row so it is decided at most once per event, not once per day.
 */

/** The calendar side of a match: one occurrence we want to announce. */
export interface MatchableOccurrence {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  startAtMs: number;
}

/** The Discord side, narrowed to what matching reads. */
export interface MatchableDiscordEvent {
  id: string;
  name: string;
  description: string | null;
  startAtMs: number;
}

export interface MatchCandidate {
  discordEventId: string;
  name: string;
  /** 0..1 title similarity (see {@link titleSimilarity}). */
  titleScore: number;
  /** Absolute distance between the two start times, in minutes. */
  minutesApart: number;
  /** Blended 0..1 confidence used for ranking and the auto-accept gate. */
  score: number;
}

/** What the caller should do about an occurrence. */
export type MatchVerdict =
  /** Confident enough to link without asking the model. */
  | { kind: 'matched'; candidate: MatchCandidate }
  /** Real candidates exist but none is clearly right → let the model choose. */
  | { kind: 'ambiguous'; candidates: MatchCandidate[] }
  /** Nothing plausible in the window — nobody created the Discord event. */
  | { kind: 'none' };

/**
 * How far apart two starts may be and still be considered the same happening.
 * Generous on purpose: admins routinely set the Discord event to a round hour
 * ("8:00") for a calendar row at 8:30, or shift it by a day when they reschedule
 * on Discord and forget the calendar.
 */
export const CANDIDATE_WINDOW_MS = 26 * 60 * 60_000;

/** Blended score at/above which we link without consulting the model. */
export const AUTO_MATCH_SCORE = 0.62;

/** A runner-up this close to the best one makes the choice ambiguous. */
const AMBIGUITY_MARGIN = 0.12;

/** Title score below which time alone must not be allowed to carry a match. */
const MIN_TITLE_FOR_AUTO = 0.34;

/**
 * Words too common in this community's event titles to be distinctive. Without
 * this, "Club de Cine" half-matches "Club de Poesía" purely on "club"+"de".
 */
const STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'a', 'al', 'en', 'con', 'para', 'por',
  'un', 'una', 'unos', 'unas', 'que', 'su', 'sus', 'lo', 'se', 'o', 'u',
  'the', 'of', 'and', 'to', 'in', 'on', 'at',
  // structural words that appear in most titles here
  'evento', 'sesion', 'sesión', 'parte', 'edicion', 'edición', 'ordinaria', 'ordinario',
]);

/** Fold for comparison: accents off, lowercase, punctuation/emoji → spaces. */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function distinctiveTokens(s: string): string[] {
  return normalizeTitle(s)
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Symmetric token overlap (Dice coefficient) over distinctive words, with a
 * containment shortcut. Symmetry matters because neither side is the "query":
 * the Discord title may be shorter than the calendar one or vice versa, and a
 * one-sided recall score would rate "Club de poesía" as a perfect match for
 * every poetry night in the calendar.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(distinctiveTokens(a));
  const tb = new Set(distinctiveTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  const dice = (2 * shared) / (ta.size + tb.size);
  // A full containment of the smaller title in the larger one ("Raíz que no
  // Desaparece" inside "Círculo de Lectura: Raíz que no desaparece de Alma
  // Delia") is strong evidence Dice alone under-rates.
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  let containedAll = true;
  for (const w of smaller) {
    if (!larger.has(w)) {
      containedAll = false;
      break;
    }
  }
  return containedAll ? Math.max(dice, 0.75) : dice;
}

/** Time closeness as 0..1: 1.0 at the same minute, decaying to 0 at the window edge. */
function timeScore(minutesApart: number): number {
  const windowMin = CANDIDATE_WINDOW_MS / 60_000;
  if (minutesApart >= windowMin) return 0;
  if (minutesApart <= 30) return 1;
  return Math.max(0, 1 - (minutesApart - 30) / (windowMin - 30));
}

/**
 * Candidate Discord events for one occurrence, best first. Time gates the set
 * (nothing outside {@link CANDIDATE_WINDOW_MS} is considered at all) and then
 * time and title are blended — weighted toward the title, since within a day
 * the time is often shared by several rooms but the topic is not.
 */
export function candidatesFor(
  occ: MatchableOccurrence,
  discordEvents: readonly MatchableDiscordEvent[],
): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const de of discordEvents) {
    const minutesApart = Math.abs(de.startAtMs - occ.startAtMs) / 60_000;
    if (minutesApart * 60_000 > CANDIDATE_WINDOW_MS) continue;
    const titleScore = Math.max(
      titleSimilarity(occ.title, de.name),
      // An admin often repeats the calendar title inside the event description.
      de.description ? titleSimilarity(occ.title, de.description) * 0.8 : 0,
    );
    const t = timeScore(minutesApart);
    out.push({
      discordEventId: de.id,
      name: de.name,
      titleScore,
      minutesApart,
      score: 0.6 * titleScore + 0.4 * t,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.minutesApart - b.minutesApart);
}

/**
 * Whether we can link without the model. Three ways to stay out of the
 * `matched` bucket, each a real failure we'd rather escalate than guess:
 * nothing in the window, a title too weak for time to carry alone (two events
 * the same evening in different rooms), or a runner-up too close to the winner.
 */
export function matchVerdict(candidates: readonly MatchCandidate[]): MatchVerdict {
  if (candidates.length === 0) return { kind: 'none' };
  const [best, second] = candidates;
  const clear = second === undefined || best!.score - second.score > AMBIGUITY_MARGIN;
  if (best!.score >= AUTO_MATCH_SCORE && best!.titleScore >= MIN_TITLE_FOR_AUTO && clear) {
    return { kind: 'matched', candidate: best! };
  }
  return { kind: 'ambiguous', candidates: [...candidates] };
}

/**
 * Parse the arbitration model's reply into a chosen Discord event id.
 *
 * Defensive in the same way the IG classifier's parser is: models here have a
 * habit of emitting the *string* `"null"` (and friends) for "no match", which a
 * naive parse would happily treat as an event id. Anything not in
 * `allowedIds` is rejected too — a hallucinated snowflake must not become a link
 * in a message to the whole community.
 */
export function parseMatchReply(
  reply: string,
  allowedIds: readonly string[],
): { discordEventId: string | null; reason: string } {
  const allowed = new Set(allowedIds);
  const json = extractJsonObject(reply);
  const raw = json?.discord_event_id;
  const reason = typeof json?.reason === 'string' ? json.reason.slice(0, 300) : '';
  const id = typeof raw === 'string' ? raw.trim() : raw === null ? '' : '';
  if (!id || isNullishToken(id)) return { discordEventId: null, reason };
  // Keep the model's stated reason AND say we rejected it: in the journal, "it
  // picked something that wasn't offered" is the useful half.
  if (!allowed.has(id)) {
    return { discordEventId: null, reason: `id fuera de la lista (${id})${reason ? `: ${reason}` : ''}` };
  }
  return { discordEventId: id, reason };
}

const NULLISH_TOKENS = new Set(['null', 'none', 'nil', 'n a', 'na', 'ninguno', 'ninguna', 'sin evento', 'no', '-']);

function isNullishToken(s: string): boolean {
  return NULLISH_TOKENS.has(normalizeTitle(s));
}

/** First JSON object in a reply, tolerating prose or a ```json fence around it. */
function extractJsonObject(reply: string): Record<string, unknown> | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? reply;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
