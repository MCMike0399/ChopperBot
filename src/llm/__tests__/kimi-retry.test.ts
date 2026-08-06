/**
 * askKimi — empty-response retry. K2.7 Thinking sometimes spends every output
 * token on `reasoning_content` and returns empty `content` with
 * finish_reason 'stop' (observed live 2026-08-05: the fallback string was
 * posted to Discord as the reply). The client must retry the same convo a
 * bounded number of times, and the last-resort fallback must be Spanish.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { ask } from '../client.js';
import { composeToolSources } from '../../tools/source.js';

const NO_TOOLS = composeToolSources([]);

function kimiResponse(content: string | null, finishReason = 'stop') {
  return {
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function baseInput() {
  return {
    system: 'system',
    messages: [{ role: 'user' as const, content: 'hola' }],
    tools: NO_TOOLS,
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('askKimi — empty-response retry', () => {
  test('a normal reply is returned as-is, single call', async () => {
    createMock.mockResolvedValueOnce(kimiResponse('¡Hola, compa!'));
    const out = await ask(baseInput());
    expect(out).toBe('¡Hola, compa!');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('empty content on a stop finish retries and returns the later text', async () => {
    createMock
      .mockResolvedValueOnce(kimiResponse(''))
      .mockResolvedValueOnce(kimiResponse('Aquí la respuesta.'));
    const out = await ask(baseInput());
    expect(out).toBe('Aquí la respuesta.');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  test('null content counts as empty and is retried', async () => {
    createMock
      .mockResolvedValueOnce(kimiResponse(null))
      .mockResolvedValueOnce(kimiResponse('Va de nuevo.'));
    const out = await ask(baseInput());
    expect(out).toBe('Va de nuevo.');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  test('persistent empty responses give up after 2 retries with the Spanish fallback', async () => {
    createMock.mockResolvedValue(kimiResponse(''));
    const out = await ask(baseInput());
    expect(out).toContain('No pude generar una respuesta');
    expect(out).not.toContain("couldn't");
    // 1 initial + 2 retries.
    expect(createMock).toHaveBeenCalledTimes(3);
  });
});
