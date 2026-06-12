/**
 * Wire-shape contract tests for the Kimi/OpenAI request payload. These pin
 * down the exact JSON we send so future contributors don't silently regress
 * the integration. Mocks `openai`; no network.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const { ask } = await import('../client.js');
import type { ComposedTools, ToolSpec } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

function endStop(text: string) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
}

function toolCalls(calls: Array<{ id: string; name: string; input: unknown }>) {
  return {
    choices: [
      {
        index: 0,
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

describe('wire contract', () => {
  beforeEach(() => createMock.mockReset());

  test('first request: system prompt is the leading message', async () => {
    createMock.mockResolvedValueOnce(endStop('hi'));
    await ask({
      system: 'YOU ARE A BOT',
      messages: [{ role: 'user', content: 'q' }],
      tools: toolsWithSample(),
    });
    const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(req.messages[0]).toEqual({ role: 'system', content: 'YOU ARE A BOT' });
  });

  test('tools are serialized as { type:"function", function:{ name, description, parameters } }', async () => {
    createMock.mockResolvedValueOnce(endStop('hi'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: toolsWithSample(),
    });
    const req = createMock.mock.calls[0][0] as { tools: Array<Record<string, unknown>> };
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'sample_tool',
        description: 'A sample tool used in contract tests.',
        parameters: SAMPLE_SPEC.inputSchema,
      },
    });
  });

  test('model id and max_tokens forwarded; temperature omitted (K2.7 rejects ≠1)', async () => {
    createMock.mockResolvedValueOnce(endStop('hi'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: toolsWithSample(),
    });
    const req = createMock.mock.calls[0][0] as { model: string; temperature?: number; max_tokens: number };
    expect(req.model).toBe('test-model');
    expect(req.temperature).toBeUndefined();
    expect(req.max_tokens).toBe(4096);
  });

  test('tool result follow-up: one role:"tool" message per tool_call, in call order', async () => {
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 'aaa', name: 'sample_tool', input: { query: 'one' } },
          { id: 'bbb', name: 'sample_tool', input: { query: 'two' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('done'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: {
        tools: [SAMPLE_SPEC],
        handle: async (_n, input) => ({ status: 'success', payload: { echoed: input } }),
      },
    });
    const followup = createMock.mock.calls[1][0] as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
    const toolMsgs = followup.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].tool_call_id).toBe('aaa');
    expect(toolMsgs[1].tool_call_id).toBe('bbb');
    // Tool content is JSON-encoded payload from the handler.
    const first = JSON.parse(toolMsgs[0].content!) as { echoed: { query: string } };
    expect(first.echoed.query).toBe('one');
  });

  test('image attachments serialize as { type:"image_url", image_url:{ url: "data:...;base64,..." } }', async () => {
    createMock.mockResolvedValueOnce(endStop('ok'));
    const img = new ImageAttachable('a.png', 'image/png', new Uint8Array([1, 2, 3]), 'png');
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'see this', attachments: [img] }],
      tools: toolsWithSample(),
    });
    const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = req.messages[1];
    const parts = userMsg.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'see this' });
    expect(parts[1]).toMatchObject({ type: 'image_url' });
    const url = (parts[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(url).toContain(Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'));
  });

  test('forcing pass omits the `tools` field when iteration cap hits while still calling tools', async () => {
    // MAX_TOOL_ITERATIONS is 5 in the test env.
    for (let i = 0; i < 5; i++) {
      createMock.mockResolvedValueOnce(
        toolCalls([{ id: `t${i}`, name: 'sample_tool', input: { query: `q${i}` } }]),
      );
    }
    createMock.mockResolvedValueOnce(endStop('forced'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        tools: [SAMPLE_SPEC],
        handle: async () => ({ status: 'success', payload: { ok: true } }),
      },
    });
    // First five had tools set; the sixth (forcing pass) does not.
    for (let i = 0; i < 5; i++) {
      const req = createMock.mock.calls[i][0] as { tools?: unknown };
      expect(req.tools).toBeDefined();
    }
    const forcingReq = createMock.mock.calls[5][0] as { tools?: unknown };
    expect(forcingReq.tools).toBeUndefined();
  });
});
