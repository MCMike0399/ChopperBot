import { log } from '../../log.js';
import type { ToolHandlerResult, ToolSource, ToolSpec } from '../../tools/source.js';
import { GITHUB_REPOS } from './constants.js';

const API = 'https://api.github.com';
const REPOS: readonly string[] = GITHUB_REPOS;

/**
 * The github tool doc. Folded into the capability system prompt (see
 * preamble.ts) — the runtime agent loop does not read
 * ToolSource.systemPromptSection().
 */
export function githubDoc(): string {
  return `## github — read-only repo / PR / CI / deploy status

Query GitHub for the Sancus app repos (${REPOS.join(', ')}). Read-only. Use it for
"what's pending merge", "did the gate pass", "did prod deploy", "what changed on dev".
The \`action\` field selects the operation:
- \`list_prs\` (repo, [state=open]) — open/closed PRs with title, base, mergeable, checks summary.
- \`pr_checks\` (repo, pr_number) — CI/gate check runs for one PR.
- \`recent_runs\` (repo, [workflow], [branch]) — recent GitHub Actions runs (CD, gate, etc.) with conclusion.
- \`commits\` (repo, [branch=dev], [n=10]) — recent commits on a branch.`;
}

/** Read-only GitHub access for repo/PR/CI questions and deploy-status polling. */
export class GithubToolSource implements ToolSource {
  readonly name = 'github';
  private readonly token: string;
  private readonly org: string;

  constructor(token: string, org: string) {
    this.token = token;
    this.org = org;
  }

  private async gh(path: string): Promise<unknown> {
    if (!this.token) {
      throw new Error(
        'GitHub no está configurado (sin GITHUB_TOKEN ni `gh auth token`). Pídele a un admin que configure el acceso de solo-lectura.',
      );
    }
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'chopperbot-sancus-ops',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  private repo(name: string): string {
    const clean = String(name || '').trim();
    if (!REPOS.includes(clean)) {
      throw new Error(`repo must be one of: ${REPOS.join(', ')}`);
    }
    return `${this.org}/${clean}`;
  }

  async systemPromptSection(): Promise<string> {
    return githubDoc();
  }

  tools(): ToolSpec[] {
    return [
      {
        name: 'github',
        description:
          'Read-only GitHub queries for the Sancus repos (PRs, CI checks, Actions runs, commits). ' +
          "Use for release/deploy status and 'what's pending merge' questions.",
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list_prs', 'pr_checks', 'recent_runs', 'commits'],
              description: 'Which read to perform.',
            },
            repo: { type: 'string', enum: [...REPOS], description: 'Repository name.' },
            state: {
              type: 'string',
              enum: ['open', 'closed', 'all'],
              description: 'list_prs: PR state (default open).',
            },
            pr_number: { type: 'integer', description: 'pr_checks: the PR number.' },
            workflow: { type: 'string', description: 'recent_runs: workflow file name filter (optional).' },
            branch: {
              type: 'string',
              description: 'recent_runs/commits: branch filter (default dev for commits).',
            },
            n: { type: 'integer', description: 'commits: how many (default 10, max 30).' },
          },
          required: ['action', 'repo'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handle(name: string, input: unknown): Promise<ToolHandlerResult> {
    if (name !== 'github') return { status: 'error', payload: { error: `unknown tool "${name}"` } };
    const obj = (input ?? {}) as Record<string, unknown>;
    const action = String(obj.action || '');
    let repo: string;
    try {
      repo = this.repo(String(obj.repo || ''));
    } catch (err) {
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
    log.info({ action, repo }, 'github tool');

    try {
      switch (action) {
        case 'list_prs': {
          const state = ['open', 'closed', 'all'].includes(String(obj.state))
            ? String(obj.state)
            : 'open';
          const prs = (await this.gh(`/repos/${repo}/pulls?state=${state}&per_page=20`)) as any[];
          return {
            status: 'success',
            payload: prs.map((p) => ({
              number: p.number,
              title: p.title,
              state: p.state,
              base: p.base?.ref,
              head: p.head?.ref,
              draft: p.draft,
              mergeable_state: p.mergeable_state,
              url: p.html_url,
              updated_at: p.updated_at,
            })),
          };
        }
        case 'pr_checks': {
          const prNumber = Number(obj.pr_number);
          if (!prNumber) throw new Error('pr_number is required for pr_checks');
          const pr = (await this.gh(`/repos/${repo}/pulls/${prNumber}`)) as any;
          const sha = pr.head?.sha;
          const checks = (await this.gh(`/repos/${repo}/commits/${sha}/check-runs`)) as any;
          return {
            status: 'success',
            payload: {
              number: prNumber,
              title: pr.title,
              mergeable_state: pr.mergeable_state,
              checks: (checks.check_runs ?? []).map((c: any) => ({
                name: c.name,
                status: c.status,
                conclusion: c.conclusion,
              })),
            },
          };
        }
        case 'recent_runs': {
          const wf = obj.workflow ? `${encodeURIComponent(String(obj.workflow))}` : null;
          const branch = obj.branch ? `&branch=${encodeURIComponent(String(obj.branch))}` : '';
          const base = wf
            ? `/repos/${repo}/actions/workflows/${wf}/runs`
            : `/repos/${repo}/actions/runs`;
          const runs = (await this.gh(`${base}?per_page=15${branch}`)) as any;
          return {
            status: 'success',
            payload: (runs.workflow_runs ?? []).slice(0, 15).map((r: any) => ({
              name: r.name,
              branch: r.head_branch,
              event: r.event,
              status: r.status,
              conclusion: r.conclusion,
              created_at: r.created_at,
              title: r.display_title,
              url: r.html_url,
            })),
          };
        }
        case 'commits': {
          const branch = String(obj.branch || 'dev');
          const n = Math.min(Math.max(Number(obj.n) || 10, 1), 30);
          const commits = (await this.gh(
            `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`,
          )) as any[];
          return {
            status: 'success',
            payload: commits.map((c) => ({
              sha: c.sha?.slice(0, 7),
              message: c.commit?.message?.split('\n')[0],
              author: c.commit?.author?.name,
              date: c.commit?.author?.date,
            })),
          };
        }
        default:
          return { status: 'error', payload: { error: `unknown action "${action}"` } };
      }
    } catch (err) {
      return { status: 'error', payload: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}
