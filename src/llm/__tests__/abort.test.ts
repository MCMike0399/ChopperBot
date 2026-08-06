/**
 * ask() — cooperative cancellation via `shouldAbort` (workshop interrupt
 * semantics: a newer message from the session owner stops the running turn at
 * its next step instead of letting it grind through the iteration cap).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { ask, TurnAbortedError } from '../client.js';
import { composeToolSources, type ToolSource } from '../../tools/source.js';

function kimiText(content: string) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function kimiToolCall(name: string, id = 'tc-1') {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const echoSource: ToolSource = {
  name: 'echo',
  systemPromptSection: async () => '',
  tools: () => [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }],
  handle: async () => ({ status: 'success', payload: { ok: true } }),
};

function baseInput(shouldAbort: () => boolean) {
  return {
    system: 'system',
    messages: [{ role: 'user' as const, content: 'hola' }],
    tools: composeToolSources([echoSource]),
    shouldAbort,
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('ask() — shouldAbort', () => {
  test('abort before the first request throws without calling the API', async () => {
    await expect(ask(baseInput(() => true))).rejects.toThrow(TurnAbortedError);
    expect(createMock).toHaveBeenCalledTimes(0);
  });

  test('abort between iterations stops the loop before the next request', async () => {
    let aborted = false;
    createMock.mockImplementationOnce(async () => {
      // The abort lands while the first response's tools are about to run…
      aborted = true;
      return kimiToolCall('echo');
    });
    await expect(ask(baseInput(() => aborted))).rejects.toThrow(TurnAbortedError);
    // …so the tool never executes a second model request.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('a turn that never aborts completes normally', async () => {
    createMock
      .mockResolvedValueOnce(kimiToolCall('echo'))
      .mockResolvedValueOnce(kimiText('listo'));
    const out = await ask(baseInput(() => false));
    expect(out).toBe('listo');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
