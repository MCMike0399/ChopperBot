/**
 * The pure policy behind the daily "hoy hay evento" announcement: *what* gets
 * announced *when*, what the message says when the model is unavailable, and
 * how the model is briefed when it is.
 *
 * Kept free of Discord and of the LLM client so the two decisions that can
 * embarrass us in front of the whole community — announcing the wrong day, or
 * announcing twice — are unit-testable.
 */
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
export function renderFallbackAnnouncement(target: AnnounceTarget): string {
  const { occurrence: o } = target;
  const clock = formatLocalClock(o.startAtMs);
  const lines = [`📣 **Hoy: ${o.title}**`, '', `🕗 Hoy a las ${clock} (hora CDMX)`];
  if (o.location) lines.push(`📍 ${o.location}`);
  if (o.description) lines.push(`📝 ${o.description}`);
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
 * Brief for the model that WRITES the announcement. The examples are condensed
 * from real posts by this community's admins — the voice is the point of using a
 * model here at all, and it isn't derivable from the calendar row.
 */
export function renderAnnouncementPrompt(target: AnnounceTarget, nowMs: number): string {
  const { occurrence: o } = target;
  const clock = formatLocalClock(o.startAtMs);
  const weekday = new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(o.startAtMs));

  return `Eres ChopperBot, el bot de la comunidad **Revolución Z** (Discord, en español de México). Vas a escribir el **anuncio del día** para un evento que ocurre HOY, en el canal de anuncios.

# El evento de hoy
- **Título:** ${o.title}
- **Cuándo:** hoy ${weekday}, a las ${clock} (hora CDMX)
- **Lugar:** ${o.location ?? '(no especificado — no lo inventes, mejor no menciones lugar)'}
- **Detalles del calendario:** ${o.description ?? '(sin detalles extra)'}
- Hora local actual: ${formatInTimezone(nowMs)}

# Cómo escribe esta comunidad (imita este tono, NO copies el texto)
Ejemplos reales de anunciantes del server:
> Amixes miembros de RevZ — Hoy a las 8pm hora CDMX tendremos el siguiente círculo de estudio/lectura sobre *Raíz que no Desaparece* por nuestra camarada y amiga. Ahí nos vemos lxs tqm ❤️‍🩹
> Gente que tiene esperanza! Hoy veremos la peliculota llamada *Soul*, a las 9:00 pm, ¿por qué? porque ocupamos recuperar la esperanza :3. Se llevará a cabo en la Sala de Eventos, caiganle. Lxs tqm.
> Muchachooooos! Hoy es un gran día, hoy haremos nuestra respectiva ASAMBLEA SEMANAL! Se llevará a cabo a las 8:00 pm. Caiganle, se va a poner chingón.

Rasgos del estilo: cálido, cómplice, informal, lenguaje incluyente ("lxs", "camaradas", "amixes"), 1–2 emojis, un cierre afectuoso ("lxs tqm", "ahí nos vemos", "caiganle"). Entusiasmo sí, cursilería no.

# Reglas (importantes)
- **Menciona claramente que es HOY y la hora** ("hoy a las ${clock}"), en hora CDMX.
- 2 a 5 líneas. Es un anuncio, no un ensayo.
- **NO escribas menciones** de nadie: ni \`@everyone\`, ni \`@here\`, ni roles (\`<@&…>\`), ni usuarixs. La mención se agrega sola.
- **NO escribas ningún enlace ni URL.** El enlace al evento de Discord se agrega solo al final.
- **No inventes** nada que no esté arriba: ni ponentes, ni lugar, ni temario. Si no hay lugar, simplemente no hables del lugar.
- Si los "detalles del calendario" nombran a un ponente, sí puedes nombrarlo en texto (sin @).
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
