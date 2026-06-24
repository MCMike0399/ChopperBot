/**
 * Wire-shape contract tests for the Bedrock Converse request payload. These
 * pin down the exact JSON we send so future contributors don't silently
 * regress the integration. Mocks the AWS SDK; no network.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

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
import type { ComposedTools, ToolSpec } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

function reqAt(i: number): Record<string, unknown> {
  return (sendMock.mock.calls[i][0] as { input: Record<string, unknown> }).input;
}

function endStop(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 5 },
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
    usage: { inputTokens: 5, outputTokens: 5 },
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
  beforeEach(() => sendMock.mockReset());

  test('system prompt is a separate Converse `system` field; user turn leads messages', async () => {
    sendMock.mockResolvedValueOnce(endStop('hi'));
    await ask({
      system: 'YOU ARE A BOT',
      messages: [{ role: 'user', content: 'q' }],
      tools: toolsWithSample(),
    });
    const req = reqAt(0);
    expect(req.system).toEqual([{ text: 'YOU ARE A BOT' }]);
    expect((req.messages as Array<{ role: string; content: unknown }>)[0]).toEqual({
      role: 'user',
      content: [{ text: 'q' }],
    });
  });

  test('tools serialize as { toolSpec: { name, description, inputSchema: { json } } }', async () => {
    sendMock.mockResolvedValueOnce(endStop('hi'));
    await ask({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: toolsWithSample() });
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

  test('modelId and maxTokens forwarded; no sampling params set', async () => {
    sendMock.mockResolvedValueOnce(endStop('hi'));
    await ask({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: toolsWithSample() });
    const req = reqAt(0);
    expect(req.modelId).toBe('test-model');
    const ic = req.inferenceConfig as { maxTokens: number; temperature?: number; topP?: number };
    expect(ic.maxTokens).toBe(4096);
    expect(ic.temperature).toBeUndefined();
    expect(ic.topP).toBeUndefined();
  });

  test('tool result follow-up: one toolResult block per call, in order, JSON-encoded payload', async () => {
    sendMock
      .mockResolvedValueOnce(
        toolUse([
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
    const followup = reqAt(1).messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const resultMsg = followup.find((m) => m.role === 'user' && m.content.some((b) => 'toolResult' in b));
    const results = (resultMsg!.content as Array<{ toolResult: { toolUseId: string; content: Array<{ text: string }> } }>)
      .filter((b) => b.toolResult)
      .map((b) => b.toolResult);
    expect(results).toHaveLength(2);
    expect(results[0].toolUseId).toBe('aaa');
    expect(results[1].toolUseId).toBe('bbb');
    const first = JSON.parse(results[0].content[0].text) as { echoed: { query: string } };
    expect(first.echoed.query).toBe('one');
  });

  test('image attachments serialize as { image: { format, source: { bytes } } }', async () => {
    sendMock.mockResolvedValueOnce(endStop('ok'));
    const img = new ImageAttachable('a.png', 'image/png', new Uint8Array([1, 2, 3]), 'png');
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'see this', attachments: [img] }],
      tools: toolsWithSample(),
    });
    const parts = (reqAt(0).messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(parts[0]).toEqual({ text: 'see this' });
    expect(parts[1]).toMatchObject({ image: { format: 'png' } });
    const bytes = (parts[1] as { image: { source: { bytes: Uint8Array } } }).image.source.bytes;
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('forcing pass omits `toolConfig` when iteration cap hits while still calling tools', async () => {
    for (let i = 0; i < 5; i++) {
      sendMock.mockResolvedValueOnce(
        toolUse([{ id: `t${i}`, name: 'sample_tool', input: { query: `q${i}` } }]),
      );
    }
    sendMock.mockResolvedValueOnce(endStop('forced'));
    await ask({
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: { tools: [SAMPLE_SPEC], handle: async () => ({ status: 'success', payload: { ok: true } }) },
    });
    for (let i = 0; i < 5; i++) expect(reqAt(i).toolConfig).toBeDefined();
    expect(reqAt(5).toolConfig).toBeUndefined();
  });
});
