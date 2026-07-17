import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  QueryStatus,
} from '@aws-sdk/client-cloudwatch-logs';
import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { LOG_GROUPS } from './constants.js';

const MAX_RANGE_MINUTES = 7 * 24 * 60; // 7 days
const MAX_ROWS = 50;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 55_000;

export interface NautilusQueryInput {
  env: string;
  query: string;
  start_relative_minutes?: number;
  limit?: number;
}

export interface NautilusQueryResult {
  env: string;
  logGroup: string;
  rangeMinutes: number;
  status: string;
  rowCount: number;
  rows: Record<string, string>[];
  scannedBytes?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one CloudWatch Logs Insights query against a Nautilus backend log group.
 * READ-ONLY by construction — Logs Insights can only read; there is no code path
 * here that mutates anything. Ported from sancus-ops-bot/src/tools/nautilus.ts.
 *
 * Pure (no `log`/config dependency) so it can be exercised directly by a smoke
 * script or unit test with an injected client.
 */
export async function runNautilusQuery(
  client: CloudWatchLogsClient,
  allowedEnvs: string[],
  input: NautilusQueryInput,
): Promise<NautilusQueryResult> {
  const env = String(input.env || '').toLowerCase();
  if (!allowedEnvs.includes(env)) {
    throw new Error(`env must be one of: ${allowedEnvs.join(', ')} (got "${input.env}")`);
  }
  const logGroup = LOG_GROUPS[env];
  if (!logGroup) throw new Error(`no log group mapped for env "${env}"`);

  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required (a CloudWatch Logs Insights query)');

  const rangeMinutes = Math.min(
    Math.max(Number(input.start_relative_minutes) || 60, 1),
    MAX_RANGE_MINUTES,
  );
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), MAX_ROWS);

  const now = Math.floor(Date.now() / 1000);
  const start = now - rangeMinutes * 60;

  const started = await client.send(
    new StartQueryCommand({
      logGroupName: logGroup,
      startTime: start,
      endTime: now,
      queryString: query,
      limit,
    }),
  );
  const queryId = started.queryId;
  if (!queryId) throw new Error('CloudWatch did not return a queryId');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: string = QueryStatus.Running;
  let results: Record<string, string>[] = [];
  let scannedBytes: number | undefined;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await client.send(new GetQueryResultsCommand({ queryId }));
    status = res.status ?? QueryStatus.Running;
    scannedBytes = res.statistics?.bytesScanned;
    if (
      status === QueryStatus.Complete ||
      status === QueryStatus.Failed ||
      status === QueryStatus.Cancelled
    ) {
      results = (res.results ?? []).map((row) => {
        const obj: Record<string, string> = {};
        for (const field of row) {
          if (field.field && field.field !== '@ptr') obj[field.field] = field.value ?? '';
        }
        return obj;
      });
      break;
    }
  }

  return {
    env,
    logGroup,
    rangeMinutes,
    status,
    rowCount: results.length,
    rows: results.slice(0, MAX_ROWS),
    scannedBytes,
  };
}

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    env: {
      type: 'string',
      description: 'Environment to query: dev, qa, or prod.',
    },
    query: {
      type: 'string',
      description:
        'A CloudWatch Logs Insights query over the Nautilus wide events. ' +
        'Always end with `| limit N`. Example: ' +
        '`fields @timestamp, http_method, http_path, http_status, outcome, error_type, duration_ms | filter outcome = "error" | sort @timestamp desc | limit 20`',
    },
    start_relative_minutes: {
      type: 'integer',
      description: 'How many minutes back to search from now. Default 60, max 10080 (7 days).',
    },
    limit: {
      type: 'integer',
      description: 'Max rows to return. Default 20, max 50.',
    },
  },
  required: ['env', 'query'],
  additionalProperties: false,
};

/**
 * The Nautilus wide-event schema + Logs Insights recipes. Folded into the
 * capability system prompt (see preamble.ts) — the runtime agent loop does not
 * read ToolSource.systemPromptSection(), so the persona prompt embeds this.
 */
