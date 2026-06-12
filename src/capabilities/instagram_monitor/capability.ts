import { type Client } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import { sendAdminAlert as sendAdminAlertShared } from '../../discord/admin-alert.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import {
  CADENCE_COLD_START_INTERVAL_MS,
  INSTAGRAM_MONITOR_MIGRATIONS,
  InstagramMonitorStore,
} from './store.js';
import {
  DirectInstagramFetcher,
  type InstagramAuth,
  type InstagramFetcher,
} from './fetcher.js';
import { InstagramMonitorScheduler } from './scheduler.js';
import { InstagramMonitorToolSource } from './source.js';
import { setIgCdnUserAgent } from './publisher.js';
import { renderInstagramMonitorPrompt } from './preamble.js';
import { formatDurationEs, formatStatusDigest } from './format.js';

/** Probability of skipping a whole scheduler tick (anti-metronome). */
const TICK_SKIP_PROBABILITY = 0.08;

export const INSTAGRAM_MONITOR_CAPABILITY_ID = 'instagram_monitor';

export class InstagramMonitorCapability implements Capability {
  readonly id = INSTAGRAM_MONITOR_CAPABILITY_ID;
  readonly description =
    'Monitorea cuentas públicas de Instagram y publica eventos/alertas/convocatorias en el canal de Discord vinculado. Sondeo en segundo plano cada ~60 minutos.';

  private store: InstagramMonitorStore | null = null;
  private fetcher: InstagramFetcher | null = null;
  private scheduler: InstagramMonitorScheduler | null = null;

  async init({ memory }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, INSTAGRAM_MONITOR_MIGRATIONS);
    this.store = new InstagramMonitorStore(memory.db());

    const auth: InstagramAuth | null =
      config.IG_SESSIONID && config.IG_CSRFTOKEN && config.IG_DS_USER_ID
        ? {
            sessionid: config.IG_SESSIONID,
            csrftoken: config.IG_CSRFTOKEN,
            dsUserId: config.IG_DS_USER_ID,
            mid: config.IG_MID,
            igDid: config.IG_DID,
          }
        : null;
    // Use one UA across the API fetcher AND the CDN media fetches so a session
    // presents a single consistent fingerprint. IG_USER_AGENT should match the
    // browser the cookies came from; unset falls back to the built-in default.
    if (config.IG_USER_AGENT) setIgCdnUserAgent(config.IG_USER_AGENT);
    this.fetcher = new DirectInstagramFetcher(auth, 0.5, config.IG_USER_AGENT);
    log.warn(
      { capability: this.id, authed: auth !== null, custom_ua: !!config.IG_USER_AGENT },
      auth
        ? 'InstagramMonitorCapability initialized in DIRECT+AUTH mode (logged-in IG session cookies). Higher rate limits; session can expire (watch for instagram_monitor.auth.expired).'
        : 'InstagramMonitorCapability initialized in DIRECT mode (no auth). OK for local dev; in prod this risks IP throttling.',
    );
  }

  async start({ client, router }: CapabilityStartDeps): Promise<void> {
    if (!this.store || !this.fetcher) {
      throw new Error('InstagramMonitorCapability.start() called before init()');
    }
    const store = this.store;
    this.scheduler = new InstagramMonitorScheduler({
      store,
      fetcher: this.fetcher,
      client,
      // Re-read on every tick so live re-bindings take effect without a restart.
      getBoundChannels: () => {
        const out: string[] = [];
        for (const [channelId, capabilityId] of router.getAllBindings()) {
          if (capabilityId === this.id) out.push(channelId);
        }
        return out;
      },
      notifyAuthExpired: ({ account, reason }) =>
        postAuthExpiredAlert(client, account, reason),
      notifyCircuitBroken: (reason) => postCircuitBrokenAlert(client, reason),
      notifyBudgetExhausted: ({ requests24h, budget }) =>
        postBudgetExhaustedAlert(client, requests24h, budget),
      notifyResumed: ({ reason, pausedForMs }) =>
        postResumedAlert(client, reason, pausedForMs),
      notifyStatusDigest: () =>
        postStatusDigest(
          client,
          store,
          config.IG_DAILY_REQUEST_BUDGET,
          CADENCE_COLD_START_INTERVAL_MS,
        ),
      dailyRequestBudget: config.IG_DAILY_REQUEST_BUDGET,
      tickSkipProbability: TICK_SKIP_PROBABILITY,
    });
    this.scheduler.start();
    log.info({ capability: this.id }, 'InstagramMonitorCapability scheduler started');
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store || !this.fetcher) {
      throw new Error('InstagramMonitorCapability.buildTurn called before init');
    }
    const source = new InstagramMonitorToolSource({
      store: this.store,
      channelId: ctx.channelId,
      userId: ctx.userId,
      nowMs: ctx.now.getTime(),
    });
    return {
      system: renderInstagramMonitorPrompt(ctx.now),
      tools: composeToolSources([source]),
    };
  }

  async dispose(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.dispose();
      this.scheduler = null;
    }
  }
}

/**
 * Sends an alert to the admin/config Discord channel when IG flags the session.
 * The scheduler already rate-limits these calls to one per 6 h, so this helper
 * just sends; it doesn't need its own dedup. Any send error is logged and
 * swallowed (it must not bubble up into the polling loop).
 *
 * Exported so verification scripts (e.g. `scripts/verify-auth-alert.ts`) can
 * drive this exact code path without faking an IG auth failure.
 */
