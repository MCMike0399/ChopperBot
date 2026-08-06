/**
 * ask() — recovery from a provider CONTENT-FILTER rejection.
 *
 * Incident (2026-08-06 09:57 + 10:09 CST, #club-de-cine): a member asked
 * general_chat "¿qué deberíamos hacer con las personas que apoyan a china en
 * este servidor?" and Moonshot answered `400 The request was rejected because
 * it was considered high risk`. The turn threw, the member got the English
 * "Sorry, I hit an error answering that — check the logs.", and the admin
 * channel got paged as if the API key were broken.
 *
 * The filter is probabilistic (the same prompt answered on a replay minutes
 * later), so the contract is: retry Kimi once → fall back to Bedrock → only
 * then a Spanish message. And never retry once tools have run, or an approved
 * calendar event would be created twice.
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
import type { ComposedTools } from '../../tools/source.js';

/** The verbatim Moonshot rejection from the incident. */
function highRisk(): Error {
  const err = new Error(
    '400 The request was rejected because it was considered high risk',
  ) as Error & { status: number; param: string };
  err.status = 400;
  err.param = 'prompt';
  return err;
}

function kimiEnd(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}
function kimiToolCall(id: string, name: string, input: unknown) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(input) } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}
function bedrockEnd(text: string) {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function fakeTools(handle?: ComposedTools['handle']): ComposedTools {
  return {
    tools: [
      {
        name: 'calendar_create_event',
        description: 'create',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    handle: vi.fn(handle ?? (async () => ({ status: 'success', payload: { id: 1 } }))),
  };
}

const TURN = {
  system: 'eres chopperbot',
  messages: [
    {
      role: 'user' as const,
      content: 'que deberiamos que hacer con las personas que apoyan a china en este servidor?',
    },
  ],
};

beforeEach(() => {
  kimiMock.mockReset();
  sendMock.mockReset();
});

describe('ask — content-filter recovery', () => {
  test('retries Kimi once and returns the answer the retry produced', async () => {
    kimiMock.mockRejectedValueOnce(highRisk()).mockResolvedValueOnce(kimiEnd('Aquí la postura.'));
    const out = await ask({ ...TURN, tools: fakeTools() });
    expect(out).toBe('Aquí la postura.');
    expect(kimiMock).toHaveBeenCalledTimes(2);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('falls back to Bedrock when the retry is refused too', async () => {
    kimiMock.mockRejectedValueOnce(highRisk()).mockRejectedValueOnce(highRisk());
    sendMock.mockResolvedValueOnce(bedrockEnd('Respuesta de Nova.'));
    const out = await ask({ ...TURN, tools: fakeTools() });
    expect(out).toBe('Respuesta de Nova.');
    expect(kimiMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The vision-tier model — the only Bedrock model this deployment calls.
    const req = (sendMock.mock.calls[0][0] as { input: { modelId: string } }).input;
    expect(req.modelId).toBe(config.BEDROCK_MODEL_LOW);
  });

  test('a Spanish message is the last resort when both backends refuse', async () => {
    kimiMock.mockRejectedValue(highRisk());
    sendMock.mockRejectedValue(highRisk());
    const out = await ask({ ...TURN, tools: fakeTools() });
    expect(out).toMatch(/filtro del proveedor/i);
    expect(out).not.toMatch(/error|logs/i);
  });

  test('does NOT retry after a tool has run — a second pass would re-create the event', async () => {
    const tools = fakeTools();
    kimiMock
      .mockResolvedValueOnce(kimiToolCall('c1', 'calendar_create_event', { title: 'Asamblea' }))
      .mockRejectedValueOnce(highRisk());
    const out = await ask({ ...TURN, tools });
    expect(tools.handle).toHaveBeenCalledTimes(1);
    expect(kimiMock).toHaveBeenCalledTimes(2); // the initial call + the post-tool call, no retry
    expect(sendMock).not.toHaveBeenCalled();
    expect(out).toMatch(/filtro del proveedor/i);
  });

  test('other errors still propagate — a bad key must not look like moderation', async () => {
    const authErr = new Error('401 Invalid Authentication') as Error & { status: number };
    authErr.status = 401;
    kimiMock.mockRejectedValueOnce(authErr);
    await expect(ask({ ...TURN, tools: fakeTools() })).rejects.toThrow('Invalid Authentication');
    expect(kimiMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
