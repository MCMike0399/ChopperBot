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
 * - **Content-filter rejections** (the provider's own risk/moderation filter
 *   refusing ONE prompt) are neither: the service is healthy and every other
 *   prompt still works, so they NEVER alert and never count toward the
 *   consecutive-failure streak. They're counted separately and surfaced in
 *   `config_system action:health` so a spike is still visible.
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

export type LlmErrorKind = 'deterministic' | 'transient' | 'content_filter';

/**
 * The provider's own risk/moderation filter refused this prompt.
 *
 * Motivating incident (2026-08-06 09:57 CST): a member asked general_chat what
 * the server should do about people who support China, and Moonshot answered
 * `400 The request was rejected because it was considered high risk`
 * (`param: "prompt"`). Under the old rules that was a *deterministic* 400 —
 * i.e. "API key inválida / modelo sin acceso, no se va a resolver solo" — so it
 * paged the admin channel and flipped health to degraded, when in fact the
 * backend was perfectly healthy: every other prompt that minute answered fine,
 * and the SAME prompt answered on a re-run (the filter is probabilistic).
 *
 * Recognizing this is worth the string match precisely because the failure is
 * per-prompt: it must not be retried as a config fix, must not page anyone,
 * and — see ask() in client.ts — is the one case where a retry (and then the
 * Bedrock path) is the right recovery instead of surfacing an error.
 *
 * Kept deliberately narrow: a genuine bad-parameter 400 (`temperature`,
 * unknown field, bad model id) has none of these phrases and must keep its
 * first-failure page.
 */
export function isContentFilterRejection(err: unknown): boolean {
  const e = err as { status?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status =
    typeof e?.status === 'number'
      ? e.status
      : typeof e?.$metadata?.httpStatusCode === 'number'
        ? e.$metadata.httpStatusCode
        : undefined;
  // Moderation refusals come back as a client error (Moonshot: 400; some
  // gateways use 403/451). Never treat a 5xx or a throttle as one.
  if (status !== undefined && status !== 400 && status !== 403 && status !== 451) return false;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /considered high risk|high[\s_-]?risk|risk[\s_-]?control|content[\s_-]?filter|content_policy|moderation|blocked by (?:the )?(?:safety|content)|safety (?:filter|policy)|输入不合法|敏感/i.test(
    msg,
  );
}

/**
 * Classify an error from either backend. OpenAI SDK errors (Kimi) carry the
 * HTTP status on `.status`; AWS SDK errors (Bedrock) carry it on
 * `$metadata.httpStatusCode` — we read both. Connection and credential-resolution errors
 * have none and are transient. 408/429/5xx are retryable server/throttle
 * states; the remaining 4xx are protocol or auth mistakes that will fail
 * identically on every retry. As a fallback when no status is present, a few
 * AWS exception `name`s are mapped explicitly (Throttling is transient; the
 * Validation/AccessDenied/ResourceNotFound family is deterministic).
 *
 * Content-filter refusals are checked FIRST: they arrive as a 400 but say
 * nothing about the bot's configuration.
 */
export function classifyLlmError(err: unknown): LlmErrorKind {
  if (isContentFilterRejection(err)) return 'content_filter';
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

/** Read-only view of the watchdog's state, for the admin console's health view. */
export interface LlmHealthSnapshot {
  /** Failures since the last success — 0 when healthy. */
  consecutive_failures: number;
  /** True while an alert has fired and no success has happened since. */
  degraded: boolean;
  last_success_at_iso: string | null;
  last_failure_at_iso: string | null;
  /** Last failure's message + class, kept for diagnosis (null if never failed). */
  last_error: string | null;
  last_error_kind: LlmErrorKind | null;
  last_alert_at_iso: string | null;
  /** Prompts the provider's risk/moderation filter refused. NOT an outage — the
   * backend is healthy — but a spike means members are hitting the filter, so
   * it's counted and reported instead of being silently swallowed. */
  content_filter_rejections: number;
  last_content_filter_at_iso: string | null;
  last_content_filter_error: string | null;
}

export class LlmHealthMonitor {
  private sink: LlmAlertSink | null = null;
  private consecutiveFailures = 0;
  private lastAlertAtMs: number | null = null;
  /** True while a failure alert has fired and no success has happened since —
   * the state that arms the recovery notice. */
  private alertedThisOutage = false;
  private lastSuccessAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private lastError: string | null = null;
  private lastErrorKind: LlmErrorKind | null = null;
  private contentFilterRejections = 0;
  private lastContentFilterAtMs: number | null = null;
  private lastContentFilterError: string | null = null;

  setSink(sink: LlmAlertSink | null): void {
    this.sink = sink;
  }

  /**
   * Current state for `config_system action:health`. Process-local and reset by a
   * restart — "last success 30 s ago" is the useful signal here, not history.
   */
  snapshot(): LlmHealthSnapshot {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      consecutive_failures: this.consecutiveFailures,
      degraded: this.alertedThisOutage,
      last_success_at_iso: iso(this.lastSuccessAtMs),
      last_failure_at_iso: iso(this.lastFailureAtMs),
      last_error: this.lastError,
      last_error_kind: this.lastErrorKind,
      last_alert_at_iso: iso(this.lastAlertAtMs),
      content_filter_rejections: this.contentFilterRejections,
      last_content_filter_at_iso: iso(this.lastContentFilterAtMs),
      last_content_filter_error: this.lastContentFilterError,
    };
  }

  reportSuccess(nowMs = Date.now()): void {
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.lastSuccessAtMs = nowMs;
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
    const kind = classifyLlmError(err);
    // A moderated prompt is not an outage. Counting it would (a) page the
    // channel as a config error, (b) arm the "✅ LLM recuperado" notice on the
    // next ordinary reply — both happened on 2026-08-06 — and (c) let a run of
    // moderated prompts mask a real failure streak. Count it on its own axis
    // and leave the health state alone.
    if (kind === 'content_filter') {
      this.contentFilterRejections++;
      this.lastContentFilterAtMs = nowMs;
      this.lastContentFilterError = errorMessage(err);
      log.info(
        { total: this.contentFilterRejections, err: errorMessage(err) },
        'llm.health.content_filter_rejected',
      );
      return;
    }
    this.consecutiveFailures++;
    this.lastFailureAtMs = nowMs;
    this.lastError = errorMessage(err);
    this.lastErrorKind = kind;
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
