/**
 * On-demand announcements: a mod in the calendar channel says *"anúncialo en
 * eventos, general y foro de poesía"* and the bot posts that event's
 * announcement to exactly those channels — after showing the mod the message
 * and getting a yes.
 *
 * Why this exists (live, 2026-08-18, in the calendar channel): a mod asked
 * *"ayúdame a publicar un anuncio que diga bandaaaa, mañana a las 8pm tendremos
 * Círculo de poemas propios"*. The bot correctly identified the event and
 * correctly explained that the automatic 10:00 AM announcement covers it — and
 * that was the right answer to the question it was asked. But the follow-up was
 * *"asi esta perfecto solo anuncialo tanto en eventos como en general y foro
 * poesia"*, a direct instruction the bot had no way to carry out: the announce
 * machinery only knows ONE channel (the configured `#anuncios`) and only ever
 * fires on the day of the event, on its own schedule. The mod's ask is
 * legitimate and routine — publish this, now, here, here and here.
 *
 * This module is the pure half: which channels a mod named, what the message
 * ends up being, and the confirm-then-post contract. Kept free of discord.js
 * and of the LLM client because the two ways this feature can embarrass the
 * community in front of itself — posting to a channel nobody asked for, or
 * posting text nobody approved — must be unit-testable.
 *
 * ## The contract, and why it's a token
 *
 * Posting to community channels is the one thing in this capability that is
 * *irreversible in the way that matters*: deleting a message does not retract
 * its notification (the lesson the daily announcer paid for on 2026-08-11). So
 * the write is split in two tool calls with a stored draft in between:
 *
 *   `calendar_draft_announcement`  → writes the text, resolves the channels,
 *                                    stores it under a token, posts NOTHING
 *   `calendar_send_announcement`   → spends the token, posts that exact text
 *
 * The draft (not the model's memory) is the source of truth for what gets sent,
 * so the message a mod approved is byte-identical to the message that lands;
 * and the token is single-use in SQLite, so "sí, publícalo" twice can't
 * double-post.
 */
import { SPANISH_VOICE_RULES } from '../../lang/voice.js';
import { normalizeRoleName } from '../../discord/mod-roles.js';
import { formatInTimezone, formatLocalClock, DEFAULT_TIMEZONE } from './time.js';
import { ANNOUNCEMENT_VOICE_EXAMPLES, type AnnounceTarget } from './announce.js';

/**
 * Hard cap on how many channels one announcement may fan out to.
 *
 * Not a performance limit — a governor on blast radius. A mod naming three or
 * four channels is the real use case ("eventos, general y foro poesía"); a
 * request that resolves to a dozen is either a misunderstanding or the model
 * over-interpreting "anúncialo en todos lados", and the community should not
 * find out via twelve simultaneous pings.
 */
export const MAX_BROADCAST_CHANNELS = 5;

/** Discord's cap on the `nonce` field of a message create. */
const MAX_NONCE_LENGTH = 25;

/** A channel a mod named, resolved to something postable. */
export interface BroadcastChannel {
  id: string;
  /** Channel name without the `#`, for the confirmation line. */
  name: string;
  /**
   * How posting works there. A **forum** takes no loose messages — an
   * announcement becomes a new post (thread) instead — and that difference has
   * to survive all the way to the send, because this community keeps activity
   * channels like `foro-poesía` as forums and naming one is a completely
   * ordinary request ("anúncialo en eventos, general y foro poesía", live
   * 2026-08-18).
   */
  kind: 'text' | 'forum';
}

/**
 * Why one of the mod's channel words did or didn't become a target. These are
 * kept distinct because they are different problems with different fixes, and
 * collapsing them produces the worst possible answer — telling a mod a channel
 * "no existe" when the truth is the bot can't write in it.
 */
export type ChannelResolutionReason = 'ok' | 'unknown' | 'ambiguous' | 'not_sendable';

/**
 * How the mod's channel words were resolved. `ambiguous`/`unknown` are
 * reported rather than guessed: picking the wrong channel is a public mistake
 * in somebody else's space, and the mod is right there to disambiguate.
 */
export interface ChannelResolution {
  /** The mod's original word for it, echoed back in questions. */
  query: string;
  reason: ChannelResolutionReason;
  match: BroadcastChannel | null;
  candidates: BroadcastChannel[];
}

/**
 * Split the mod's channel list into what we can post to and what we must ask
 * about. Pure. `resolved` preserves the mod's order and drops duplicates (the
 * same channel named twice — "en anuncios y en #anuncios" — is one post).
 */
