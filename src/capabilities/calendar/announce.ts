/**
 * The pure policy behind the daily "hoy hay evento" announcement: *what* gets
 * announced *when*, what the message says when the model is unavailable, and
 * how the model is briefed when it is.
 *
 * Kept free of Discord and of the LLM client so the two decisions that can
 * embarrass us in front of the whole community — announcing the wrong day, or
 * announcing twice — are unit-testable.
 */
import { SPANISH_VOICE_RULES } from '../../lang/voice.js';
import { localParts } from './grid.js';
import { formatInTimezone, formatLocalClock, DEFAULT_TIMEZONE } from './time.js';
import type { MatchCandidate, MatchableDiscordEvent, MatchableOccurrence } from './match.js';

/** Local hour (CDMX) from which today's events may be announced. */
export const DEFAULT_ANNOUNCE_HOUR = 10;

/**
 * How long after an event's start we still bother announcing it. Zero on
 * purpose: "hoy a las 8pm tendremos…" posted at 8:40pm reads as broken. A late
 * boot skips the announcement rather than publishing something already wrong —
 * the ledger keeps it from firing tomorrow either.
 */
const LATE_GRACE_MS = 0;

/** One occurrence, plus whatever we know about its Discord event. */
export interface AnnounceTarget {
  occurrence: MatchableOccurrence;
  /** The Discord scheduled event we're confident belongs to it, if any. */
  discordEvent: MatchableDiscordEvent | null;
  /** Its `discord.com/events/...` URL, if we have one. */
  discordEventUrl: string | null;
  /**
   * Set when we did NOT confirm a link but something plausible exists — an
   * ambiguous match we chose not to spend a model call on yet. It suppresses the
   * mod nudge (don't nag about an event that probably already exists) without
   * claiming a link we can't stand behind.
   */
  maybeLinked?: boolean;
}

/**
 * The stable idempotency key for "we announced this occurrence". Keyed on the
 * occurrence's own start instant, so a recurring series gets one announcement
 * per session and a rescheduled event is treated as a new thing to announce.
 */
export function announceKey(eventId: number, occurrenceStartMs: number): string {
  return `announce:${eventId}@${occurrenceStartMs}`;
}

/** Key for the "mods, the Discord event is missing" nudge (one per day per event). */
export function nudgeKey(eventId: number, occurrenceStartMs: number): string {
  return `nudge:${eventId}@${occurrenceStartMs}`;
}

/** Key for the "the Discord event has no cover image" reminder (one per occurrence). */
export function bannerKey(eventId: number, occurrenceStartMs: number): string {
  return `banner:${eventId}@${occurrenceStartMs}`;
}

/** Discord's hard cap on the `nonce` field of a message create. */
export const MAX_NONCE_LENGTH = 25;

/**
 * The idempotency key handed to Discord for one announcement's POST.
 *
 * `POST /channels/{id}/messages` is not idempotent by default, and that is the
 * whole bug this prevents: `@discordjs/rest` aborts a request after 15 s and
 * retries it up to 3 times, but a slow uplink means the *server* already created
 * the message — so the community gets the same @-ping two or three times.
 * Sending `nonce` + `enforce_nonce` makes Discord return the message it already
 * created instead of creating another, which is the only way to stop the
 * duplicate before it fires a notification (deleting it afterwards does not
 * retract the ping).
 *
 * Derived from the announcement's own identity rather than randomly, so it also
 * covers two *different* attempts at the same announcement — overlapping watcher
 * ticks, or a restart mid-post. Base36 keeps it comfortably inside Discord's
 * 25-character limit.
 *
 * `salt` is for a deliberate repost (`--repost` / `ignoreLedger`), which must
 * NOT be swallowed as a duplicate of this morning's post.
 */
export function announceNonce(eventId: number, occurrenceStartMs: number, salt?: number): string {
  const parts = [`a${eventId.toString(36)}`, occurrenceStartMs.toString(36)];
  if (salt !== undefined) parts.push((Math.abs(Math.trunc(salt)) % 36 ** 4).toString(36));
  return parts.join('-');
}

export interface DueInput {
  /** Occurrences in a window that comfortably covers today (the caller expands). */
  occurrences: readonly MatchableOccurrence[];
  nowMs: number;
  /** Local hour from which announcing is allowed. */
  hour?: number;
  /** Whether this occurrence was already announced (the SQLite ledger). */
  isAnnounced: (key: string) => boolean;
}