export async function postAuthExpiredAlert(
  client: Client,
  account: string,
  reason: string,
): Promise<void> {
  await sendAdminAlert(client, [
    '⚠️ **Instagram monitor: sesión bloqueada**',
    `Cuenta probada: \`${account}\``,
    `Detalle: ${reason}`,
    '',
    'Acción:',
    '1. Abre `instagram.com` en el navegador con la cuenta y completa el reto / "¿Fuiste tú?".',
    '2. Saca cookies nuevas (`sessionid`, `csrftoken`, `ds_user_id`, `mid`, `ig_did`) y reemplázalas en `.env` (con el mismo navegador que `IG_USER_AGENT`).',
    '3. `pnpm run build && systemctl --user restart chopperbot.service`.',
    '',
    'Mientras tanto el sondeo está suspendido 1 h y se reanudará automáticamente si la sesión recupera.',
  ]);
}

/**
 * Posted when the PERSISTENT circuit breaker trips (repeated throttles or an
 * account flag). Unlike the auth cooldown, this does NOT auto-resume — the
 * operator must explicitly run `config_instagram action:resume_monitor` after
 * confirming the account is healthy. Wired as the scheduler's
 * `notifyCircuitBroken` dep.
 */
export async function postCircuitBrokenAlert(client: Client, reason: string): Promise<void> {
  await sendAdminAlert(client, [
    '🛑 **Instagram monitor: DETENIDO (interruptor de seguridad)**',
    `Motivo: ${reason}`,
    '',
    'El sondeo de TODAS las cuentas está detenido y **no se reanudará solo** (protección de tu cuenta personal contra baneos).',
    '',
    'Antes de reanudar:',
    '1. Abre `instagram.com` con tu cuenta y revisa que no haya retos/avisos pendientes.',
    '2. Si IG pidió verificación, complétala y refresca las cookies en `.env`.',
    '3. Para reanudar el monitor escríbeme en este canal: `config_instagram action:resume_monitor` (confirma).',
  ]);
}

/**
 * Posted when the rolling-24h request budget is exhausted. This is a SOFT pause
 * that auto-recovers as the window drains — informational, no action required.
 */
export async function postBudgetExhaustedAlert(
  client: Client,
  requests24h: number,
  budget: number,
): Promise<void> {
  await sendAdminAlert(client, [
    'ℹ️ **Instagram monitor: presupuesto diario alcanzado**',
    `Peticiones en 24 h: ${requests24h} / ${budget}.`,
    '',
    'El sondeo se pausó temporalmente y se reanudará automáticamente conforme la ventana de 24 h se vacíe. ' +
      'Si pasa seguido, sube `IG_DAILY_REQUEST_BUDGET` o reduce el número de cuentas monitoreadas.',
  ]);
}

/**
 * Posted when polling RESUMES after an abnormal pause (budget window drained,
 * rate-limit cooldown elapsed, or the kill-switch was cleared). The counterpart
 * to the pause alerts above — the user asked to be told when the monitor comes
 * back. Wired as the scheduler's `notifyResumed` dep.
 */
export async function postResumedAlert(
  client: Client,
  reason: 'killswitch' | 'auth' | 'rate' | 'budget',
  pausedForMs: number,
): Promise<void> {
  const why: Record<typeof reason, string> = {
    killswitch: 'el interruptor de seguridad fue liberado',
    auth: 'la sesión se recuperó tras el periodo de espera',
    rate: 'terminó el enfriamiento por límite de peticiones (429) de Instagram',
    budget: 'la ventana de 24 h se vació por debajo del presupuesto diario',
  };
  await sendAdminAlert(client, [
    '✅ **Instagram monitor: sondeo REANUDADO**',
    `Motivo: ${why[reason]}.`,
    `Estuvo pausado ~${formatDurationEs(pausedForMs)}.`,
    '',
    'El monitor volvió a sondear las cuentas con normalidad. No se requiere ninguna acción.',
  ]);
}

/**
 * Posts the daily status digest to the admin channel: overall state, 24h
 * request budget/headroom, and a per-account table (cadence, effective poll
 * interval, last-post age, next-poll ETA). Reads fresh state each call. Wired as
 * the scheduler's `notifyStatusDigest` dep, and reused by `config_instagram
 * action:digest_now` for an on-demand post.
 */
export async function postStatusDigest(
  client: Client,
  store: InstagramMonitorStore,
  dailyRequestBudget: number,
  defaultPollIntervalMs: number,
): Promise<void> {
  const lines = formatStatusDigest({
    runtime: store.getRuntime(),
    accounts: store.listAccounts(),
    dailyRequestBudget,
    defaultPollIntervalMs,
    nowMs: Date.now(),
  });
  await sendAdminAlert(client, lines);
}

/** Admin-channel sender shared bot-wide; see src/discord/admin-alert.ts. The
 * local wrapper just pins this capability's journal tag. */
async function sendAdminAlert(client: Client, lines: string[]): Promise<void> {
  await sendAdminAlertShared(client, lines, 'instagram_monitor.auth_alert');
}