export function partitionResolutions(resolutions: readonly ChannelResolution[]): {
  resolved: BroadcastChannel[];
  problems: ChannelResolution[];
} {
  const resolved: BroadcastChannel[] = [];
  const seen = new Set<string>();
  const problems: ChannelResolution[] = [];
  for (const r of resolutions) {
    if (r.reason === 'ok' && r.match) {
      if (!seen.has(r.match.id)) {
        seen.add(r.match.id);
        resolved.push(r.match);
      }
      continue;
    }
    problems.push(r);
  }
  return { resolved, problems };
}

/**
 * The mention policy for an on-demand announcement.
 *
 * Deliberately NOT the daily announcement's configured mention list. That list
 * exists because the morning post to `#anuncios` is a standing, expected
 * broadcast the community opted into; a mod asking for an extra announcement in
 * three channels is asking for a *message*, not for three more pings of the
 * member role. So the default is **ping nobody**, and mentioning is something
 * the mod has to ask for explicitly — which is also the only way the model can
 * ever produce one, since the writer prompt forbids it from typing mentions.
 */
export interface BroadcastMentions {
  roleIds: string[];
  everyone: boolean;
}

/** A guild role the resolver can match a name against. */
export interface NamedBroadcastRole {
  id: string;
  name: string;
}

export const NO_MENTIONS: BroadcastMentions = { roleIds: [], everyone: false };

/**
 * Resolve a mod's mention request against what they're actually allowed to
 * spend. `allowed` is the announce-mentions setting (the roles the community
 * already agreed may be pinged for events, plus possibly `everyone`); anything
 * outside it is dropped rather than honoured, so "menciona a todos" from the
 * model can't escalate into an `@everyone` that was never configured.
 *
 * Names are first-class, not junk: a mod says "usa el rol usuarix", the model
 * passes `"usuarix"`, and that has to land on the snowflake already in
 * `set_announce_mentions` — the live 2026-08-18 miss was the model inventing
 * "ese rol no está permitido" because (a) the prompt never listed which roles
 * ARE allowed and (b) this function treated any non-snowflake as refused. The
 * bot being Administrator is irrelevant here: Discord would let it ping anyone;
 * the gate is the community's configured list, and Usuarix is already on it.
 *
 * `knownRoles` is how a name becomes an id. Without it a name still refuses
 * (we must not invent a snowflake); with it, a name matching an *allowed* role
 * is accepted and a name matching only a disallowed role is still refused.
 */
export function resolveBroadcastMentions(
  requested: readonly string[],
  allowed: readonly string[],
  knownRoles: readonly NamedBroadcastRole[] = [],
): { mentions: BroadcastMentions; rejected: string[] } {
  const allowedRoles = new Set<string>();
  let everyoneAllowed = false;
  for (const t of allowed) {
    const token = t.trim();
    if (!token) continue;
    if (isEveryoneToken(token)) everyoneAllowed = true;
    else if (/^\d{17,20}$/.test(token)) allowedRoles.add(token);
  }

  const byName = new Map<string, string[]>();
  for (const r of knownRoles) {
    const key = normalizeRoleName(r.name);
    if (!key) continue;
    const ids = byName.get(key) ?? [];
    ids.push(r.id);
    byName.set(key, ids);
  }

  const roleIds: string[] = [];
  const rejected: string[] = [];
  let everyone = false;
  for (const raw of requested) {
    const token = raw.trim();
    if (!token) continue;
    if (isEveryoneToken(token)) {
      if (everyoneAllowed) everyone = true;
      else rejected.push('@everyone');
      continue;
    }
    const id = resolveMentionToken(token, byName);
    if (!id) {
      rejected.push(token);
      continue;
    }
    if (!allowedRoles.has(id)) {
      rejected.push(`<@&${id}>`);
      continue;
    }
    if (!roleIds.includes(id)) roleIds.push(id);
  }
  return { mentions: { roleIds, everyone }, rejected };
}

/**
 * Turn one of the model's mention words into a role id: a snowflake / `<@&id>`
 * wins outright; otherwise a unique normalized name among `knownRoles`.
 * "rol usuarix" and "@usuarix" are the same ask as "usuarix".
 */
function resolveMentionToken(raw: string, byName: Map<string, string[]>): string | null {
  const snowflake = raw.replace(/^<@&(\d{17,20})>$/, '$1');
  if (/^\d{17,20}$/.test(snowflake)) return snowflake;

  const stripped = raw.replace(/^@/, '').replace(/^rol(?:es)?\s+/i, '').trim();
  const key = normalizeRoleName(stripped);
  if (!key) return null;
  const ids = byName.get(key);
  if (ids && ids.length === 1) return ids[0]!;
  return null;
}