/**
 * Which occurrences should be announced right now.
 *
 * The window is "on today's local date, at or after the announce hour, and not
 * yet started". Deliberately a window and not an alarm at 10:00 sharp: the
 * watcher ticks every few minutes, the bot may boot at 10:07, and a mod may book
 * a same-day event at 3pm — all three should still produce exactly one
 * announcement, which the ledger (not the clock) guarantees.
 */
export function announcementsDue(input: DueInput): MatchableOccurrence[] {
  const { occurrences, nowMs, isAnnounced } = input;
  const hour = input.hour ?? DEFAULT_ANNOUNCE_HOUR;
  const now = localParts(nowMs);
  if (now.hour < hour) return [];
  return occurrences
    .filter((o) => {
      const p = localParts(o.startAtMs);
      if (p.year !== now.year || p.month !== now.month || p.day !== now.day) return false;
      if (o.startAtMs + LATE_GRACE_MS < nowMs) return false;
      return !isAnnounced(announceKey(o.id, o.startAtMs));
    })
    .sort((a, b) => a.startAtMs - b.startAtMs);
}

/**
 * Occurrences that still have no Discord scheduled event and are close enough
 * that mods should be nudged: today's and tomorrow's. Tomorrow is included so
 * the ping arrives while there's still time to make the event *and* let members
 * see it — nudging only on the day means the RSVP list starts hours before the
 * event.
 */
export function nudgesDue(input: {
  targets: readonly AnnounceTarget[];
  nowMs: number;
  isAnnounced: (key: string) => boolean;
}): AnnounceTarget[] {
  const { targets, nowMs, isAnnounced } = input;
  const horizon = nowMs + 2 * 86_400_000;
  return targets
    .filter((t) => t.discordEvent === null && t.maybeLinked !== true)
    .filter((t) => t.occurrence.startAtMs >= nowMs && t.occurrence.startAtMs <= horizon)
    .filter((t) => !isAnnounced(nudgeKey(t.occurrence.id, t.occurrence.startAtMs)))
    .sort((a, b) => a.occurrence.startAtMs - b.occurrence.startAtMs);
}

/**
 * Tomorrow's occurrences whose Discord event exists but has **no cover image**
 * — the day-before "súbanle portada" reminder for mods.
 *
 * Why tomorrow, at the announce hour: the next morning's announcement links the
 * Discord event, and its embed is the cover. A day of lead time is enough for
 * someone to find the flyer; the same morning is not (live 2026-09-23: both
 * "Idea Vilariño" Discord events were coverless, Part 1 at 8pm that day).
 *
 * `imageUrl === null` is the only trigger. `undefined` means "unknown" (a
 * lookup that didn't report covers), and a reminder about a banner that may well
 * exist is noise. An occurrence with no Discord event at all is the missing-event
 * nudge's job, not this one.
 */
export function bannerRemindersDue(input: {
  targets: readonly AnnounceTarget[];
  nowMs: number;
  hour?: number;
  isAnnounced: (key: string) => boolean;
}): AnnounceTarget[] {
  const { targets, nowMs, isAnnounced } = input;
  const hour = input.hour ?? DEFAULT_ANNOUNCE_HOUR;
  const now = localParts(nowMs);
  if (now.hour < hour) return [];
  const tomorrow = localParts(nowMs + 86_400_000);
  return targets
    .filter((t) => t.discordEvent !== null && t.discordEvent.imageUrl === null)
    .filter((t) => {
      const p = localParts(t.occurrence.startAtMs);
      return p.year === tomorrow.year && p.month === tomorrow.month && p.day === tomorrow.day;
    })
    .filter((t) => !isAnnounced(bannerKey(t.occurrence.id, t.occurrence.startAtMs)))
    .sort((a, b) => a.occurrence.startAtMs - b.occurrence.startAtMs);
}

/**
 * The reminder text. Gentle on purpose — it's a nice-to-have, not a failure —
 * and actionable in one reply: the calendar channel already turns "ponle esta
 * portada al #N" + an attached image into the cover (`calendar_sync_discord_event`
 * with `image_url`), so the ask names that exact sentence and the id.
 */
