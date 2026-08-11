import { type Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import {
  CalendarStore,
  CALENDAR_MIGRATIONS,
  type CalendarOccurrence,
} from './store.js';
import { CalendarToolSource } from './source.js';
import { OutputChannelPublisher, type CalendarPublisher, type PublishSummary } from './publisher.js';
import { formatInTimezone, renderTemporalAwareness } from './time.js';
import { monthPublishAction } from './publisher.js';
import { availableMonthKeys, hasTemplateFor } from './render.js';
import { monthKey, monthKeyOfUtc } from './grid.js';
import { sendAdminAlert } from '../../discord/admin-alert.js';
import { CalendarAnnouncer } from './announcer.js';
import { createEventSyncer, type DiscordEventSyncer } from './discord-events.js';
import { parseChannelIdEnv } from '../file_scanner/store.js';
import { EventIntakeStore } from '../event_intake/store.js';
import { resolveAnnounceSettings } from './announce-settings.js';
import type { MutableCapabilityRouter } from '../routing.js';
import type { ImageAttachmentRef } from '../../attachments/resolver.js';

/** Capability id, also the key the router binds the management channel under. */
export const CALENDAR_CAPABILITY_ID = 'calendar';

const SNAPSHOT_LIMIT = 8;

/**
 * How often to check whether the local month rolled over. The check is a single
 * SQLite read, so a tight-ish interval is free; 10 min bounds how late the new
 * month's board can appear after local midnight.
 */
const ROLLOVER_CHECK_MS = 10 * 60_000;

/**
 * How often the daily-announcement window is checked. Tighter than the rollover
 * check because it bounds how late the morning announcement lands, and because
 * it's what picks up an event a mod books for the same evening. One SQLite read
 * plus (only when something is actually due) one Discord event fetch.
 */
const ANNOUNCE_CHECK_MS = 5 * 60_000;

/**
 * Calendar capability: a **global** server calendar (not per-user). Moderators
 * talk to it in the bound input channel using natural language to create,
 * update and delete events — including weekly/daily/monthly series. Every change
 * is persisted to SQLite, re-rendered into the month PDF template, and published
 * (with a master ICS file) to the configured output channel.
 */
export class CalendarCapability implements Capability {
  readonly id = CALENDAR_CAPABILITY_ID;
  readonly description =
    'Calendario global del servidor. Los moderadores agregan/editan/eliminan eventos en lenguaje natural; el bot los renderiza en el PDF del mes y los publica (con un ICS) en el canal de salida.';

  private store: CalendarStore | null = null;
  private projectRoot = '.';
  private getDiscordClient: CapabilityInitDeps['getDiscordClient'] = undefined;
  /** Month-rollover watcher (see {@link checkMonthRollover}); cleared on dispose. */
  private rolloverTimer: NodeJS.Timeout | null = null;
  /** Daily-announcement watcher (see {@link CalendarAnnouncer}); cleared on dispose. */
  private announceTimer: NodeJS.Timeout | null = null;
  /** Set in `start()` — used to find the mod-facing channel for nudges. */
  private router: MutableCapabilityRouter | null = null;
  /** Shared handle, kept so a nudge can read who event_intake lets approve. */
  private db: Database.Database | null = null;
  /** Operator alerts already sent this process, so a 10-min tick can't spam. */
  private readonly alertedKeys = new Set<string>();

  async init({ memory, projectRoot, getDiscordClient }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, CALENDAR_MIGRATIONS);
    this.db = memory.db();
    this.store = new CalendarStore(memory.db());
    this.projectRoot = projectRoot;
    this.getDiscordClient = getDiscordClient;

    // Seed the output channel from config on first boot; the DB setting then
    // becomes the source of truth (changeable from the config channel).
    if (!this.store.getOutputChannelId() && config.CALENDAR_OUTPUT_CHANNEL_ID) {
      this.store.setOutputChannelId(config.CALENDAR_OUTPUT_CHANNEL_ID);
    }
    // Same seed-then-DB-wins rule for the announcement channel + its mentions.
    // The mention seed keys off "never written" (SQL NULL), not "empty", so an
    // operator who deliberately silenced the ping doesn't get it back on reboot.
    if (!this.store.getAnnounceChannelId() && config.CALENDAR_ANNOUNCE_CHANNEL_ID) {
      this.store.setAnnounceChannelId(config.CALENDAR_ANNOUNCE_CHANNEL_ID);
    }
    if (this.store.getAnnounceMentionsRaw() === null && config.CALENDAR_ANNOUNCE_MENTIONS) {
      this.store.setAnnounceMentions(parseChannelIdEnv(config.CALENDAR_ANNOUNCE_MENTIONS));
    }
    log.info(
      {
        capability: this.id,
        output_channel: this.resolveOutputChannel() ?? '(unset)',
        announce_channel: this.resolveAnnounceChannel() ?? '(unset)',
      },
      'CalendarCapability initialized (global)',
    );
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store) throw new Error('CalendarCapability.buildTurn called before init');
    const store = this.store;

    const upcoming = store.listUpcoming(ctx.now.getTime(), SNAPSHOT_LIMIT);
    const outputChannelId = this.resolveOutputChannel();
    // Images the mod attached to THIS message — offered to the model as banner
    // candidates, and the exact allowlist the sync tool validates against.
    const imageAttachments = ctx.attachments ?? [];
    const system = renderSystemPrompt(
      ctx.now,
      upcoming,
      outputChannelId,
      this.resolveAnnounceChannel(),
      imageAttachments,
    );

    // Build a publisher only when the Discord client is available (i.e. at
    // runtime post-login). Absent in unit tests → the tools just skip posting.
    let publisher: CalendarPublisher | undefined;
    if (this.getDiscordClient) {
      try {
        publisher = this.makePublisher(this.getDiscordClient());
      } catch {
        publisher = undefined; // client not ready — shouldn't happen at buildTurn time
      }
    }

    // Discord-scheduled-event access needs a guild, so it's only wired up for a
    // guild turn; in a DM the tool reports that it can't rather than throwing.
    let syncer: DiscordEventSyncer | undefined;
    if (ctx.guildId && this.getDiscordClient) {
      try {
        syncer = createEventSyncer({
          client: this.getDiscordClient(),
          guildId: ctx.guildId,
          store,
          formatLocal: formatInTimezone,
        });
      } catch {
        syncer = undefined;
      }
    }

    const source = new CalendarToolSource(store, ctx.userId, ctx.now.getTime(), publisher, {
      syncer,
      allowedImageUrls: imageAttachments.map((a) => a.url),
    });
    return { system, tools: composeToolSources([source]) };
  }

  /**
   * Post-login hook: reconcile the output channel once (so a rollover that
   * happened while the bot was down, or a stale board from older behavior, is
   * corrected without waiting for the next event edit), then keep watching for
   * the month to roll over while we stay up. Best-effort throughout.
   */
  async start({ client, router }: CapabilityStartDeps): Promise<void> {
    if (!this.store) return;
    this.router = router;
    await this.reconcileSafely(client, 'calendar.startup_reconcile');
    this.rolloverTimer = setInterval(() => {
      void this.checkMonthRollover(client);
    }, ROLLOVER_CHECK_MS);
    this.rolloverTimer.unref?.();

    // The daily "hoy hay evento" announcement. Armed here and driven purely by
    // the local clock + the SQLite ledger, so it survives restarts without a
    // cron and can't double-post. Runs immediately once too: a restart at 11:00
    // should not lose the morning's announcement.
    this.announceTimer = setInterval(() => {
      void this.runAnnouncer(client);
    }, ANNOUNCE_CHECK_MS);
    this.announceTimer.unref?.();
    void this.runAnnouncer(client);
    log.info(
      {
        capability: this.id,
        check_every_min: ANNOUNCE_CHECK_MS / 60_000,
        announce_channel: this.resolveAnnounceChannel() ?? '(unset)',
        announce_hour: resolveAnnounceSettings(this.store).hour,
        mentions: resolveAnnounceSettings(this.store).mentions,
      },
      'calendar.announce_watch_started',
    );
    // The watcher is otherwise silent until a month actually rolls over, so log
    // once that it's armed (and what it currently thinks) — that's the only way
    // to confirm the feature is live without waiting for the 1st of the month.
    const current = monthKeyOfUtc(Date.now());
    log.info(
      {
        capability: this.id,
        check_every_min: ROLLOVER_CHECK_MS / 60_000,
        current_month: current,
        verdict: monthPublishAction(current, (key) => this.store?.getPublished(key) !== null),
      },
      'calendar.rollover_watch_started',
    );
  }

  async dispose(): Promise<void> {
    if (this.rolloverTimer) {
      clearInterval(this.rolloverTimer);
      this.rolloverTimer = null;
    }
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
  }

  /**
   * Build the announcer against the live client/router. Public-ish so the admin
   * console (`config_calendar action:announce_now`) and the verify script drive
   * exactly the same code path the timer does — no second implementation of
   * "what would we post".
   */
  makeAnnouncer(client: Client, router?: MutableCapabilityRouter | null): CalendarAnnouncer {
    if (!this.store) throw new Error('CalendarCapability not initialized');
    const store = this.store;
    return new CalendarAnnouncer({
      client,
      store,
      getAnnounceChannelId: () => resolveAnnounceSettings(store).channelId,
      getAnnounceMentions: () => resolveAnnounceSettings(store).mentions,
      getModRoles: () => this.approverRoles(),
      getManagementChannelId: () => resolveManagementChannel(router ?? this.router),
      getAnnounceHour: () => resolveAnnounceSettings(store).hour,
    });
  }

  /** One announcement pass; failures stay inside the timer. */
  private async runAnnouncer(client: Client): Promise<void> {
    try {
      const report = await this.makeAnnouncer(client).run();
      // Only speak up when something actually happened — this ticks every 5 min.
      if (report.announced.length > 0 || report.nudged.length > 0) {
        log.info(
          {
            capability: this.id,
            announced: report.announced.map((a) => ({
              id: a.eventId,
              link: a.link,
              posted: a.posted,
              discord_event: a.discordEventId,
            })),
            nudged: report.nudged.map((n) => n.eventId),
          },
          'calendar.announce_tick',
        );
      } else if (report.reason && report.reason !== 'not_yet' && report.reason !== 'nothing_today') {
        log.warn({ capability: this.id, reason: report.reason, error: report.error }, 'calendar.announce_tick');
      }
    } catch (err) {
      log.warn({ capability: this.id, err }, 'calendar.announce_tick_failed');
    }
  }

  /**
   * Publish the new month's board as soon as the local month rolls over, so the
   * community gets the fresh calendar on day 1 instead of whenever a mod happens
   * to next edit an event. The decision itself lives in the pure
   * {@link monthPublishAction} (which documents why it needs no state).
   */
  private async checkMonthRollover(client: Client): Promise<void> {
    const store = this.store;
    if (!store) return;
    const current = monthKeyOfUtc(Date.now());
    const action = monthPublishAction(current, (key) => store.getPublished(key) !== null);
    if (action === 'already_published') return;
    if (action === 'no_template') {
      await this.alertOnce(client, `no_template:${current}`, [
        `⚠️ **Calendario sin plantilla para ${current}.**`,
        `No hay un PDF de plantilla para el mes actual, así que no puedo publicar el calendario en el canal de salida.`,
        `Agrega \`calendar/<Mes> <Año>.pdf\` y vuelve a correr \`scripts/calibrate-calendar-templates.ts\`.`,
      ]);
      return;
    }

    log.info({ capability: this.id, month: current }, 'calendar.rollover.publishing');
    const summary = await this.reconcileSafely(client, 'calendar.rollover_reconcile');
    // Publishing a new month is the natural once-a-month moment to check that we
    // still have a template for what comes next — a missing one is otherwise
    // invisible until the board silently stops updating.
    if (summary?.ok) await this.warnIfNextMonthUntemplated(client, current);
  }

  /** Alert the config channel that templates run out after the current month. */
  private async warnIfNextMonthUntemplated(client: Client, current: string): Promise<void> {
    const [y, m] = current.split('-').map(Number);
    const next = m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
    if (hasTemplateFor(next)) return;
    await this.alertOnce(client, `no_next_template:${next}`, [
      `📅 **Se acaban las plantillas del calendario.**`,
      `Ya publiqué **${current}**, pero no hay plantilla para **${next}** — el mes que entra no se va a poder publicar.`,
      `Agrega \`calendar/<Mes> <Año>.pdf\` y corre \`npx tsx scripts/calibrate-calendar-templates.ts\`.`,
    ]);
  }

  /** Send an operator alert at most once per process per distinct key. */
  private async alertOnce(client: Client, key: string, lines: string[]): Promise<void> {
    if (this.alertedKeys.has(key)) return;
    this.alertedKeys.add(key);
    log.warn({ capability: this.id, alert: key }, 'calendar.alert');
    await sendAdminAlert(client, lines, 'calendar.alert');
  }

  private async reconcileSafely(client: Client, logTag: string): Promise<PublishSummary | null> {
    try {
      const summary = await this.makePublisher(client).reconcile();
      log.info(
        { capability: this.id, posted: summary.posted, removed: summary.removed, ok: summary.ok, error: summary.error },
        logTag,
      );
      return summary;
    } catch (err) {
      log.warn({ capability: this.id, err }, `${logTag}_failed`);
      return null;
    }
  }

  private makePublisher(client: Client): CalendarPublisher {
    if (!this.store) throw new Error('CalendarCapability not initialized');
    return new OutputChannelPublisher({
      client,
      store: this.store,
      projectRoot: this.projectRoot,
      getOutputChannelId: () => this.resolveOutputChannel(),
    });
  }

  private resolveOutputChannel(): string | null {
    return this.store?.getOutputChannelId() ?? config.CALENDAR_OUTPUT_CHANNEL_ID ?? null;
  }

  private resolveAnnounceChannel(): string | null {
    return this.store ? resolveAnnounceSettings(this.store).channelId : null;
  }

  /**
   * Who to ping about a missing Discord event: the SAME roles event_intake lets
   * approve a request. Read from that capability's setting rather than kept
   * separately, so "who may approve" and "who gets nudged" can't drift apart —
   * the invariant event_intake already holds internally. Guarded: if
   * event_intake never migrated, fall back to the built-in defaults.
   */
  private approverRoles(): string[] {
    if (!this.db) return [];
    try {
      return new EventIntakeStore(this.db).getModRoles();
    } catch {
      return [];
    }
  }
}