function isEveryoneToken(token: string): boolean {
  const t = token.toLowerCase();
  return t === 'everyone' || t === '@everyone' || t === 'here' || t === '@here';
}

/** Render the mention prefix line for a resolved policy (empty when silent). */
export function renderBroadcastMentions(mentions: BroadcastMentions): string {
  const parts: string[] = [];
  if (mentions.everyone) parts.push('@everyone');
  for (const id of mentions.roleIds) parts.push(`<@&${id}>`);
  return parts.join(' ');
}

/**
 * Strip any mention the MODEL wrote. The writer prompt forbids them, but a
 * mention that slips through would render as a chip and — for `@everyone`/
 * `@here`, which `allowedMentions` gates but does not erase — read to the
 * community as if the whole server had been paged. The deterministic prefix is
 * the only place a mention may come from.
 */
export function stripModelMentions(text: string): string {
  return text
    .replace(/<@&\d{17,20}>/g, '')
    .replace(/@everyone/gi, 'todxs')
    .replace(/@here/gi, 'por aquí')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +$/gm, '')
    .trim();
}

/**
 * The idempotency key Discord dedups the create against, per target channel.
 *
 * Same mechanism (and same reason) as the daily announcement's nonce: this
 * Pi's uplink regularly outlives `@discordjs/rest`'s 15 s timeout *after*
 * Discord already created the message, and the retry then lands a second copy.
 * Keyed on the draft token + channel so each channel of one fan-out gets its
 * own key while a retried send of the same message does not.
 */
export function broadcastNonce(token: string, channelId: string): string {
  const key = `b${token}${channelId.slice(-6)}`;
  return key.length <= MAX_NONCE_LENGTH ? key : key.slice(0, MAX_NONCE_LENGTH);
}

/**
 * A short, unguessable-enough handle for a parked draft. Random rather than
 * derived from the event: two mods drafting announcements for the same event
 * minutes apart must not collide onto one token (the second `saveAnnouncementDraft`
 * would overwrite the first's approved text).
 */
export function newDraftToken(random: () => number = Math.random): string {
  let out = '';
  while (out.length < 8) out += Math.floor(random() * 36 ** 6).toString(36);
  return out.slice(0, 8);
}

/**
 * How long a parked draft may be confirmed for. Long enough for a mod to read
 * it, think, and answer; short enough that "sí" tomorrow doesn't resurrect
 * yesterday's message (whose "mañana a las 8pm" would now be wrong).
 */
export const DRAFT_TTL_MS = 30 * 60_000;

export function isDraftExpired(createdAtMs: number, nowMs: number, ttlMs = DRAFT_TTL_MS): boolean {
  return nowMs - createdAtMs > ttlMs;
}

/**
 * Whether an occurrence is still worth announcing on demand.
 *
 * The daily announcer refuses to post about something that already started
 * ("hoy a las 8pm" at 8:40 reads as broken) and the same judgement applies
 * here, with one difference: a mod asking explicitly gets a grace window
 * instead of a flat refusal, because "ya empezó, caigan" is a message this
 * community genuinely sends.
 */
export const LATE_BROADCAST_GRACE_MS = 30 * 60_000;

export function broadcastTiming(
  startAtMs: number,
  nowMs: number,
): { kind: 'today' | 'advance' | 'started'; ok: boolean } {
  const startedAgo = nowMs - startAtMs;
  if (startedAgo > LATE_BROADCAST_GRACE_MS) return { kind: 'started', ok: false };
  return { kind: sameLocalDay(startAtMs, nowMs) ? 'today' : 'advance', ok: true };
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(aMs)) === fmt.format(new Date(bMs));
}

/**
 * Assemble the final message: mention prefix, model text (mentions stripped),
 * then the Discord-event link. Deterministic on purpose — the link is the most
 * useful part of the post (it renders the RSVP card) and the mention is the
 * most dangerous, so neither may depend on what the model chose to write.
 */
export function composeBroadcast(input: {
  body: string;
  mentions: BroadcastMentions;
  eventUrl: string | null;
}): string {
  const body = stripModelMentions(input.body);
  const withLink =
    input.eventUrl && !body.includes(input.eventUrl)
      ? `${body.trimEnd()}\n\n${input.eventUrl}`
      : body;
  const prefix = renderBroadcastMentions(input.mentions);
  return prefix ? `${prefix}\n\n${withLink}` : withLink;
}

