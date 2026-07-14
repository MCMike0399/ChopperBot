import { log } from '../log.js';

/**
 * LLM health watchdog.
 *
 * Every LLM request in `ask()` (src/llm/client.ts) — Kimi (OpenAI SDK) on the
 * text path and Bedrock on the vision path — reports its outcome here. When the
 * LLM stops working, an alert is pushed to the admin/config
 * Discord channel through the injected sink — closing the gap where the bot's
 * whole brain (chat replies AND the IG post classifier) can silently fail
 * while only journald notices. Motivating incident (2026-06-12): a provider
 * repoint rejected a request parameter and every classifier call 400-ed for
 * hours with zero operator-facing signal.
 *
 * Alert policy, mirroring the IG monitor's "alert once, not 1000×" approach:
 * - **Deterministic errors** (4xx config/protocol: 400/401/403/404/422 — a
 *   ValidationException, revoked/insufficient IAM creds, a bad model id) never
 *   self-heal, so alert on the FIRST one.
 * - **Transient errors** (429/5xx/network/timeouts) can self-heal, so alert
 *   only after `TRANSIENT_ALERT_THRESHOLD` consecutive failures.
 * - At most one failure alert per `ALERT_COOLDOWN_MS` (the error text can
 *   change while the underlying outage is the same).
 * - One recovery notice when a request succeeds after an alerted streak.
 *
 * The sink is injected at boot (app.ts) so this module stays free of any
 * Discord dependency; with no sink set (tests, scripts) it degrades to logging.
 */
export type LlmAlertSink = (lines: string[]) => Promise<void>;

export const TRANSIENT_ALERT_THRESHOLD = 3;
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type LlmErrorKind = 'deterministic' | 'transient';

/**
 * Classify an error from either backend. OpenAI SDK errors (Kimi) carry the
 * HTTP status on `.status`; AWS SDK errors (Bedrock) carry it on
 * `$metadata.httpStatusCode` — we read both. Connection and credential-resolution errors
 * have none and are transient. 408/429/5xx are retryable server/throttle
 * states; the remaining 4xx are protocol or auth mistakes that will fail
 * identically on every retry. As a fallback when no status is present, a few
 * AWS exception `name`s are mapped explicitly (Throttling is transient; the
 * Validation/AccessDenied/ResourceNotFound family is deterministic).
 */
export function classifyLlmError(err: unknown): LlmErrorKind {
  const e = err as { status?: unknown; $metadata?: { httpStatusCode?: unknown }; name?: unknown };
  const status =
    typeof e?.status === 'number'
      ? e.status
      : typeof e?.$metadata?.httpStatusCode === 'number'
        ? e.$metadata.httpStatusCode
        : undefined;
  if (typeof status === 'number') {
    if (status === 408 || status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'deterministic';
    return 'transient';
  }
  const name = typeof e?.name === 'string' ? e.name : '';
  if (/Throttling|ServiceUnavailable|InternalServer|ModelTimeout|ModelNotReady/i.test(name)) {
    return 'transient';
  }
  if (/Validation|AccessDenied|ResourceNotFound|UnrecognizedClient|InvalidSignature/i.test(name)) {
    return 'deterministic';
  }
  return 'transient';
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

export class LlmHealthMonitor {
  private sink: LlmAlertSink | null = null;
  private consecutiveFailures = 0;
  private lastAlertAtMs: number | null = null;
  /** True while a failure alert has fired and no success has happened since —
   * the state that arms the recovery notice. */
  private alertedThisOutage = false;

  setSink(sink: LlmAlertSink | null): void {
    this.sink = sink;
  }

  reportSuccess(): void {
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    if (!this.alertedThisOutage) return;
    this.alertedThisOutage = false;
    log.info({ failures }, 'llm.health.recovered');
    this.post([
      '✅ **LLM: recuperado**',
      `Las peticiones al LLM vuelven a funcionar (hubo ${failures} fallo${failures === 1 ? '' : 's'} consecutivo${failures === 1 ? '' : 's'}).`,
      'No se requiere ninguna acción.',
    ]);
  }

  reportFailure(err: unknown, nowMs = Date.now()): void {
    this.consecutiveFailures++;
    const kind = classifyLlmError(err);
    const shouldAlert =
      kind === 'deterministic' || this.consecutiveFailures >= TRANSIENT_ALERT_THRESHOLD;
    if (!shouldAlert) return;
    if (this.lastAlertAtMs !== null && nowMs - this.lastAlertAtMs < ALERT_COOLDOWN_MS) return;
    this.lastAlertAtMs = nowMs;
    this.alertedThisOutage = true;
    log.warn(
      { kind, consecutiveFailures: this.consecutiveFailures, err: errorMessage(err) },
      'llm.health.alerting',
    );
    this.post([
      '🚨 **LLM: las peticiones están fallando**',
      `Error: \`${errorMessage(err)}\``,
      kind === 'deterministic'
        ? 'Tipo: error de configuración/protocolo — **no se va a resolver solo** (p. ej. API key de Kimi inválida, credenciales IAM inválidas, modelo/region sin acceso, parámetro rechazado).'
        : `Tipo: transitorio (red/servidor/throttle), pero ya van ${this.consecutiveFailures} fallos consecutivos.`,
      '',
      'Impacto: el bot no puede responder mensajes ni clasificar posts de Instagram mientras dure.',
      'Diagnóstico: `journalctl --user -u chopperbot -o cat | grep -iE "Validation|AccessDenied|Throttling|llm"`.',
      `(Máx. 1 alerta cada ${Math.round(ALERT_COOLDOWN_MS / 3_600_000)} h; avisaré cuando se recupere.)`,
    ]);
  }

  /** Fire-and-forget: the sink already swallows Discord errors, but guard the
   * call itself too — health reporting must never break an LLM turn. */
  private post(lines: string[]): void {
    if (!this.sink) return;
    void this.sink(lines).catch((err) => log.warn({ err }, 'llm.health.sink_failed'));
  }
}

/** Module-level instance used by src/llm/client.ts; app.ts injects the Discord
 * sink at boot. Tests construct their own LlmHealthMonitor. */
export const llmHealth = new LlmHealthMonitor();