export function renderBannerReminder(targets: readonly AnnounceTarget[]): string {
  const one = targets.length === 1;
  const lines = [
    one
      ? '🖼️ **Recordatorio amable:** el evento de mañana todavía no tiene **imagen de portada** en Discord:'
      : '🖼️ **Recordatorio amable:** estos eventos de mañana todavía no tienen **imagen de portada** en Discord:',
  ];
  for (const t of targets) {
    const link = t.discordEventUrl ? ` · ${t.discordEventUrl}` : '';
    lines.push(`- **#${t.occurrence.id} ${t.occurrence.title}** — mañana a las ${formatLocalClock(t.occurrence.startAtMs)}${link}`);
  }
  const example = one ? `#${targets[0]!.occurrence.id}` : '#<id>';
  lines.push(
    '',
    'Con portada el evento luce mucho mejor en la lista de Eventos y en el anuncio de mañana. ' +
      `Si ya tienen el flyer, **respondan a este mensaje adjuntándolo** con *"ponle esta portada al ${example}"* y yo la subo. ` +
      'Si no lleva flyer, no pasa nada: el anuncio sale igual. 💚',
  );
  return lines.join('\n');
}

/** Render the mention prefix for the announcement (`everyone` is a valid token). */
export function renderAnnounceMentions(tokens: readonly string[]): {
  text: string;
  roleIds: string[];
  everyone: boolean;
} {
  const roleIds: string[] = [];
  let everyone = false;
  const parts: string[] = [];
  for (const t of tokens) {
    const token = t.trim();
    if (!token) continue;
    if (token.toLowerCase() === 'everyone' || token === '@everyone') {
      everyone = true;
      parts.push('@everyone');
    } else if (/^\d{17,20}$/.test(token)) {
      roleIds.push(token);
      parts.push(`<@&${token}>`);
    }
  }
  return { text: parts.join(' '), roleIds, everyone };
}

/**
 * The announcement written without a model. Not a degraded path we tolerate —
 * it's the guarantee that a model outage costs the community *style*, never the
 * heads-up itself (the same "never do worse than the deterministic answer" rule
 * the IG classifier follows).
 */
/**
 * The community-facing slice of a calendar description: speaker and topic stay,
 * production credits do not.
 *
 */
const STAFF_CREDIT_RE =
  /agitprop|flyer\s+a\s+cargo|comisi[oó]n\s+de\s+agitprop|flyer\s*:\s*har[aá]\s+el\s+solicitante/i;

export function publicEventDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const kept = description
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !STAFF_CREDIT_RE.test(s));
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return out || null;
}

export function renderFallbackAnnouncement(target: AnnounceTarget): string {
  const { occurrence: o } = target;
  const clock = formatLocalClock(o.startAtMs);
  const lines = [`📣 **Hoy: ${o.title}**`, '', `🕗 Hoy a las ${clock} (hora CDMX)`];
  if (o.location) lines.push(`📍 ${o.location}`);
  const details = publicEventDescription(o.description);
  if (details) lines.push(`📝 ${details}`);
  lines.push('', '¡Ahí nos vemos! 💚');
  return lines.join('\n');
}

/**
 * Append the Discord event link deterministically, exactly like event_intake
 * appends its mod ping: the link is the single most useful part of the message
 * (it renders as a card with the RSVP button), so it must not depend on the
 * model remembering to include it — and the prompt tells the model not to.
 */
export function appendEventLink(text: string, url: string | null): string {
  if (!url) return text;
  if (text.includes(url)) return text;
  return `${text.trimEnd()}\n\n${url}`;
}

/** Prefix the mention line, if any. */
export function prefixMentions(text: string, mentionText: string): string {
  return mentionText ? `${mentionText}\n\n${text}` : text;
}

/**
 * How this community's announcers actually write, condensed from real posts.
 *
 * Shared between the daily announcer's prompt and the on-demand broadcast
 * prompt: the voice is the whole reason a model writes these at all, and a
 * mod-requested announcement that reads like a different bot wrote it would
 * defeat the point of the feature.
 */
export const ANNOUNCEMENT_VOICE_EXAMPLES = `# Cómo escribe esta comunidad (imita este tono, NO copies el texto)
Ejemplos reales de anunciantes del server:
> Amixes miembros de RevZ — Hoy a las 8pm hora CDMX tendremos el siguiente círculo de estudio/lectura sobre *Raíz que no Desaparece* por nuestra camarada y amiga. Ahí nos vemos lxs tqm ❤️‍🩹
> Gente que tiene esperanza! Hoy veremos la peliculota llamada *Soul*, a las 9:00 pm, ¿por qué? porque ocupamos recuperar la esperanza :3. Se llevará a cabo en la Sala de Eventos, caiganle. Lxs tqm.
> Muchachooooos! Hoy es un gran día, hoy haremos nuestra respectiva ASAMBLEA SEMANAL! Se llevará a cabo a las 8:00 pm. Caiganle, se va a poner chingón.

Rasgos del estilo: cálido, cómplice, informal, lenguaje incluyente ("lxs", "camaradas", "amixes"), 1–2 emojis, un cierre afectuoso ("lxs tqm", "ahí nos vemos", "caiganle"). Entusiasmo sí, cursilería no.`;

