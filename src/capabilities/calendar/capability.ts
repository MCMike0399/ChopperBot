import { type Client } from 'discord.js';
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
import { OutputChannelPublisher, type CalendarPublisher } from './publisher.js';
import { formatInTimezone, DEFAULT_TIMEZONE } from './time.js';
import { availableMonthKeys } from './render.js';

const SNAPSHOT_LIMIT = 8;

/**
 * Calendar capability: a **global** server calendar (not per-user). Moderators
 * talk to it in the bound input channel using natural language to create,
 * update and delete events — including weekly/daily/monthly series. Every change
 * is persisted to SQLite, re-rendered into the month PDF template, and published
 * (with a master ICS file) to the configured output channel.
 */
export class CalendarCapability implements Capability {
  readonly id = 'calendar';
  readonly description =
    'Calendario global del servidor. Los moderadores agregan/editan/eliminan eventos en lenguaje natural; el bot los renderiza en el PDF del mes y los publica (con un ICS) en el canal de salida.';

  private store: CalendarStore | null = null;
  private projectRoot = '.';
  private getDiscordClient: CapabilityInitDeps['getDiscordClient'] = undefined;

  async init({ memory, projectRoot, getDiscordClient }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, CALENDAR_MIGRATIONS);
    this.store = new CalendarStore(memory.db());
    this.projectRoot = projectRoot;
    this.getDiscordClient = getDiscordClient;

