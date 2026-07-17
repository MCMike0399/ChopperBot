export const SANCUS_OPS_CAPABILITY_ID = 'sancus_ops';

/**
 * Environment → CloudWatch Logs Insights log group. This is the capability's
 * ENTIRE observability surface: read-only Nautilus wide events per environment.
 * Prod is observed ONLY through its log group — the bot never touches live prod.
 * Ported verbatim from sancus-ops-bot/src/config.ts.
 */
export const LOG_GROUPS: Record<string, string> = {
  dev: '/ecs/sancus_minimal_backend_dev',
  qa: '/ecs/sancus_minimal_backend_qa',
  prod: '/ecs/sancus_minimal_backend',
};

/** The Sancus app repos the read-only github tool may query. */
export const GITHUB_REPOS = [
  'sancus-minimal-backend',
  'sancus-minimal-frontend',
  'card-services-gateway',
] as const;