/**
 * Brief for the model that WRITES the announcement. The examples are condensed
 * from real posts by this community's admins — the voice is the point of using a
 * model here at all, and it isn't derivable from the calendar row.
 *
 * `framing` is `'today'` for the daily same-day announcement (the announcer).
 * `'advance'` is the ahead-of-time heads-up used by `scripts/announce-upcoming-event.ts`
 * (e.g. an event created after today's run — the announcer itself never posts
 * those, it only handles the day of). The default path is byte-identical to
 * what the announcer has always sent.
 */
export function renderAnnouncementPrompt(
  target: AnnounceTarget,
  nowMs: number,
  framing: 'today' | 'advance' = 'today',
): string {
  const { occurrence: o } = target;
  const clock = formatLocalClock(o.startAtMs);
  const weekday = new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(o.startAtMs));
  const advance = framing === 'advance';

  return `Eres ChopperBot, el bot de la comunidad **Revolución Z** (Discord, en español de México). Vas a escribir ${advance ? 'un **aviso anticipado** para un evento que se acerca' : 'el **anuncio del día** para un evento que ocurre HOY'}, en el canal de anuncios.

# ${advance ? 'El evento próximo' : 'El evento de hoy'}
- **Título:** ${o.title}
- **Cuándo:** ${advance ? `${weekday}` : `hoy ${weekday}`}, a las ${clock} (hora CDMX)${advance ? ' — NO es hoy: falta unos días, y el anuncio tiene que dejar eso claro' : ''}
- **Lugar:** ${o.location ?? '(no especificado — no lo inventes, mejor no menciones lugar)'}
- **Detalles del calendario:** ${publicEventDescription(o.description) ?? '(sin detalles extra)'}
- Hora local actual: ${formatInTimezone(nowMs)}

${ANNOUNCEMENT_VOICE_EXAMPLES}

${SPANISH_VOICE_RULES}

# Reglas (importantes)
- ${advance ? `**Menciona claramente la fecha y la hora** ("este ${weekday} a las ${clock}"), en hora CDMX — nunca digas ni insinúes que es hoy` : `**Menciona claramente que es HOY y la hora** ("hoy a las ${clock}"), en hora CDMX`}.
- 2 a 5 líneas. Es un anuncio, no un ensayo.
- **NO escribas menciones** de nadie: ni \`@everyone\`, ni \`@here\`, ni roles (\`<@&…>\`), ni usuarixs. La mención se agrega sola.
- **NO escribas ningún enlace ni URL.** El enlace al evento de Discord se agrega solo al final.
- **No inventes** nada que no esté arriba: ni ponentes, ni lugar, ni temario. Si no hay lugar, simplemente no hables del lugar.
- Si los "detalles del calendario" nombran a un ponente, sí puedes nombrarlo en texto (sin @).
- **No menciones** flyers, diseño, ni la Comisión de Agitprop: eso es chamba interna, no va en un anuncio a la comunidad.
- Responde SOLO con el texto del anuncio, sin comillas ni preámbulos.`;
}

/**
 * Brief for the model that ARBITRATES an ambiguous match. Its whole job is to
 * decide whether one of the candidate Discord events is the same happening as
 * the calendar row — and to be comfortable saying "none of them", since a wrong
 * link sends the community to somebody else's event.
 */