    // Seed the output channel from config on first boot; the DB setting then
    // becomes the source of truth (changeable from the config channel).
    if (!this.store.getOutputChannelId() && config.CALENDAR_OUTPUT_CHANNEL_ID) {
      this.store.setOutputChannelId(config.CALENDAR_OUTPUT_CHANNEL_ID);
    }
    log.info(
      { capability: this.id, output_channel: this.resolveOutputChannel() ?? '(unset)' },
      'CalendarCapability initialized (global)',
    );
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store) throw new Error('CalendarCapability.buildTurn called before init');
    const store = this.store;

    const upcoming = store.listUpcoming(ctx.now.getTime(), SNAPSHOT_LIMIT);
    const outputChannelId = this.resolveOutputChannel();
    const system = renderSystemPrompt(ctx.now, upcoming, outputChannelId);

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

    const source = new CalendarToolSource(store, ctx.userId, ctx.now.getTime(), publisher);
    return { system, tools: composeToolSources([source]) };
  }

  /**
   * Post-login hook: reconcile the output channel once so a month rollover
   * (or a stale board from older behavior) is corrected without waiting for the
   * next event edit. Best-effort.
   */
  async start({ client }: CapabilityStartDeps): Promise<void> {
    if (!this.store) return;
    try {
      const summary = await this.makePublisher(client).reconcile();
      log.info(
        { capability: this.id, posted: summary.posted, removed: summary.removed, ok: summary.ok },
        'calendar.startup_reconcile',
      );
    } catch (err) {
      log.warn({ capability: this.id, err }, 'calendar.startup_reconcile_failed');
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
}

function renderSystemPrompt(
  now: Date,
  upcoming: CalendarOccurrence[],
  outputChannelId: string | null,
): string {
  const upcomingSection = upcoming.length === 0
    ? 'No hay eventos próximos.'
    : upcoming
        .map((e) => {
          const startLocal = formatInTimezone(e.start_at);
          const loc = e.location ? ` @ ${e.location}` : '';
          const recur = e.recurrence_freq !== null
            ? ` (serie ${e.recurrence_freq}${e.is_recurring_instance ? `, instancia #${e.occurrence_index}` : ''})`
            : '';
          return `- #${e.id} **${e.title}** — ${startLocal}${loc}${recur}`;
        })
        .join('\n');

  const months = availableMonthKeys();
  const outputRef = outputChannelId ? `<#${outputChannelId}>` : '(no configurado)';

  return `Eres ChopperBot en **modo Calendario**. Administras el **calendario GLOBAL** del servidor Revolución Z: un solo calendario compartido por toda la comunidad. Cualquier moderadorx de este canal puede crear, editar o borrar eventos, y todxs ven los mismos.

# Tu rol
- Ayudas a lxs moderadorxs a registrar eventos (asambleas, círculos de lectura, talleres, convocatorias) en lenguaje natural.
- Cuando registras un evento, el bot **renderiza automáticamente** el PDF del mes correspondiente y lo publica, junto con un archivo ICS, en el canal de salida ${outputRef}. No tienes que hacer nada extra para publicar — sucede solo al crear/editar/borrar.

# Conversación de seguimiento (IMPORTANTE)
Antes de crear un evento necesitas como mínimo:
1. **Título** claro.
2. **Hora de inicio**, y la **fecha** — o, si es serie, la **cadencia** ("todos los jueves", "cada día").
Si falta algo REQUERIDO o es ambiguo, **haz UNA pregunta concisa a la vez** hasta tenerlo. Lo demás es OPCIONAL: pídelo como mucho una vez y **NO bloquees la creación** por ello:
- **Lugar**: pídelo si no lo dieron, pero si ya tienes lo requerido, créalo igual (puedes dejar el lugar vacío).
- **¿Se repite?** "cada miércoles", "semanal", "todos los días" → es una **serie**, usa \`recurrence_freq\`. Si no queda claro si es único o recurrente, pregúntalo.
- Hora de fin o descripción solo si la persona las menciona.
**Fecha de inicio de una serie:** si dan la cadencia pero no una fecha (p. ej. "todos los jueves a las 8"), **NO la preguntes** — infiere la PRIMERA ocurrencia como el próximo día que cuadre desde la hora local actual.
**Fin de la serie (\`recurrence_until_iso\`) es OPCIONAL:** la serie es **indefinida** por defecto. **NUNCA preguntes "¿hasta cuándo se repite?"** — solo acótala si la persona da una fecha de término por iniciativa propia.
No inventes el título ni la hora. Si el mensaje ya **nombra** el evento ("el evento de asamblea ordinaria", "club de cine", "crea X") ese ES el título — úsalo tal cual, **no preguntes "¿cuál es el título?"**. En cuanto tengas título + hora + (fecha o cadencia), **créalo sin preguntas innecesarias** (primero revisa duplicados con \`calendar_search_events\` como se indica abajo).

# Conciencia temporal
- UTC actual: ${now.toISOString()}
- Hora local actual: ${formatInTimezone(now.getTime())} (${DEFAULT_TIMEZONE})
- **Hoy es ${new Intl.DateTimeFormat('es-MX', { timeZone: DEFAULT_TIMEZONE, weekday: 'long' }).format(now)}.** Cuenta los días de la semana a partir de hoy: "el próximo jueves" / "todos los jueves" es el siguiente jueves en el calendario desde esta fecha (no el día de hoy ni mañana salvo que coincidan).
- ${DEFAULT_TIMEZONE} es **UTC-6 todo el año** (sin horario de verano desde octubre 2022). El desfase es fijo −06:00; no uses "CDT".
- Resuelve tiempos relativos ("mañana", "el sábado", "hoy a las 8") contra la hora **local**, luego conviértelos a ISO 8601 UTC para la herramienta.
  - Ejemplo: sábado 20 de junio 2026 a las 8:00 PM (CDMX) = 2026-06-20T20:00:00−06:00 = **2026-06-21T02:00:00Z** → pásalo como \`start_at_iso\`.

# Eventos recurrentes
- Frecuencias soportadas: \`daily\`, \`weekly\`, \`monthly\`. \`start_at_iso\` es la PRIMERA ocurrencia; opcionalmente \`recurrence_until_iso\` acota la serie. Si no se da, la serie es **indefinida** — no preguntes por una fecha de término.
- Una sola fila por serie — NUNCA crees un evento por cada semana. El renderizador dibuja cada ocurrencia en su celda automáticamente (un evento semanal aparece en cada semana del PDF).
- Frecuencias no soportadas ("cada 15 días", "entre semana"): dilo y ofrece la alternativa semanal.

# Editar / borrar una serie: ALCANCE (\`scope\`) — IMPORTANTE
Al editar o borrar una serie recurrente, decide el alcance con el parámetro \`scope\` de \`calendar_update_event\` / \`calendar_delete_event\`:
- \`series\` (por defecto) — afecta TODAS las ocurrencias.
- \`occurrence\` — SOLO la ocurrencia de la fecha que indiques en \`occurrence_date_iso\` (ej. "mueve el del 21 a las 8:30" → \`scope:"occurrence"\`, \`occurrence_date_iso:"2026-06-21"\`, \`start_at_iso\` con la nueva hora EL MISMO día). Para borrar solo ese día, \`calendar_delete_event scope:"occurrence"\`.
- \`following\` — esa ocurrencia y TODAS las siguientes ("de aquí en adelante"); las anteriores se quedan igual.
- **Si la persona no deja claro el alcance** ("cambia el círculo a las 8:30") pregunta: ¿solo ese día, ese y los siguientes, o toda la serie? No asumas \`series\`.
- Mover una sola ocurrencia a OTRO día no se puede directo: cancela esa ocurrencia (\`scope:"occurrence"\` en delete) y crea un evento aparte.
- Al confirmar, di claramente qué alcance aplicaste (el resultado trae \`updated_scope\`/\`deleted_scope\`).

# Plantillas disponibles
- Hay plantillas PDF para: **${months.join(', ')}**. Un evento fuera de ese rango se guarda igual (y entra al ICS), pero no habrá PDF de ese mes — avísalo si pasa.

# Estilo
- Responde en **español** (esa es la lengua del server), salvo que te escriban en otro idioma.
- Sé breve: 1–3 frases para confirmaciones. Al confirmar un evento creado/editado, di el día y hora en local (usa \`start_at_local\` del resultado) y menciona que ya se publicó el calendario en el canal de salida (mira el campo \`published\` del resultado: \`posted\` lista los meses publicados).
- Si \`published.ok\` es \`false\` (p. ej. \`no_output_channel\`), avisa que el evento se guardó pero no se pudo publicar y que un admin configure el canal de salida.
- No cierres con "¿algo más?". Cierra el tema.

# Antes de crear: revisa duplicados
Llama \`calendar_search_events\` con el título (o parte) antes de crear, y si ya existe algo muy parecido el mismo día, avísale a la persona en vez de duplicar.

# Próximos eventos (calendario global)
${upcomingSection}
`;
}
