import { execFileSync } from 'node:child_process';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { fromIni } from '@aws-sdk/credential-providers';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import { LOG_GROUPS, SANCUS_OPS_CAPABILITY_ID } from './constants.js';
import { SANCUS_OPS_MIGRATIONS, SancusOpsStore } from './store.js';
import { NautilusToolSource } from './nautilus.js';
import { GithubToolSource } from './github.js';
import { SancusOpsNotesToolSource } from './notes-source.js';
import { renderSancusOpsPrompt } from './preamble.js';

/**
 * Sancus Ops copilot. A Spanish-first, strictly READ-ONLY ops assistant for the
 * Sancus platform: it answers questions about backend traffic/errors/latency/
 * cron/provider failures by running CloudWatch Logs Insights queries over the
 * Nautilus wide events (dev/qa/prod), reads GitHub for PR/CI/deploy status, and
 * keeps per-channel operator notes it can save and recall.
 *
 * Ports the tool contracts from sancus-ops-bot into ChopperBot's ToolSource
 * framework. Never registers a mutating tool.
 */
export class SancusOpsCapability implements Capability {
  readonly id = SANCUS_OPS_CAPABILITY_ID;
  readonly description =
    'Copiloto de operaciones (solo-lectura) de la plataforma Sancus: consulta errores, tráfico, latencia, crons y fallos de proveedor en los eventos Nautilus (dev/qa/prod), revisa PRs/CI/deploys en GitHub y guarda/recupera notas de operador por canal.';

  private store: SancusOpsStore | null = null;
  private cwClient: CloudWatchLogsClient | null = null;
  private allowedEnvs: string[] = [];
  /** Resolved read-only GitHub token (env or `gh auth token`). Empty = unavailable. */
  private githubToken = '';

  async init({ memory }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, SANCUS_OPS_MIGRATIONS);
    this.store = new SancusOpsStore(memory.db());

    this.allowedEnvs = config.SANCUS_OPS_NAUTILUS_ENVS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s in LOG_GROUPS);
    if (this.allowedEnvs.length === 0) this.allowedEnvs = Object.keys(LOG_GROUPS);

    // CloudWatch client. Self-hosted runs use the `sancus` named profile (the
    // process runs as burbujamc); the literal value `default` skips fromIni and
    // uses the AWS default credential chain (ECS task role / instance profile).
    // Credentials resolve lazily on first query, so a missing/bad profile does
    // NOT break boot — the tool call just returns an error. Region is pinned
    // (Nautilus log groups live in us-east-2). Never logged: creds.
    const profile = config.SANCUS_OPS_AWS_PROFILE;
    this.cwClient = new CloudWatchLogsClient({
      region: config.SANCUS_OPS_AWS_REGION,
      ...(profile === 'default' ? {} : { credentials: fromIni({ profile }) }),
    });

    this.githubToken = resolveGithubToken();

    log.info(
      {
        capability: this.id,
        allowedEnvs: this.allowedEnvs,
        region: config.SANCUS_OPS_AWS_REGION,
        awsProfile: profile,
        githubEnabled: this.githubToken.length > 0,
      },
      'SancusOpsCapability initialized (read-only)',
    );
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store || !this.cwClient) {
      throw new Error('SancusOpsCapability.buildTurn called before init');
    }
    const sources = [
      new NautilusToolSource(this.cwClient, this.allowedEnvs),
      new GithubToolSource(this.githubToken, config.GITHUB_ORG),
      new SancusOpsNotesToolSource({
        store: this.store,
        channelId: ctx.channelId,
        userId: ctx.userId,
        nowMs: ctx.now.getTime(),
      }),
    ];
    return {
      system: renderSancusOpsPrompt({
        now: ctx.now,
        allowedEnvs: this.allowedEnvs,
        githubEnabled: this.githubToken.length > 0,
      }),
      tools: composeToolSources(sources),
    };
  }
}

/**
 * Resolve a read-only GitHub token: prefer the GITHUB_TOKEN env var, else fall
 * back to `gh auth token` (the GitHub CLI's stored token). Degrades gracefully
 * to '' when neither is available. The token value is NEVER logged.
 */
function resolveGithubToken(): string {
  if (config.GITHUB_TOKEN && config.GITHUB_TOKEN.trim()) {
    return config.GITHUB_TOKEN.trim();
  }
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    log.warn(
      { capability: SANCUS_OPS_CAPABILITY_ID },
      'sancus_ops: no GITHUB_TOKEN and `gh auth token` failed — github tool disabled',
    );
    return '';
  }
}