export function renderMatchPrompt(
  occurrence: MatchableOccurrence,
  candidates: readonly (MatchCandidate & { startAtMs: number; description: string | null })[],
): string {
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. id="${c.discordEventId}" · **${c.name}** · empieza ${formatInTimezone(c.startAtMs)}` +
        ` (a ${Math.round(c.minutesApart)} min del evento del calendario)` +
        (c.description ? `\n   descripción: ${c.description.slice(0, 300)}` : ''),
    )
    .join('\n');

  return `Eres un clasificador. Decide si alguno de los **eventos de Discord** de abajo es el MISMO acto que este evento del **calendario** de la comunidad Revolución Z.

# Evento del calendario
- Título: ${occurrence.title}
- Empieza: ${formatInTimezone(occurrence.startAtMs)} (hora CDMX)
- Lugar: ${occurrence.location ?? '(sin especificar)'}
- Detalles: ${occurrence.description ?? '(sin detalles)'}

# Eventos de Discord candidatos
${list}

# Cómo decidir
- Lxs admins crean los eventos de Discord a mano y **casi nunca usan el mismo título** que el calendario: "Rosario Castellanos | Club de poesía" puede aparecer como "Club de poesía abierto", y "Círculo de Lectura: Raíz que no desaparece de Alma Delia" como "Raíz que no Desaparece". Fíjate en el **tema, la actividad recurrente (club de cine / club de poesía / asamblea / círculo de estudio) y la hora**, no en las palabras exactas.
- Que coincida la hora **no basta**: dos actividades distintas pueden ser el mismo día a la misma hora en salas diferentes. El tema tiene que ser compatible.
- Si ninguno corresponde, responde \`null\`. **Es mucho peor equivocarse que decir null** — un enlace equivocado manda a la comunidad al evento de alguien más.

# Formato de respuesta
Responde SOLO con este JSON, sin texto alrededor:
{"discord_event_id": "<el id exacto de la lista>" o null, "reason": "<una frase corta>"}
Usa el valor JSON \`null\` (sin comillas), nunca la cadena "null".`;
}

/**
 * Capitalized words a sentence may start with that are never a person's name.
 * Only consulted for words that are NOT in the brief — anything the brief says
 * (title, place, speaker, the voice examples) is always allowed.
 */
const COMMON_CAPITALIZED = new Set(
  (
    'a ahi ahora al alla alli amixes amigxs anda animo animense aprovechen asi atentxs aqui asamblea aviso ' +
    'bandaaa banda bienvenidxs buenas buenos camaradas caiganle chequen compas companerxs con cuando cualquier ' +
    'de del desde despues dia el ella ellas ellos en entonces es esa ese eso esta estan estaremos este esto estos ' +
    'evento eventos gente habra hay hola hoy junto la las les lleguen lo los llego manana mas muchachxs muchachos ' +
    'muchachas nada ni no nos nosotrxs nuestra nuestro nuestras nuestros o oigan para pero por porque pues que ' +
    'recuerden se sea sera si sin sobre somos son su sus tambien te tendremos tenemos todas todos todxs traigan ' +
    'tu un una unete unanse va vamos vengan ven veremos y ya yo lxs chingon chido hora horas sala salas ' +
    'lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto ' +
    'septiembre octubre noviembre diciembre cdmx discord'
  ).split(/\s+/),
);

function foldWord(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Title-case words in a model-written community post that appear NOWHERE in
 * what the model was given — i.e. names it made up.
 *
 * Why this exists (live 2026-09-21, event #40): the brief said "Yeti nos
 * explicará…", and the 10:00 announcement to the whole server said "**Andrés**
 * nos va a explicar…". "Andrés" is in no calendar row, no Discord event, no
 * prompt: the model invented a speaker. The prompt already said "no inventes
 * ponentes"; a rule the model can break needs a check the code enforces.
 *
 * Deliberately narrow, so it can gate a post without flagging normal prose:
 *  - only Title-case words (ALL-CAPS shouting like "ASAMBLEA" is style);
 *  - anything present in `sources` (the whole system prompt, which carries
 *    every fact and every style example) is allowed, accent/case-folded;
 *  - common sentence-starters and imperative/1st-plural verb shapes
 *    ("Pónganse", "Vamos", "Acompáñennos") are allowed.
 * A miss costs a retry (then the deterministic template), never a bad post.
 */
export function inventedNames(text: string, sources: readonly string[]): string[] {
  const vocab = new Set<string>();
  for (const src of sources) {
    for (const w of src.match(/\p{L}+/gu) ?? []) vocab.add(foldWord(w));
  }
  const out: string[] = [];
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ').replace(/<[@#&!:][^>]*>/g, ' ');
  for (const w of cleaned.match(/\p{L}+/gu) ?? []) {
    if (w.length < 3) continue;
    if (!/^\p{Lu}\p{Ll}/u.test(w)) continue; // Title-case only
    const f = foldWord(w);
    if (vocab.has(f) || COMMON_CAPITALIZED.has(f)) continue;
    if (/(nse|mos|nnos|nle|nles|nlo|nla)$/.test(f)) continue; // verb shapes, not names
    if (!out.includes(w)) out.push(w);
  }
  return out;
}
