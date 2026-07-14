/**
 * Wire-shape contract tests. Pin down the exact JSON we send to each backend so
 * future contributors don't silently regress the integration. Two backends:
 * Kimi (OpenAI chat-completions) on the text path, Bedrock (Converse) on the
 * vision path. Mocks both SDKs; no network.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { kimiMock, sendMock } = vi.hoisted(() => ({ kimiMock: vi.fn(), sendMock: vi.fn() }));
vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: kimiMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: OpenAI };
});
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send = sendMock;
    constructor(_opts?: unknown) {}
  }
  class ConverseCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient, ConverseCommand };
});

const { ask } = await import('../client.js');
import { config } from '../../config.js';
import type { ComposedTools, ToolSpec } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

const SAMPLE_SPEC: ToolSpec = {
  name: 'sample_tool',
  description: 'A sample tool used in contract tests.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function toolsWithSample(): ComposedTools {
  return {
    tools: [SAMPLE_SPEC],
    handle: async () => ({ status: 'success', payload: { hits: 0 } }),
  };
}

// ── Kimi (OpenAI chat-completions) wire ──────────────────────────────────────
describe('Kimi wire contract (text path)', () => {
  beforeEach(() => kimiMock.mockReset());

  function end(text: string) {
    return {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    };
  }
  function toolCalls(calls: Array<{ id: string; name: string; input: unknown }>) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    };
  }
  function reqAt(i: number): Record<string, unknown> {
    return kimiMock.mock.calls[i][0] as Record<string, unknown>;
  }

  test('system prompt is the leading role:system message; user turn follows', async () => {
    kimiMock.mockResolvedValueOnce(end('hi'));
    await ask({ system: 'YOU ARE A BOT', messages: [{ role: 'user', content: 'q' }], tools: toolsWithSample() });
    const msgs = reqAt(0).messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'YOU ARE A BOT' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'q' });
  });

  test('tools serialize as { type:function, function:{ name, description, parameters } }', async () => {
    kimiMock.mockResolvedValueOnce(end('hi'));
    await ask({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: toolsWithSample() });
    const tools = reqAt(0).tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'sample_tool',
        description: 'A sample tool used in contract tests.',
        parameters: SAMPLE_SPEC.inputSchema,
      },
    });
  });

  test('model and max_tokens forwarded; no sampling params set', async () => {
    kimiMock.mockResolvedValueOnce(end('hi'));
    await ask({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: toolsWithSample() });
    const req = reqAt(0);
    expect(req.model).toBe(config.KIMI_MODEL_ID);
    expect(req.max_tokens).toBe(4096);
    expect(req.temperature).toBeUndefined();
    expect(req.top_p).toBeUndefined();
  });

  test('tool result follow-up: one role:tool message per call, in order, JSON-encoded payload', async () => {
    kimiMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'aaa', name: 'sample_tool', input: { query: 'one' } },
          { id: 'bbb', name: 'sample_tool', input: { query: 'two' } },
        ]),
      )
      .mockResolvedValueOnce(end('done'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: {
        tools: [SAMPLE_SPEC],
        handle: async (_n, input) => ({ status: 'success', payload: { echoed: input } }),
      },
    });
    const followup = reqAt(1).messages as Array<{ role: string; tool_call_id?: string; content: string }>;
    const results = followup.filter((m) => m.role === 'tool');
    expect(results).toHaveLength(2);
    expect(results[0].tool_call_id).toBe('aaa');
    expect(results[1].tool_call_id).toBe('bbb');
    const first = JSON.parse(results[0].content) as { echoed: { query: string } };
    expect(first.echoed.query).toBe('one');
  });

  test('forcing pass omits `tools` when the iteration cap hits while still calling tools', async () => {
    for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
      kimiMock.mockResolvedValueOnce(toolCalls([{ id: `t${i}`, name: 'sample_tool', input: { query: `q${i}` } }]));
    }
    kimiMock.mockResolvedValueOnce(end('forced'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: { tools: [SAMPLE_SPEC], handle: async () => ({ status: 'success', payload: { ok: true } }) },
    });
    for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) expect(reqAt(i).tools).toBeDefined();
    expect(reqAt(config.MAX_TOOL_ITERATIONS).tools).toBeUndefined();
  });
});

// ── Bedrock (Converse) wire — vision path ─────────────────────────────────────
describe('Bedrock wire contract (vision path)', () => {
  beforeEach(() => sendMock.mockReset());

  function end(text: string) {
    return {
      output: { message: { role: 'assistant', content: [{ text }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 5 },
    };
  }
  function reqAt(i: number): Record<string, unknown> {
    return (sendMock.mock.calls[i][0] as { input: Record<string, unknown> }).input;
  }
  const img = () => new ImageAttachable('a.png', 'image/png', new Uint8Array([1, 2, 3]), 'png');

  test('image attachments serialize as { image: { format, source: { bytes } } }; system is a separate field', async () => {
    sendMock.mockResolvedValueOnce(end('ok'));
    await ask({
      system: 'YOU ARE A BOT',
      messages: [{ role: 'user', content: 'see this', attachments: [img()] }],
      tools: toolsWithSample(),
    });
    const req = reqAt(0);
    expect(req.system).toEqual([{ text: 'YOU ARE A BOT' }]);
    const parts = (req.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(parts[0]).toEqual({ text: 'see this' });
    expect(parts[1]).toMatchObject({ image: { format: 'png' } });
    const bytes = (parts[1] as { image: { source: { bytes: Uint8Array } } }).image.source.bytes;
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('modelId is the Nova Lite vision model; maxTokens forwarded; no sampling params', async () => {
    sendMock.mockResolvedValueOnce(end('ok'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q', attachments: [img()] }],
      tools: toolsWithSample(),
    });
    const req = reqAt(0);
    expect(req.modelId).toBe(config.BEDROCK_MODEL_LOW);
    const ic = req.inferenceConfig as { maxTokens: number; temperature?: number; topP?: number };
    expect(ic.maxTokens).toBe(4096);
    expect(ic.temperature).toBeUndefined();
    expect(ic.topP).toBeUndefined();
  });

  test('tools serialize as { toolSpec: { name, description, inputSchema: { json } } }', async () => {
    sendMock.mockResolvedValueOnce(end('hi'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q', attachments: [img()] }],
      tools: toolsWithSample(),
    });
    const tc = reqAt(0).toolConfig as { tools: Array<Record<string, unknown>> };
    expect(tc.tools).toHaveLength(1);
    expect(tc.tools[0]).toEqual({
      toolSpec: {
        name: 'sample_tool',
        description: 'A sample tool used in contract tests.',
        inputSchema: { json: SAMPLE_SPEC.inputSchema },
      },
    });
  });
});
