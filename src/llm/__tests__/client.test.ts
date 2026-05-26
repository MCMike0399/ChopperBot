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
import type { ComposedTools } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

function endStop(text: string) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
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
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

function fakeTools(
  handle?: (n: string, i: unknown) => Promise<{ status: 'success' | 'error'; payload: unknown }>,
): ComposedTools {
  return {
    tools: [],
    handle: vi.fn(handle ?? (async () => ({ status: 'success', payload: { ok: true } }))),
  };
}

describe('ask (Kimi / OpenAI-compatible agent loop)', () => {
  beforeEach(() => createMock.mockReset());

  test('returns text on a single end-of-turn response', async () => {
    createMock.mockResolvedValueOnce(endStop('hello'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(out).toBe('hello');
    expect(tools.handle).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('runs a tool call and continues to a final response', async () => {
    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 't1', name: 'search_knowledge', input: { query: 'spei' } }]),
      )
      .mockResolvedValueOnce(endStop('final answer'));
    const tools = fakeTools(async (name, input) => {
      expect(name).toBe('search_knowledge');
      expect(input).toEqual({ query: 'spei' });
      return { status: 'success', payload: { results: [] } };
    });
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'tell me about spei' }],
      tools,
    });
    expect(out).toBe('final answer');
    expect(tools.handle).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  test('runs multiple tool_calls in one turn (parallel within a single message)', async () => {
    createMock
      .mockResolvedValueOnce(
        toolCalls([
          { id: 't1', name: 'search_knowledge', input: { query: 'a' } },
          { id: 't2', name: 'search_knowledge', input: { query: 'b' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('done'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'go' }],
      tools,
    });
    expect(out).toBe('done');
    expect(tools.handle).toHaveBeenCalledTimes(2);

    // Each tool_call gets its own role:'tool' follow-up message.
    const secondReq = createMock.mock.calls[1][0] as { messages: Array<{ role: string; tool_call_id?: string }> };
    const toolMsgs = secondReq.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['t1', 't2']);
  });

  test('hits MAX_TOOL_ITERATIONS, then forces a final answer without tools', async () => {
    // Test config sets MAX_TOOL_ITERATIONS=5; emit 5 tool_calls then a forced text response.
    for (let i = 0; i < 5; i++) {
      createMock.mockResolvedValueOnce(
        toolCalls([{ id: `t${i}`, name: 'search_knowledge', input: { query: `q${i}` } }]),
      );
    }
    createMock.mockResolvedValueOnce(endStop('forced synthesis based on partial context'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'loop' }],
      tools,
    });
    expect(out).toBe('forced synthesis based on partial context');
    expect(createMock).toHaveBeenCalledTimes(6);

    // The forcing pass (call #6) must omit `tools` so the model can't call more.
    const forcingArgs = createMock.mock.calls[5][0] as { tools?: unknown };
    expect(forcingArgs.tools).toBeUndefined();
  });

  test('per-turn cache: identical (tool, input) pairs hit the cache on the second call', async () => {
    createMock
      .mockResolvedValueOnce(
        toolCalls([{ id: 'a', name: 'search_knowledge', input: { query: 'same' } }]),
      )
      .mockResolvedValueOnce(
        toolCalls([{ id: 'b', name: 'search_knowledge', input: { query: 'same' } }]),
      )
      .mockResolvedValueOnce(endStop('done'));
    const handle = vi.fn().mockResolvedValue({ status: 'success', payload: { ok: 1 } });
    const tools = { tools: [], handle } satisfies ComposedTools;
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'cache me' }],
      tools,
    });
    expect(out).toBe('done');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test('handles a tool_call with invalid JSON arguments by returning a tool error', async () => {
    createMock
      .mockResolvedValueOnce({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'bad',
                  type: 'function',
                  function: { name: 'search_knowledge', arguments: '{not json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
      .mockResolvedValueOnce(endStop('recovered'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'q' }],
      tools,
    });
    expect(out).toBe('recovered');
    // The handler should NOT have been called — args parsing failed.
    expect(tools.handle).not.toHaveBeenCalled();

    const followup = createMock.mock.calls[1][0] as { messages: Array<{ role: string; content?: string }> };
    const toolMsg = followup.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Invalid tool arguments');
  });

  test('propagates image attachments into the user message as image_url content parts', async () => {
    createMock.mockResolvedValueOnce(endStop('I see a red square.'));
    const tools = fakeTools();
    const img = new ImageAttachable('test.png', 'image/png', new Uint8Array([137, 80, 78, 71]), 'png');
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'What is this?', attachments: [img] }],
      tools,
    });
    expect(out).toBe('I see a red square.');
    expect(createMock).toHaveBeenCalledTimes(1);

    const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    // [system, user]
    expect(req.messages).toHaveLength(2);
    const userMsg = req.messages[1];
    expect(userMsg.role).toBe('user');
    const parts = userMsg.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'What is this?' });
    expect(parts[1]).toMatchObject({ type: 'image_url' });
    const img1 = parts[1] as { image_url: { url: string } };
    expect(img1.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('handles empty attachments array as no-op (plain string content)', async () => {
    createMock.mockResolvedValueOnce(endStop('ok'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'hi', attachments: [] }],
      tools,
    });
    expect(out).toBe('ok');
    const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(req.messages[1].content).toBe('hi');
  });
});
