import { describe, test, expect, vi, beforeEach } from 'vitest';

// Two backends. The "high" text path runs on Kimi via the OpenAI SDK; anything
// with an image (and effort medium/low) runs on Bedrock. Mock both.
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
import type { ComposedTools } from '../../tools/source.js';
import { ImageAttachable } from '../../attachments/attachable.js';

function fakeTools(
  handle?: (n: string, i: unknown) => Promise<{ status: 'success' | 'error'; payload: unknown }>,
): ComposedTools {
  return {
    tools: [],
    handle: vi.fn(handle ?? (async () => ({ status: 'success', payload: { ok: true } }))),
  };
}

// ── Kimi (OpenAI-compatible) helpers ─────────────────────────────────────────
function kimiEnd(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}
function kimiToolCalls(calls: Array<{ id: string; name?: string; input: unknown }>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { ...(c.name ? { name: c.name } : {}), arguments: JSON.stringify(c.input) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}
/** The Kimi request object for the i-th create() call. */
function kimiReqAt(i: number): {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: unknown[];
} {
  return kimiMock.mock.calls[i][0] as never;
}
/** role:'tool' messages in the i-th Kimi request. */
function kimiToolMsgs(i: number): Array<{ tool_call_id: string; content: string }> {
  return kimiReqAt(i).messages.filter((m) => m.role === 'tool') as never;
}

// ── Bedrock (Converse) helpers ───────────────────────────────────────────────
function bedrockEnd(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
/** The Converse request we sent for the i-th send() call. */
function bedrockReqAt(i: number): { messages: Array<{ role: string; content: unknown[] }>; modelId: string; toolConfig?: unknown } {
  return (sendMock.mock.calls[i][0] as { input: unknown }).input as never;
}

describe('ask — routing between Kimi (text) and Bedrock (vision)', () => {
  beforeEach(() => {
    kimiMock.mockReset();
    sendMock.mockReset();
  });

  describe('Kimi text path (effort high, no images)', () => {
    test('returns text on a single end-of-turn response', async () => {
      kimiMock.mockResolvedValueOnce(kimiEnd('hello'));
      const tools = fakeTools();
      const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'hi' }], tools });
      expect(out).toBe('hello');
      expect(tools.handle).not.toHaveBeenCalled();
      expect(kimiMock).toHaveBeenCalledTimes(1);
      expect(sendMock).not.toHaveBeenCalled();
    });

    test('runs a tool call and continues to a final response', async () => {
      kimiMock
        .mockResolvedValueOnce(kimiToolCalls([{ id: 't1', name: 'search_knowledge', input: { query: 'spei' } }]))
        .mockResolvedValueOnce(kimiEnd('final answer'));
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
      expect(kimiMock).toHaveBeenCalledTimes(2);
    });

    test('runs multiple tool calls in one turn (one tool message each, in order)', async () => {
      kimiMock
        .mockResolvedValueOnce(
          kimiToolCalls([
            { id: 't1', name: 'search_knowledge', input: { query: 'a' } },
            { id: 't2', name: 'search_knowledge', input: { query: 'b' } },
          ]),
        )
        .mockResolvedValueOnce(kimiEnd('done'));
      const tools = fakeTools();
      const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'go' }], tools });
      expect(out).toBe('done');
      expect(tools.handle).toHaveBeenCalledTimes(2);
      expect(kimiToolMsgs(1).map((m) => m.tool_call_id)).toEqual(['t1', 't2']);
    });

    test('hits MAX_TOOL_ITERATIONS, then forces a final answer without tools', async () => {
      for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
        kimiMock.mockResolvedValueOnce(
          kimiToolCalls([{ id: `t${i}`, name: 'search_knowledge', input: { query: `q${i}` } }]),
        );
      }
      kimiMock.mockResolvedValueOnce(kimiEnd('forced synthesis based on partial context'));
      const tools = fakeTools();
      const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'loop' }], tools });
      expect(out).toBe('forced synthesis based on partial context');
      expect(kimiMock).toHaveBeenCalledTimes(config.MAX_TOOL_ITERATIONS + 1);
      // The forcing pass (last call) must omit `tools`.
      expect(kimiReqAt(config.MAX_TOOL_ITERATIONS).tools).toBeUndefined();
    });

    test('per-turn cache: identical (tool, input) pairs hit the cache on the second call', async () => {
      kimiMock
        .mockResolvedValueOnce(kimiToolCalls([{ id: 'a', name: 'search_knowledge', input: { query: 'same' } }]))
        .mockResolvedValueOnce(kimiToolCalls([{ id: 'b', name: 'search_knowledge', input: { query: 'same' } }]))
        .mockResolvedValueOnce(kimiEnd('done'));
      const handle = vi.fn().mockResolvedValue({ status: 'success', payload: { ok: 1 } });
      const tools = { tools: [], handle } satisfies ComposedTools;
      const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'cache me' }], tools });
      expect(out).toBe('done');
      expect(handle).toHaveBeenCalledTimes(1);
    });

    test('a malformed tool_call (missing name) yields an error tool message, handler not called', async () => {
      kimiMock
        .mockResolvedValueOnce(kimiToolCalls([{ id: 'bad', input: {} }])) // no name
        .mockResolvedValueOnce(kimiEnd('recovered'));
      const tools = fakeTools();
      const out = await ask({ system: 'p', messages: [{ role: 'user', content: 'q' }], tools });
      expect(out).toBe('recovered');
      expect(tools.handle).not.toHaveBeenCalled();
      const msgs = kimiToolMsgs(1);
      expect(msgs[0].tool_call_id).toBe('bad');
      expect(msgs[0].content).toContain('Malformed tool_call');
    });

    test('text-only turn sends content as a plain string (no image parts)', async () => {
      kimiMock.mockResolvedValueOnce(kimiEnd('ok'));
      const tools = fakeTools();
      const out = await ask({
        system: 'p',
        messages: [{ role: 'user', content: 'hi', attachments: [] }],
        tools,
      });
      expect(out).toBe('ok');
      // system is messages[0]; the user turn is messages[1] with a string body.
      expect(kimiReqAt(0).messages[1]).toEqual({ role: 'user', content: 'hi' });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('Bedrock vision path (images, or effort low)', () => {
    test('an attached image routes to Bedrock as a Converse image block', async () => {
      sendMock.mockResolvedValueOnce(bedrockEnd('I see a red square.'));
      const tools = fakeTools();
      const img = new ImageAttachable('test.png', 'image/png', new Uint8Array([137, 80, 78, 71]), 'png');
      const out = await ask({
        system: 'p',
        messages: [{ role: 'user', content: 'What is this?', attachments: [img] }],
        tools,
      });
      expect(out).toBe('I see a red square.');
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(kimiMock).not.toHaveBeenCalled();

      const req = bedrockReqAt(0);
      expect(req.messages).toHaveLength(1); // system is a separate field, not a message
      const parts = req.messages[0].content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ text: 'What is this?' });
      expect(parts[1]).toMatchObject({ image: { format: 'png' } });
      const imgPart = parts[1] as { image: { source: { bytes: Uint8Array } } };
      expect(imgPart.image.source.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    });
  });

  describe('effort/backend routing', () => {
    test('low (the vision tier) → Bedrock Nova Lite even without an image', async () => {
      sendMock.mockResolvedValueOnce(bedrockEnd('a'));
      await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools: fakeTools(), effort: 'low' });
      expect(bedrockReqAt(0).modelId).toBe(config.BEDROCK_MODEL_LOW);
    });

    test('medium (text) → Kimi, NOT Bedrock', async () => {
      kimiMock.mockResolvedValueOnce(kimiEnd('b'));
      await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools: fakeTools(), effort: 'medium' });
      expect(kimiReqAt(0).model).toBe(config.KIMI_MODEL_ID);
      expect(sendMock).not.toHaveBeenCalled();
    });

    test('high (text) → Kimi KIMI_MODEL_ID; Bedrock not touched', async () => {
      kimiMock.mockResolvedValueOnce(kimiEnd('c'));
      await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools: fakeTools(), effort: 'high' });
      expect(kimiReqAt(0).model).toBe(config.KIMI_MODEL_ID);
      expect(sendMock).not.toHaveBeenCalled();
    });

    test('default (no effort, text) → Kimi', async () => {
      kimiMock.mockResolvedValueOnce(kimiEnd('d'));
      await ask({ system: 'p', messages: [{ role: 'user', content: 'x' }], tools: fakeTools() });
      expect(kimiReqAt(0).model).toBe(config.KIMI_MODEL_ID);
    });

    test('any image routes to Bedrock Nova Lite regardless of effort (Kimi is text-only)', async () => {
      const img = () => new ImageAttachable('x.png', 'image/png', new Uint8Array([1, 2]), 'png');
      for (const effort of ['high', 'medium'] as const) {
        sendMock.mockReset();
        kimiMock.mockReset();
        sendMock.mockResolvedValueOnce(bedrockEnd('e'));
        await ask({
          system: 'p',
          messages: [{ role: 'user', content: 'x', attachments: [img()] }],
          tools: fakeTools(),
          effort,
        });
        expect(bedrockReqAt(0).modelId).toBe(config.BEDROCK_MODEL_LOW);
        expect(kimiMock).not.toHaveBeenCalled();
      }
    });
  });

  describe('bedrock text backend (LLM_TEXT_BACKEND=bedrock)', () => {
    test('text turn routes to Bedrock BEDROCK_MODEL_ID; Kimi not touched', async () => {
      config.LLM_TEXT_BACKEND = 'bedrock';
      config.BEDROCK_MODEL_ID = 'test-text-model';
      try {
        sendMock.mockResolvedValueOnce(bedrockEnd('bedrock answer'));
        const out = await ask({
          system: 'p',
          messages: [{ role: 'user', content: 'hi' }],
          tools: fakeTools(),
        });
        expect(out).toBe('bedrock answer');
        expect(bedrockReqAt(0).modelId).toBe('test-text-model');
        expect(kimiMock).not.toHaveBeenCalled();
      } finally {
        config.LLM_TEXT_BACKEND = 'kimi';
      }
    });

    test('image turn still routes to Nova Lite even in bedrock text mode', async () => {
      config.LLM_TEXT_BACKEND = 'bedrock';
      try {
        sendMock.mockResolvedValueOnce(bedrockEnd('vision'));
        const img = new ImageAttachable('x.png', 'image/png', new Uint8Array([1, 2]), 'png');
        await ask({
          system: 'p',
          messages: [{ role: 'user', content: 'x', attachments: [img] }],
          tools: fakeTools(),
        });
        expect(bedrockReqAt(0).modelId).toBe(config.BEDROCK_MODEL_LOW);
        expect(kimiMock).not.toHaveBeenCalled();
      } finally {
        config.LLM_TEXT_BACKEND = 'kimi';
      }
    });

    test('text turn runs tool calls over Converse in bedrock mode', async () => {
      config.LLM_TEXT_BACKEND = 'bedrock';
      config.BEDROCK_MODEL_ID = 'test-text-model';
      try {
        sendMock
          .mockResolvedValueOnce({
            output: {
              message: {
                role: 'assistant',
                content: [{ toolUse: { toolUseId: 'u1', name: 'nautilus_query', input: { env: 'dev', query: 'stats count() | limit 1' } } }],
              },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 2 },
          })
          .mockResolvedValueOnce(bedrockEnd('0 errores en dev'));
        const tools = fakeTools(async (name) => ({ status: 'success', payload: { tool: name, rowCount: 1 } }));
        const out = await ask({
          system: 'p',
          messages: [{ role: 'user', content: 'errores en dev?' }],
          tools,
        });
        expect(out).toBe('0 errores en dev');
        expect(tools.handle).toHaveBeenCalledWith('nautilus_query', { env: 'dev', query: 'stats count() | limit 1' });
        expect(sendMock).toHaveBeenCalledTimes(2);
        expect(kimiMock).not.toHaveBeenCalled();
      } finally {
        config.LLM_TEXT_BACKEND = 'kimi';
      }
    });
  });
});