export function nautilusSchemaDoc(allowedEnvs: string[]): string {
  return `## nautilus_query — the ONLY window into the running platform (${allowedEnvs.join('/')})

This is your sole tool for observing what is happening in the Sancus backend. It
runs a **CloudWatch Logs Insights** query against one environment's Nautilus
wide-event log group. It is strictly read-only — you cannot mutate anything, and
you never touch a live system directly; you only read its structured event log.

**One wide event = one unit of work.** Fields present on most events:
- \`event_type\` — "http.request", "cron.<job_id>" (see cron list below), "card.issuance_pipeline"
- \`service\` (always "sancus-backend"), \`env\` ("development"/"qa"/"production")
- \`http_method\`, \`http_path\`, \`http_status\`, \`outcome\` ("ok" | "error"), \`duration_ms\`, \`trace_id\`
- \`subject_type\`, \`subject_id\` — **only on authenticated routes** (absent on webhooks, public onboarding, login), so don't assume every request has them.
- On errors: \`error_type\`, \`error_msg\`, \`error_stack\`. **⚠️ These are NOT scrubbed** — a provider error body or stack trace can carry tokens/PII. Summarize them; never paste a raw \`error_msg\`/\`error_stack\` verbatim into Discord.
- Business attrs (query these for flow-level signal): onboarding \`prospect_id\`, \`prospect_creation_failed\`, \`mambu_client_uid\`, \`clabe_created\`, \`approval_partial_{contpaqi,complif,clabe,contract,welcome_email}\`; deposit/fees \`fintoc_event_type\`, \`webhook_duplicate\`, \`company_id\`, \`fee_not_found\`, \`fee_insufficient_balance\`, \`fee_not_charged\`; cards \`tarjeta_habiente_id\`, \`card_batch_id\`, \`embossing_file_id\`, \`sftp_uploaded\`, \`dock_failed_step\`, \`dock_rollback\`, \`dock_error_code\`, \`card_id\`; dispersion \`dispersion_batch_key\`, \`dispersion_ok_count\`, \`dispersion_failed_count\`.
- Cron jobs: per-job counts + \`job_failed\`. The 8 job ids: \`cron.daily_journal_processor\` (1 AM ContPAQi GL póliza), \`cron.recurring_fee_processor\`, \`cron.contract_status_poller\`, \`cron.daily_complif_transactions_upload\`, \`cron.invoice_sweep\`, \`cron.monthly_invoice\`, \`cron.prod_health_daily_digest\`, \`cron.prod_health_periodic_check\`.

**Provider failures — read this before answering "is provider X down?":**
Only **Dock** stamps \`provider_status\` on *every* ≥400 (its own client). All other providers (Mambu, Complif, Fintoc, Nubarium, FacturAPI) set \`provider\`/\`provider_endpoint\`/\`provider_status\` **only on 401 and 429**; connect/timeout set \`provider\` but no status; a 400/403/404/5xx sets **nothing** and surfaces only as \`outcome="error"\` on the parent \`http.request\`. So \`filter provider_status>=400\` **undercounts** — for non-Dock providers, find failures via \`outcome="error"\` + the \`http_path\` of the calling route, not \`provider_status\`.

**⚠️ What these logs CANNOT see (say so plainly — never report "all clear" for these):**
- **Real-time Dock card authorization** (consult/purchase/withdrawal/reversal/payment) and **inbound Dock webhooks** run on the **mx-central-1 backend sidecar**, which ships its wide events to journald, **NOT CloudWatch**. So \`dock_auth_type\`/\`dock_auth_approved\`/\`dock_auth_nsu\` from the live card-auth path do **not** appear here. Card *issuance* (\`card.issuance_pipeline\`, via the us-east-2 backend) IS visible; live *authorization* is not.
- **The Card Services Gateway and the Dock IPsec VPN** (mx-central-1) — no CloudWatch signal at all.
- **The frontend** (React/nginx) emits no wide events — you cannot see UI errors or page traffic.
- **RDS/ALB/NAT internals** — only their downstream effect on backend requests is visible.
If asked about any of these, answer that it is **outside your observability** and point to the infra/dive team — do not infer health from the absence of events.

**Recipes (adapt the env and time range):**
- Error rate:    \`filter outcome="error" | stats count() as errors by bin(1h)\`
- Recent errors: \`filter outcome="error" | fields @timestamp, http_path, http_status, error_type, error_msg | sort @timestamp desc\`
- p95 latency:   \`filter event_type="http.request" | stats pct(duration_ms,95) as p95, avg(duration_ms) as avg by bin(1h)\`
- Cron outcomes: \`filter event_type like /^cron\\./ | fields @timestamp, event_type, job_failed | sort @timestamp desc\`
- Dock provider fails: \`filter provider="dock" and provider_status>=400 | stats count() by provider_status, dock_error_code\`
- Any provider error: \`filter outcome="error" and ispresent(provider) | stats count() by provider, http_path\`
- Traffic:       \`filter event_type="http.request" | stats count() as reqs by bin(1h)\`

Always append \`| limit N\`. Prefer \`stats\` aggregations for questions about
rates/volumes, and \`fields ... | sort @timestamp desc\` for "show me the latest".`;
}

/** Read-only CloudWatch Logs Insights over the Nautilus wide events. */
export class NautilusToolSource implements ToolSource {
  readonly name = 'nautilus';
  private readonly client: CloudWatchLogsClient;
  private readonly allowedEnvs: string[];

  constructor(client: CloudWatchLogsClient, allowedEnvs: string[]) {
    this.client = client;
    this.allowedEnvs = allowedEnvs;
  }

  async systemPromptSection(): Promise<string> {
    return nautilusSchemaDoc(this.allowedEnvs);
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'nautilus_query',
        description:
          'Run a read-only CloudWatch Logs Insights query over the Nautilus wide events for one environment (' +
          this.allowedEnvs.join(', ') +
          '). Use this to answer any question about backend traffic, errors, latency, cron jobs, or provider failures.',
        inputSchema: INPUT_SCHEMA,
      },
    ];
  }

  async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
    if (name !== 'nautilus_query') {
      return { status: 'error', payload: { error: `unknown tool "${name}"` } };
    }
    try {
      const result = await runNautilusQuery(
        this.client,
        this.allowedEnvs,
        (input ?? {}) as unknown as NautilusQueryInput,
      );
      log.info({ env: result.env, status: result.status, rows: result.rowCount }, 'nautilus_query');
      if (result.status !== 'Complete') {
        return { status: 'error', payload: { error: `query ${result.status}`, ...result } };
      }
      return { status: 'success', payload: result };
    } catch (err) {
      log.warn({ tool: name, err }, 'nautilus_query_failed');
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}