/**
 * The channel where mods already talk to the calendar — the one bound to this
 * capability in the routing table. That's where a "you still need to create the
 * Discord event" nudge belongs: mod-facing, but not the admin console. Null when
 * nothing is bound (the announcer then falls back to the config channel).
 */
function resolveManagementChannel(router: MutableCapabilityRouter | null): string | null {
  if (!router) return null;
  for (const [channelId, capabilityId] of router.getAllBindings()) {
    if (capabilityId === CALENDAR_CAPABILITY_ID) return channelId;
  }
  return null;
}

function renderSystemPrompt(
  now: Date,
  upcoming: CalendarOccurrence[],
  outputChannelId: string | null,
  announceChannelId: string | null,
  imageAttachments: ImageAttachmentRef[] = [],
): string {
  const upcomingSection = upcoming.length === 0
    ? 'No hay eventos próximos.'
    : upcoming
        .map((e) => {
          const startLocal = formatInTimezone(e.start_at);
          const loc = e.location ? ` @ ${e.location}` : ' @ (sin sala)';
          const recur = e.recurrence_freq !== null
            ? ` (serie ${e.recurrence_freq}${e.is_recurring_instance ? `, instancia #${e.occurrence_index}` : ''})`
            : '';
          // Whether the Discord event exists is state the model needs BEFORE it
          // answers, not after a tool call: it's what makes "crea el evento"
          // resolvable and what a "¿cuáles faltan?" question is really asking.
          const dc = e.discord_event_id ? ' — evento de Discord: ✅' : ' — evento de Discord: ❌ FALTA';
          return `- #${e.id} **${e.title}** — ${startLocal}${loc}${recur}${dc}`;
        })
        .join('\n');

  const months = availableMonthKeys();
  const outputRef = outputChannelId ? `<#${outputChannelId}>` : '(no configurado)';
  const announceRef = announceChannelId ? ` <#${announceChannelId}>` : '';

  const attachmentsSection = imageAttachments.length === 0
    ? ''
    : `
# Imágenes adjuntas en ESTE mensaje
La persona adjuntó ${imageAttachments.length === 1 ? 'una imagen' : `${imageAttachments.length} imágenes`} en su mensaje. Si la quiere como **portada del evento de Discord** ("pon esta imagen de portada", "usa este flyer"), llama \`calendar_sync_discord_event\` pasando \`image_url\` EXACTAMENTE una de estas (no inventes ni modifiques ninguna):
${imageAttachments.map((a) => `- ${a.url} (${a.name})`).join('\n')}
Si acaba de crear un evento y subió la imagen en el mismo mensaje, ofrécelo tú una vez: *"¿la pongo de portada del evento de Discord?"*
`;

  return `Eres ChopperBot en **modo Calendario**. Administras el **calendario GLOBAL** del servidor Revolución Z: un solo calendario compartido por toda la comunidad. Cualquier moderadorx de este canal puede crear, editar o borrar eventos, y todxs ven los mismos.

# Tu rol
- Ayudas a lxs moderadorxs a registrar eventos (asambleas, círculos de lectura, talleres, convocatorias) en lenguaje natural.
- Cuando registras un evento, el bot **renderiza automáticamente** el PDF del mes correspondiente y lo publica, junto con un archivo ICS, en el canal de salida ${outputRef}. No tienes que hacer nada extra para publicar — sucede solo al crear/editar/borrar.
- Además, **al iniciar cada mes el calendario del mes nuevo se publica solo** en ${outputRef}. El canal de salida es un tablero vivo: muestra el mes en curso (y los meses futuros que ya tengan eventos de fecha única), no los meses que ya pasaron. Si alguien pregunta por el calendario de un mes viejo, dile que el tablero solo conserva el mes actual y ofrécele el ICS.
- **Cada mañana (${config.CALENDAR_ANNOUNCE_HOUR}:00 hora CDMX) anuncio solo los eventos del día** en el canal de anuncios${announceRef}, con el enlace al **evento de Discord** para que la gente se apunte. No tienes que hacer nada para eso: sale automático.

# El evento de Discord (importante)
Un evento del calendario y un **evento de Discord** (los "Eventos" del servidor, donde la gente le da "Me interesa") son dos cosas distintas:
- El **calendario** es lo que administras aquí: es lo que sale en el PDF del mes y en el ICS.
- El **evento de Discord** es el que se puede enlazar (\`discord.com/events/…\`) y al que la gente se apunta. Es lo que el anuncio del día enlaza.
En la lista de "Próximos eventos" (abajo) cada evento dice si ya tiene el suyo (✅) o si le **FALTA** (❌). Esa lista es tu fuente de verdad: úsala antes de preguntar nada.
Con \`calendar_sync_discord_event\` puedes crear el evento de Discord de un evento del calendario y dejarlos ligados. Cuándo usarlo:
- Cuando alguien te lo pida ("crea el evento de Discord", "súbelo a eventos", "haz el evento para que se apunten").

## "Crea el evento" a secas — cuál de los dos (IMPORTANTE)
Cuando alguien dice solo **"crea el evento"**, **"créalo"**, **"hazlo"** o **"sí, créalo"** SIN darte título ni fecha, casi nunca está pidiendo un evento nuevo del calendario: se refiere a algo que ya está sobre la mesa. **Antes de pedir datos, busca el referente** en este orden:
1. **El contexto citado.** Si el mensaje viene respondiendo a un aviso mío (aparece como *"[Contexto — mensaje anterior de ChopperBot…]"* al inicio de su mensaje), **el evento es el que nombra ese aviso** — normalmente mi recordatorio *"📌 Falta crear el evento de Discord"*, que trae el \`#id\`. Actúa sobre ESE id.
2. **Lo que ya se habló** en esta conversación (un evento que acabas de crear o mencionar).
3. **La lista de próximos eventos**: si hay exactamente UNO marcado ❌ FALTA, es casi seguro ese — confírmalo en una línea y hazlo (*"¿el de #29 Conversatorio: Data Centers y LLMs? Lo creo"*), no pidas título y fecha.
**Nunca pidas título + fecha para algo que ya existe en el calendario.** Solo pregunta "¿qué evento?" si de verdad hay varios candidatos (entonces enuméralos con su \`#id\`) o ninguno.
Y al revés: si te dan un **título y una fecha nuevos**, eso sí es un evento del **calendario** — créalo con \`calendar_create_event\`.

## La sala del evento de Discord
El resultado de \`calendar_sync_discord_event\` trae \`venue_kind\`, \`venue_name\` y \`needs_room\`:
- \`voice\`/\`stage\` → quedó en esa sala; dilo al confirmar (*"quedó en Sala de Cineclub"*).
- \`needs_room: true\` (\`external\`) → **no encontré sala**: el evento existe pero la gente no tiene botón para entrar. **Dilo y pregunta una vez**: *"quedó sin sala — ¿en cuál va? (Sala de Eventos, Sala de Cineclub, Asamblea-Z…)"*. Cuando te la digan, guárdala con \`calendar_update_event\` (\`location\`) y el evento de Discord **se mueve solo** a esa sala. No lo dejes callado.
- **Ofrécelo tú** justo después de crear un evento al que valga la pena que la comunidad se apunte: *"¿quieres que cree también el evento de Discord para que la gente se apunte?"* — una vez, sin insistir.
- **Portada:** si la persona adjuntó una imagen (mira "Imágenes adjuntas" más abajo, cuando exista), pásala como \`image_url\` para que quede de portada. También sirve para ponerle o cambiarle la portada a un evento de Discord que ya existía.
- **La sala se resuelve sola:** si el evento tiene \`location\` ("sala de cineclub", "Asamblea-Z"), el evento de Discord se crea en ese canal de voz/escenario; si no tiene, intento adivinarla por el título ("… | Club de poesía" cae en la Sala de Club de Poesía). Si la persona menciona dónde será, guárdalo como \`location\` del evento del calendario y se usará.
- **Sincronía automática (nuevo):** cuando EDITES o BORRES un evento que ya tiene un evento de Discord ligado, el evento de Discord **se actualiza o se elimina solo** (mover fecha/hora, corregir título, cancelar). El resultado de la herramienta trae \`discord_event\` con lo que pasó — menciónalo en tu confirmación ("también actualicé el evento de Discord", "también eliminé el evento de Discord").
- Si la herramienta responde \`missing_permission\`, di claramente que al bot le falta el permiso **Gestionar eventos** del servidor (un admin lo activa en Ajustes del servidor → Roles → ChopperBot) y que mientras tanto lo cree un mod a mano.

# Conversación de seguimiento (IMPORTANTE)
Antes de crear un evento necesitas como mínimo:
1. **Título** claro.
2. **Hora de inicio**, y la **fecha** — o, si es serie, la **cadencia** ("todos los jueves", "cada día").
Si falta algo REQUERIDO o es ambiguo, **haz UNA pregunta concisa a la vez** hasta tenerlo. Lo demás es OPCIONAL: pídelo como mucho una vez y **NO bloquees la creación** por ello:
- **Lugar**: pídelo si no lo dieron, pero si ya tienes lo requerido, créalo igual (puedes dejar el lugar vacío).
- **¿Se repite?** "cada miércoles", "semanal", "todos los días" → es una **serie**, usa \`recurrence_freq\`. Si no queda claro si es único o recurrente, pregúntalo.
- Hora de fin o descripción solo si la persona las menciona.
**Fecha de inicio de una serie:** si dan la cadencia pero no una fecha (p. ej. "todos los jueves a las 8"), **NO la preguntes** — infiere la PRIMERA ocurrencia como el próximo día que cuadre desde la hora local actual.
**Duración de una serie:** ver "Rango de una serie" más abajo — pregúntalo UNA vez, y si no te dan respuesta clara créala indefinida.
No inventes el título ni la hora. Si el mensaje ya **nombra** el evento ("el evento de asamblea ordinaria", "club de cine", "crea X") ese ES el título — úsalo tal cual, **no preguntes "¿cuál es el título?"**. En cuanto tengas título + hora + (fecha o cadencia), **créalo sin preguntas innecesarias** (primero revisa duplicados con \`calendar_search_events\` como se indica abajo).

${renderTemporalAwareness(now)}

# Eventos recurrentes
- Frecuencias soportadas: \`daily\`, \`weekly\`, \`monthly\`. \`start_at_iso\` es la PRIMERA ocurrencia.
- **UNA sola fila por serie. NUNCA crees un evento por cada ocurrencia** — ni siquiera cuando la serie tiene pocas fechas ("los 4 martes de julio" son UN evento \`weekly\` con \`recurrence_count: 4\`, **no** 4 eventos). El renderizador dibuja cada ocurrencia en su celda automáticamente. Crear una fila por fecha es un error: obliga a editar/borrar cada una por separado.
- Frecuencias no soportadas ("cada 15 días", "entre semana"): dilo y ofrece la alternativa semanal.

## Rango de una serie (\`recurrence_count\` / \`recurrence_until_iso\`) — IMPORTANTE
Una serie puede estar **acotada** o ser **indefinida**. Dos formas equivalentes de acotarla (usa UNA, nunca las dos):
- \`recurrence_count\` — **cuántas veces** se repite, contando la primera: "4 sesiones", "los 3 jueves", "un mes de talleres" → \`recurrence_count: 4\`.
- \`recurrence_until_iso\` — **hasta qué fecha**: "hasta el 31 de agosto", "hasta que acabe el semestre" (si dan la fecha).
Reglas:
- Si la persona **ya dio un rango**, aplícalo sin preguntar. Frases como "todo julio", "durante agosto", "por un mes", "las próximas 6 semanas", "mientras dure el libro (8 capítulos)" **SON un rango** — resuélvelo a un \`recurrence_count\` o una fecha; no lo dejes indefinido.
- Si **no dieron ninguna pista**, pregunta **UNA sola vez**, corto y ofreciendo la salida: *"¿Cuántas sesiones son o hasta cuándo se repite? Si no, la dejo indefinida."*
- **Nunca bloquees la creación por esto.** Si contestan "no sé", "indefinido", "por ahora déjalo así", o simplemente no responden a esa pregunta, **créala indefinida** y sigue.
- Al confirmar, **di el rango en concreto**: usa \`occurrence_count\` y \`recurrence_until_local\` del resultado ("semanal, 4 sesiones, la última el Tue Jul 28, 8:00 PM"), o di que quedó **indefinida** si \`recurrence_open_ended\` es \`true\`.
- Para **re-acotar** una serie que ya existe: \`calendar_update_event\` con \`scope:"series"\` y \`recurrence_count\` o \`recurrence_until_iso\`; para volverla indefinida, \`recurrence_until_iso: null\`.

# Editar / borrar una serie: ALCANCE (\`scope\`) — IMPORTANTE
Al editar o borrar una serie recurrente, decide el alcance con el parámetro \`scope\` de \`calendar_update_event\` / \`calendar_delete_event\`:
- \`series\` (por defecto) — afecta TODAS las ocurrencias.
- \`occurrence\` — SOLO la ocurrencia de la fecha que indiques en \`occurrence_date_iso\` (ej. "mueve el del 21 a las 8:30" → \`scope:"occurrence"\`, \`occurrence_date_iso:"2026-06-21"\`, \`start_at_iso\` con la nueva hora EL MISMO día). Para borrar solo ese día, \`calendar_delete_event scope:"occurrence"\`.
- \`following\` — esa ocurrencia y TODAS las siguientes ("de aquí en adelante"); las anteriores se quedan igual.
- **Si la persona no deja claro el alcance** ("cambia el círculo a las 8:30") pregunta: ¿solo ese día, ese y los siguientes, o toda la serie? No asumas \`series\`.
- Mover una sola ocurrencia a OTRO día no se puede directo: cancela esa ocurrencia (\`scope:"occurrence"\` en delete) y crea un evento aparte.
- Al confirmar, di claramente qué alcance aplicaste (el resultado trae \`updated_scope\`/\`deleted_scope\`).

# Buscar, editar y borrar eventos existentes (IMPORTANTE)
- \`calendar_search_events\` es **tolerante**: ignora acentos, mayúsculas, signos de puntuación (":", comas…) y el orden de las palabras. Pasa las palabras que dijo la persona; no adivines la puntuación exacta ("club de poesia rosario castellanos" encuentra "Club de poesía: Rosario Castellanos").
- **Si ya conoces el \`id\`** de un evento porque apareció en un listado, una búsqueda o un mensaje anterior de ESTA conversación, úsalo directo con \`calendar_get_event\` / \`calendar_update_event\` / \`calendar_delete_event\`. **No vuelvas a buscar por título** algo que ya identificaste.
- **Si una búsqueda no devuelve nada** pero la persona afirma que el evento existe, NO respondas que "no existe": reintenta con menos palabras, o usa \`calendar_list_upcoming\` / filtra por la fecha que mencionó para ubicarlo ANTES de contestar.
- **Antes de borrar**, confirma una sola vez el evento exacto (título + fecha/hora). Cuando la persona diga "sí", ejecuta el borrado con el \`id\` que ya tienes — no vuelvas a buscarlo.
- **Nunca repitas una acción ya realizada.** Si en esta conversación ya creaste/editaste/borraste algo y lo confirmaste, no lo vuelvas a ejecutar salvo que te lo pidan otra vez de forma explícita.

# Mensajes que NO piden una acción
Un agradecimiento o cierre social ("gracias", "va", "ok", "listo", "perfecto", "sale", un emoji) **no es una instrucción nueva**. Responde breve y cordial (p. ej. "¡De nada! 🙌") y **no llames ninguna herramienta** ni repitas la acción anterior.

# Plantillas disponibles
- Hay plantillas PDF para: **${months.join(', ')}**. Un evento fuera de ese rango se guarda igual (y entra al ICS), pero no habrá PDF de ese mes — avísalo si pasa.

# Estilo
- Responde en **español** (esa es la lengua del server), salvo que te escriban en otro idioma.
- Sé breve: 1–3 frases para confirmaciones. Al confirmar un evento creado/editado, di el día y hora en local (usa \`start_at_local\` del resultado) y menciona que ya se publicó el calendario en el canal de salida (mira el campo \`published\` del resultado: \`posted\` lista los meses publicados).
- Si \`published.ok\` es \`false\` (p. ej. \`no_output_channel\`), avisa que el evento se guardó pero no se pudo publicar y que un admin configure el canal de salida.
- No cierres con "¿algo más?". Cierra el tema.

# Antes de crear: revisa duplicados
Llama \`calendar_search_events\` con el título (o parte) antes de crear, y si ya existe algo muy parecido el mismo día, avísale a la persona en vez de duplicar.
${attachmentsSection}
# Próximos eventos (calendario global)
${upcomingSection}
`;
}
