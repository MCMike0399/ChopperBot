/**
 * askKimi — forcing-pass hardening (live 2026-08-06, workshop whole-book
 * summary): the model burned all 10 iterations on tool calls; the forced
 * tools-free pass then came back `finish_reason: 'tool_calls'` AGAIN (Kimi
 * keeps calling tools from history even with none advertised) and the user
 * got the empty-response fallback. The forcing pass must (a) always carry the
 * prose nudge — not only for degenerate output — and (b) get one bounded
 * retry when it still misfires.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { ask } from '../client.js';
import { config } from '../../config.js';
import { composeToolSources, type ToolSource } from '../../tools/source.js';

const STUB_SOURCE: ToolSource = {
  name: 'stub',
  systemPromptSection: async () => '',
  tools: () => [
    { name: 'stub_tool', description: 'stub', inputSchema: { type: 'object', properties: {} } },
  ],
  handle: async () => ({ status: 'success', payload: { ok: true } }),
};

const TOOLS = composeToolSources([STUB_SOURCE]);

function toolCallsResponse(id: string) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name: 'stub_tool', arguments: '{}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function textResponse(content: string) {
  return {
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function baseInput() {
  return {
    system: 'system',
    messages: [{ role: 'user' as const, content: 'explícame el libro por capítulos' }],
    tools: TOOLS,
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('askKimi — forcing pass after the iteration cap', () => {
  test('a forcing pass that still returns tool_calls gets one nudged retry', async () => {
    let n = 0;
    createMock.mockImplementation(async () => {
      n += 1;
      // All loop iterations AND the first forcing pass keep calling tools.
      if (n <= config.MAX_TOOL_ITERATIONS + 1) return toolCallsResponse(`call_${n}`);
      return textResponse('Llevo los capítulos 1–3; dime "sigue".');
    });

    const out = await ask(baseInput());

    expect(out).toBe('Llevo los capítulos 1–3; dime "sigue".');
    // 10 loop iterations + 2 forcing passes.
    expect(n).toBe(config.MAX_TOOL_ITERATIONS + 2);

    // Every forcing pass runs WITHOUT tools and WITH the prose nudge.
    const forcingCall1 = createMock.mock.calls[config.MAX_TOOL_ITERATIONS][0];
    expect(forcingCall1.tools).toBeUndefined();
    expect(forcingCall1.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('sin llamar herramientas'),
    });
    const forcingCall2 = createMock.mock.calls[config.MAX_TOOL_ITERATIONS + 1][0];
    expect(forcingCall2.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Último intento'),
    });
  });

  test('two misfired forcing passes fall back to the Spanish empty message', async () => {
    createMock.mockImplementation(async () => toolCallsResponse('call_x'));
    const out = await ask(baseInput());
    expect(out).toContain('No pude generar una respuesta');
    expect(createMock).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS + 2);
  });

  test('a forcing pass that answers text on the first try needs no retry', async () => {
    let n = 0;
    createMock.mockImplementation(async () => {
      n += 1;
      if (n <= config.MAX_TOOL_ITERATIONS) return toolCallsResponse(`call_${n}`);
      return textResponse('Resumen de lo logrado.');
    });
    const out = await ask(baseInput());
    expect(out).toBe('Resumen de lo logrado.');
    expect(n).toBe(config.MAX_TOOL_ITERATIONS + 1);
  });
});
