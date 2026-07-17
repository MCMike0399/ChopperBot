import { describe, test, expect, vi, afterEach } from 'vitest';
import { GithubToolSource } from '../github.js';
import { GITHUB_REPOS } from '../constants.js';

const ORG = 'deep-dive-mexico';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GithubToolSource — read-only tool', () => {
  test('exposes exactly one tool named github with only read actions', () => {
    const src = new GithubToolSource('t0ken', ORG);
    const tools = src.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('github');
    const actionEnum = (tools[0].inputSchema as any).properties.action.enum;
    expect(actionEnum.sort()).toEqual(['commits', 'list_prs', 'pr_checks', 'recent_runs'].sort());
    // No mutating verbs leak in.
    for (const a of actionEnum) {
      expect(a).not.toMatch(/create|delete|merge|update|close|dispatch/);
    }
  });

  test('repo enum is restricted to the three Sancus repos', () => {
    const src = new GithubToolSource('t0ken', ORG);
    const repoEnum = (src.tools()[0].inputSchema as any).properties.repo.enum;
    expect(repoEnum.sort()).toEqual([...GITHUB_REPOS].sort());
  });

  test('rejects a repo outside the allowlist (returns error, no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const src = new GithubToolSource('t0ken', ORG);
    const out = await src.handle('github', { action: 'list_prs', repo: 'some-other-repo' });
    expect(out.status).toBe('error');
    expect((out.payload as any).error).toMatch(/repo must be one of/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects an unknown action', async () => {
    const src = new GithubToolSource('t0ken', ORG);
    const out = await src.handle('github', { action: 'delete_repo', repo: GITHUB_REPOS[0] });
    expect(out.status).toBe('error');
  });

  test('degrades gracefully with no token', async () => {
    const src = new GithubToolSource('', ORG);
    const out = await src.handle('github', { action: 'list_prs', repo: GITHUB_REPOS[0] });
    expect(out.status).toBe('error');
    expect((out.payload as any).error).toMatch(/no está configurado|GITHUB_TOKEN/i);
  });

  test('list_prs maps the GitHub response to a compact shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            number: 42,
            title: 'feat: x',
            state: 'open',
            base: { ref: 'dev' },
            head: { ref: 'feat/x' },
            draft: false,
            mergeable_state: 'clean',
            html_url: 'https://github.com/x/42',
            updated_at: '2026-07-16T00:00:00Z',
          },
        ]),
        { status: 200 },
      ),
    );
    const src = new GithubToolSource('t0ken', ORG);
    const out = await src.handle('github', { action: 'list_prs', repo: GITHUB_REPOS[0] });
    expect(out.status).toBe('success');
    expect((out.payload as any[])[0]).toMatchObject({ number: 42, base: 'dev', head: 'feat/x' });
  });

  test('sends only GET-shaped read requests (Authorization bearer, no method/body)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const src = new GithubToolSource('t0ken', ORG);
    await src.handle('github', { action: 'commits', repo: GITHUB_REPOS[1], branch: 'dev', n: 3 });
    const [, init] = fetchSpy.mock.calls[0];
    // No method override => GET; no body => read-only.
    expect((init as RequestInit)?.method).toBeUndefined();
    expect((init as RequestInit)?.body).toBeUndefined();
    expect(((init as RequestInit)?.headers as Record<string, string>).Authorization).toContain('Bearer');
  });
});
