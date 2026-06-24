import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the Bedrock SDK. client.send(new ConverseCommand(input)) → sendMock is
// called with the command instance; we read its `.input` to inspect the
// request we sent.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
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
import type { ComposedTools } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

/** The Converse request we sent for the i-th send() call. */
function reqAt(i: number): { messages: Array<{ role: string; content: unknown[] }>; toolConfig?: unknown; system?: unknown } {
  return (sendMock.mock.calls[i][0] as { input: unknown }).input as never;
}

function endStop(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function toolUse(calls: Array<{ id: string; name: string; input: unknown }>) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } })),
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 2 },
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

/** Pull the toolResult blocks out of whichever user turn carries them. */
function toolResultBlocks(req: { messages: Array<{ role: string; content: unknown[] }> }) {
  const withResults = req.messages.find((m) =>
    m.role === 'user' && (m.content as Array<Record<string, unknown>>).some((b) => 'toolResult' in b),
  );
  return ((withResults?.content ?? []) as Array<{ toolResult?: { toolUseId: string; content: Array<{ text: string }> } }>)
    .filter((b) => b.toolResult)
    .map((b) => b.toolResult!);
}

describe('ask (Bedrock Converse agent loop)', () => {
  beforeEach(() => sendMock.mockReset());

  test('returns text on a single end-of-turn response', async () => {
    sendMock.mockResolvedValueOnce(endStop('hello'));
    const tools = fakeTools();
    const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'hi' }], tools });
    expect(out).toBe('hello');
    expect(tools.handle).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('runs a tool call and continues to a final response', async () => {
    sendMock
      .mockResolvedValueOnce(toolUse([{ id: 't1', name: 'search_knowledge', input: { query: 'spei' } }]))
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
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  test('runs multiple tool calls in one turn (one toolResult block each, in order)', async () => {
    sendMock
      .mockResolvedValueOnce(
        toolUse([
          { id: 't1', name: 'search_knowledge', input: { query: 'a' } },
          { id: 't2', name: 'search_knowledge', input: { query: 'b' } },
        ]),
      )
      .mockResolvedValueOnce(endStop('done'));
    const tools = fakeTools();
    const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'go' }], tools });
    expect(out).toBe('done');
    expect(tools.handle).toHaveBeenCalledTimes(2);

    const results = toolResultBlocks(reqAt(1));
    expect(results.map((r) => r.toolUseId)).toEqual(['t1', 't2']);
  });

  test('hits MAX_TOOL_ITERATIONS, then forces a final answer without tools', async () => {
    for (let i = 0; i < 5; i++) {
      sendMock.mockResolvedValueOnce(
        toolUse([{ id: `t${i}`, name: 'search_knowledge', input: { query: `q${i}` } }]),
      );
    }
    sendMock.mockResolvedValueOnce(endStop('forced synthesis based on partial context'));
    const tools = fakeTools();
    const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'loop' }], tools });
    expect(out).toBe('forced synthesis based on partial context');
    expect(sendMock).toHaveBeenCalledTimes(6);

    // The forcing pass (call #6) must omit `toolConfig`.
    expect(reqAt(5).toolConfig).toBeUndefined();
  });

  test('per-turn cache: identical (tool, input) pairs hit the cache on the second call', async () => {
    sendMock
      .mockResolvedValueOnce(toolUse([{ id: 'a', name: 'search_knowledge', input: { query: 'same' } }]))
      .mockResolvedValueOnce(toolUse([{ id: 'b', name: 'search_knowledge', input: { query: 'same' } }]))
      .mockResolvedValueOnce(endStop('done'));
    const handle = vi.fn().mockResolvedValue({ status: 'success', payload: { ok: 1 } });
    const tools = { tools: [], handle } satisfies ComposedTools;
    const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'cache me' }], tools });
    expect(out).toBe('done');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test('a malformed tool_use (missing name) yields an error toolResult, handler not called', async () => {
    sendMock
      .mockResolvedValueOnce({
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 'bad', input: {} } }], // no name
          },
        },
        stopReason: 'tool_use',
      })
      .mockResolvedValueOnce(endStop('recovered'));
    const tools = fakeTools();
    const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'q' }], tools });
    expect(out).toBe('recovered');
    expect(tools.handle).not.toHaveBeenCalled();

    const results = toolResultBlocks(reqAt(1));
    expect(results[0].toolUseId).toBe('bad');
    expect(results[0].content[0].text).toContain('Malformed tool_use');
  });

  test('propagates image attachments into the user message as Converse image blocks', async () => {
    sendMock.mockResolvedValueOnce(endStop('I see a red square.'));
    const tools = fakeTools();
    const img = new ImageAttachable('test.png', 'image/png', new Uint8Array([137, 80, 78, 71]), 'png');
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'What is this?', attachments: [img] }],
      tools,
    });
    expect(out).toBe('I see a red square.');
    expect(sendMock).toHaveBeenCalledTimes(1);

    const req = reqAt(0);
    expect(req.messages).toHaveLength(1); // system is a separate field, not a message
    const parts = req.messages[0].content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ text: 'What is this?' });
    expect(parts[1]).toMatchObject({ image: { format: 'png' } });
    const imgPart = parts[1] as { image: { source: { bytes: Uint8Array } } };
    expect(imgPart.image.source.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  test('handles empty attachments array as a plain text content block', async () => {
    sendMock.mockResolvedValueOnce(endStop('ok'));
    const tools = fakeTools();
    const out = await ask({
      system: 'p',
      messages: [{ role: 'user', content: 'hi', attachments: [] }],
      tools,
    });
    expect(out).toBe('ok');
    expect(reqAt(0).messages[0].content).toEqual([{ text: 'hi' }]);
  });

  test('effort tier selects the matching BEDROCK model id', async () => {
    const modelOf = (i: number) => (reqAt(i) as unknown as { modelId: string }).modelId;
    const tools = fakeTools();

    sendMock.mockResolvedValueOnce(endStop('a'));
    await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools, effort: 'low' });
    expect(modelOf(0)).toBe(config.BEDROCK_MODEL_LOW);

    sendMock.mockResolvedValueOnce(endStop('b'));
    await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools, effort: 'medium' });
    expect(modelOf(1)).toBe(config.BEDROCK_MODEL_MEDIUM);

    sendMock.mockResolvedValueOnce(endStop('c'));
    await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools, effort: 'high' });
    expect(modelOf(2)).toBe(config.BEDROCK_MODEL_ID);

    // Default (no effort) is high.
    sendMock.mockResolvedValueOnce(endStop('d'));
    await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools });
    expect(modelOf(3)).toBe(config.BEDROCK_MODEL_ID);
  });
});
