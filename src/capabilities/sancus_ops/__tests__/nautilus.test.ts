import { describe, test, expect, vi } from 'vitest';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { runNautilusQuery, NautilusToolSource } from '../nautilus.js';
import { LOG_GROUPS } from '../constants.js';

const ENVS = ['dev', 'qa', 'prod'];

/**
 * Fake CloudWatchLogsClient: routes StartQueryCommand → a fixed queryId, and
 * GetQueryResultsCommand → a Complete result with one row. Records the last
 * StartQuery input so tests can assert clamping.
 */
function fakeClient(overrides?: { status?: string; results?: unknown }) {
  const captured: { startInput?: any } = {};
  const send = vi.fn(async (command: any) => {
    const kind = command.constructor.name;
    if (kind === 'StartQueryCommand') {
      captured.startInput = command.input;
      return { queryId: 'q-123' };
    }
    if (kind === 'GetQueryResultsCommand') {
      return {
        status: overrides?.status ?? 'Complete',
        statistics: { bytesScanned: 42 },
        results:
          overrides?.results ??
          [
            [
              { field: '@timestamp', value: '2026-07-16 00:00:00.000' },
              { field: 'errors', value: '7' },
              { field: '@ptr', value: 'SHOULD_BE_DROPPED' },
            ],
          ],
      };
    }
    throw new Error(`unexpected command ${kind}`);
  });
  return { client: { send } as unknown as CloudWatchLogsClient, send, captured };
}

describe('runNautilusQuery — argument validation', () => {
  test('rejects an env not in the allowlist (before any AWS call)', async () => {
    const { client, send } = fakeClient();
    await expect(
      runNautilusQuery(client, ENVS, { env: 'staging', query: 'fields @timestamp | limit 1' }),
    ).rejects.toThrow(/env must be one of/);
    expect(send).not.toHaveBeenCalled();
  });

  test('rejects an empty query (before any AWS call)', async () => {
    const { client, send } = fakeClient();
    await expect(runNautilusQuery(client, ENVS, { env: 'dev', query: '   ' })).rejects.toThrow(
      /query is required/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  test('maps env to the correct log group', async () => {
    const { client, captured } = fakeClient();
    const res = await runNautilusQuery(client, ENVS, { env: 'prod', query: 'fields @timestamp | limit 1' });
    expect(res.logGroup).toBe(LOG_GROUPS.prod);
    expect(captured.startInput.logGroupName).toBe(LOG_GROUPS.prod);
  });

  test('clamps limit to [1,50] and range to <= 7 days', async () => {
    const { client, captured } = fakeClient();
    await runNautilusQuery(client, ENVS, {
      env: 'dev',
      query: 'fields @timestamp | limit 999',
      limit: 9999,
      start_relative_minutes: 999_999,
    });
    expect(captured.startInput.limit).toBe(50);
    const spanMinutes = (captured.startInput.endTime - captured.startInput.startTime) / 60;
    expect(spanMinutes).toBe(7 * 24 * 60);
  });

  test('drops @ptr and returns parsed rows on Complete', async () => {
    const { client } = fakeClient();
    const res = await runNautilusQuery(client, ENVS, { env: 'dev', query: 'x | limit 1' });
    expect(res.status).toBe('Complete');
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toEqual({ '@timestamp': '2026-07-16 00:00:00.000', errors: '7' });
    expect(res.rows[0]['@ptr']).toBeUndefined();
  });
});

describe('NautilusToolSource — tool spec + handler', () => {
  test('exposes exactly the read-only nautilus_query tool', () => {
    const { client } = fakeClient();
    const src = new NautilusToolSource(client, ENVS);
    const tools = src.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('nautilus_query');
  });

  test('handle returns success payload on Complete', async () => {
    const { client } = fakeClient();
    const src = new NautilusToolSource(client, ENVS);
    const out = await src.handle('nautilus_query', { env: 'dev', query: 'x | limit 1' });
    expect(out.status).toBe('success');
  });

  test('handle returns an error (not a throw) on a bad env', async () => {
    const { client } = fakeClient();
    const src = new NautilusToolSource(client, ENVS);
    const out = await src.handle('nautilus_query', { env: 'nope', query: 'x | limit 1' });
    expect(out.status).toBe('error');
  });

  test('handle surfaces a non-Complete query status as an error', async () => {
    const { client } = fakeClient({ status: 'Failed' });
    const src = new NautilusToolSource(client, ENVS);
    const out = await src.handle('nautilus_query', { env: 'dev', query: 'x | limit 1' });
    expect(out.status).toBe('error');
  });

  test('systemPromptSection embeds the wide-event schema + recipes', async () => {
    const { client } = fakeClient();
    const src = new NautilusToolSource(client, ENVS);
    const doc = await src.systemPromptSection();
    expect(doc).toContain('wide event');
    expect(doc).toContain('provider_status');
  });
});