/** Discord's hard cap on a forum post (thread) title. */
const MAX_THREAD_TITLE = 100;

/**
 * Title for the forum post an announcement becomes in a forum channel.
 *
 * A forum lists titles, not message bodies, so the title has to carry the event
 * on its own — hence the date suffix. Built deterministically from the event
 * (not written by the model) so the confirmed draft and the created post can't
 * disagree, and truncated on a word boundary because Discord rejects anything
 * over 100 characters outright.
 */
export function forumPostTitle(title: string, startAtMs: number): string {
  const when = new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(startAtMs))
    .replace(/\.$/, '');
  const clean = title.replace(/\s+/g, ' ').trim() || 'Evento';
  const suffix = ` — ${when}, ${formatLocalClock(startAtMs)}`;
  if (clean.length + suffix.length <= MAX_THREAD_TITLE) return `${clean}${suffix}`;

  const room = MAX_THREAD_TITLE - suffix.length - 1;
  if (room <= 0) return clean.slice(0, MAX_THREAD_TITLE);
  const cut = clean.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > room * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…${suffix}`;
}

/**
 * Brief for the model that writes an on-demand announcement.
 *
 * Differs from the daily prompt in two ways that matter: it may be days ahead
 * (so the date has to be stated, never "hoy"), and the mod usually said HOW
 * they want it to sound ("que diga bandaaaa, para que desempolven sus
 * libretas"). That instruction is the point of them asking instead of waiting
 * for the automatic post, so it's given real weight — bounded by the same
 * don't-invent-facts rule as everything else.
 */
export function renderBroadcastPrompt(input: {
  target: AnnounceTarget;
  nowMs: number;
  /** The mod's own words about what the announcement should say/emphasize. */
  instruction: string | null;
  /** Channels it will be posted to, so the model can pitch it at that audience. */
  channelNames: readonly string[];
  timing: 'today' | 'advance';
}): string {
  const { occurrence: o } = input.target;
  const clock = formatLocalClock(o.startAtMs);
  const weekday = new Intl.DateTimeFormat('es-MX', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(o.startAtMs));
  const today = input.timing === 'today';

  return `Eres ChopperBot, el bot de la comunidad **Revolución Z** (Discord, en español de México). Unx moderadorx te pidió publicar un anuncio de un evento del calendario. Vas a escribir ESE anuncio.

# El evento
- **Título:** ${o.title}
- **Cuándo:** ${today ? `HOY ${weekday}` : weekday}, a las ${clock} (hora CDMX)
- **Lugar:** ${o.location ?? '(no especificado — no lo inventes, mejor no menciones lugar)'}
- **Detalles del calendario:** ${o.description ?? '(sin detalles extra)'}
- Hora local actual: ${formatInTimezone(input.nowMs)}
- Se va a publicar en: ${input.channelNames.length > 0 ? input.channelNames.map((n) => `#${n}`).join(', ') : '(canales de la comunidad)'}

${
  input.instruction
    ? `# Lo que pidió la moderadorx (IMPORTANTE — es el motivo de este anuncio)
> ${input.instruction}

Respeta el tono, el gancho y los detalles que pidió: si dijo cómo quiere que empiece o qué quiere resaltar, hazlo. Pero **no inventes datos** que no estén arriba (ponentes, lugar, temario) aunque suene bien.`
    : '# Sin instrucciones extra\nEscribe el anuncio con la información de arriba, en la voz de la comunidad.'
}

${ANNOUNCEMENT_VOICE_EXAMPLES}

${SPANISH_VOICE_RULES}

# Reglas (importantes)
- ${today ? `Di claramente que es **HOY** y la hora ("hoy a las ${clock}")` : `Di claramente **la fecha y la hora** ("este ${weekday} a las ${clock}") — **nunca digas ni insinúes que es hoy**`}, en hora CDMX.
- 2 a 5 líneas. Es un anuncio, no un ensayo.
- **NO escribas menciones** de nadie: ni \`@everyone\`, ni \`@here\`, ni roles (\`<@&…>\`), ni usuarixs. Si hay que mencionar, se agrega solo.
- **NO escribas ningún enlace ni URL.** El enlace al evento de Discord se agrega solo al final.
- **No inventes** nada que no esté arriba. Si no hay lugar, no hables del lugar.
- Responde SOLO con el texto del anuncio, sin comillas ni preámbulos.`;
}
