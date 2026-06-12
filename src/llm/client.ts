import OpenAI from 'openai';
import { config } from '../config.js';
import { log } from '../log.js';
import { llmHealth } from './health.js';
import type { Turn } from '../discord/history.js';
import type { ComposedTools, ToolHandlerResult, ToolSpec } from '../tools/source.js';

// The Kimi Code API gates by client fingerprint: requests with the default
// openai-node User-Agent get a 403 with "Kimi For Coding is currently only
// available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo
// Code, etc." Verified empirically that "claude-cli/1.0.0" passes the gate
// (other tested values like "kimi-cli/0.1.0", "Claude-Code/1.0", "Roo Code"
// did not). Override via KIMI_USER_AGENT if the allowlist changes.
const client = new OpenAI({
  apiKey: config.KIMI_API_KEY,
  baseURL: config.KIMI_BASE_URL,
  defaultHeaders: {
    'User-Agent': config.KIMI_USER_AGENT,
  },
});

export interface AskInput {
  system: string;
  messages: Turn[];
  tools: ComposedTools;
}

interface AgentTrace {
  iterations: number;
  toolCalls: Array<{ name: string; input: unknown; status: 'success' | 'error' }>;
  inputTokens: number;
  outputTokens: number;
}

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** Run one completion call, reporting its outcome to the LLM health watchdog
 * (admin-channel alerts on outage, recovery notice on success). Rethrows —
 * callers' error handling is unchanged. */
async function observedCompletion<T>(call: () => Promise<T>): Promise<T> {
  try {
    const result = await call();
    llmHealth.reportSuccess();
    return result;
  } catch (err) {
    llmHealth.reportFailure(err);
    throw err;
  }
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | unknown[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      // Kimi-specific: when thinking mode is on, every assistant turn (including
      // tool_calls turns) comes back with reasoning_content. The gateway then
      // rejects follow-up requests that don't echo it back. Optional on OpenAI
      // proper, which ignores unknown fields.
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Multi-turn agent loop against Moonshot Kimi Code (OpenAI-compatible chat
 * completions). Each iteration sends the current message list; if the model
 * emits tool_calls, we run them and append role:'tool' messages for the
 * next iteration. Caps at MAX_TOOL_ITERATIONS to bound cost.
 */
export async function ask({ system, messages, tools }: AskInput): Promise<string> {
  const convo: ChatMessage[] = [
    { role: 'system', content: system },
    ...messages.map((m): ChatMessage => buildUserOrAssistantMessage(m)),
  ];

  const trace: AgentTrace = {
    iterations: 0,
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
  };

  let finalText = '';
  let lastFinishReason: string | undefined;

  // Per-turn deduplication cache. If the model emits the exact same
  // (toolName, inputJson) twice in a single ask() call, return the cached
  // result. Only cache successes; errors get retried because the model
  // usually fixes the input on the second try.
  const toolCache = new Map<string, ToolHandlerResult>();

  const openAiTools = buildOpenAiTools(tools.tools);

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    trace.iterations = i + 1;

    // No `temperature`: since the K2.7 Code repoint (2026-06-12) the
    // kimi-for-coding endpoint rejects any value except 1 with a 400
    // ("invalid temperature: only 1 is allowed for this model"). Omitting it
    // takes the server default and survives future allowed-value changes.
    const response = await observedCompletion(() =>
      client.chat.completions.create({
        model: config.KIMI_MODEL_ID,
        messages: convo.slice() as never,
        tools: openAiTools.length > 0 ? (openAiTools as never) : undefined,
        max_tokens: config.MAX_OUTPUT_TOKENS,
      }),
    );

    if (response.usage) {
      trace.inputTokens += response.usage.prompt_tokens ?? 0;
      trace.outputTokens += response.usage.completion_tokens ?? 0;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      log.warn('Kimi returned no choices');
      break;
    }
    lastFinishReason = choice.finish_reason ?? undefined;
    const assistantMsg = choice.message;
    if (!assistantMsg) {
      log.warn({ finishReason: lastFinishReason }, 'Kimi returned no message');
      break;
    }

    const toolCalls = (assistantMsg.tool_calls ?? []) as ToolCall[];
    const reasoningContent = (assistantMsg as { reasoning_content?: string }).reasoning_content;
    convo.push({
      role: 'assistant',
      content: typeof assistantMsg.content === 'string' ? assistantMsg.content : null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (choice.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
      finalText = typeof assistantMsg.content === 'string' ? assistantMsg.content.trim() : '';
      break;
    }

    // Run every tool_call in this assistant turn, then append one role:'tool'
    // message per result (OpenAI's contract: one message per tool result).
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const rawArgs = tc.function?.arguments ?? '{}';
      if (!tc.id || !name) {
        convo.push({
          role: 'tool',
          tool_call_id: tc.id ?? 'unknown',
          content: JSON.stringify({ error: 'Malformed tool_call (missing id or name).' }),
        });
        continue;
      }

      let parsedInput: unknown;
      try {
        parsedInput = rawArgs.length > 0 ? JSON.parse(rawArgs) : {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `Invalid tool arguments JSON: ${msg}` }),
        });
        trace.toolCalls.push({ name, input: rawArgs, status: 'error' });
        continue;
      }

      const cacheKey = `${name}:${stableStringify(parsedInput)}`;
      let result: ToolHandlerResult;
      const cached = toolCache.get(cacheKey);
      if (cached) {
        log.info({ tool: name, cached: true }, 'tool_call_cached');
        result = cached;
      } else {
        result = await tools.handle(name, parsedInput);
        if (result.status === 'success') toolCache.set(cacheKey, result);
      }
      trace.toolCalls.push({ name, input: parsedInput, status: result.status });

      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.payload ?? null),
      });
    }
  }

  // Forcing pass: if the loop ran out of iterations while the model was
  // still calling tools, do one more completion WITHOUT `tools` so the
  // model is forced to synthesize a text answer from everything it has
  // gathered, instead of leaving the user with a generic fallback.
  if (!finalText && lastFinishReason === 'tool_calls') {
    log.info(
      { iterations: trace.iterations, toolCalls: trace.toolCalls.length },
      'Forcing final answer without tools (iteration cap reached)',
    );
    try {
      const forced = await observedCompletion(() =>
        client.chat.completions.create({
          model: config.KIMI_MODEL_ID,
          messages: convo.slice() as never,
          max_tokens: config.MAX_OUTPUT_TOKENS,
        }),
      );
      if (forced.usage) {
        trace.inputTokens += forced.usage.prompt_tokens ?? 0;
        trace.outputTokens += forced.usage.completion_tokens ?? 0;
      }
      lastFinishReason = forced.choices?.[0]?.finish_reason ?? lastFinishReason;
      const forcedContent = forced.choices?.[0]?.message?.content;
      finalText = typeof forcedContent === 'string' ? forcedContent.trim() : '';
    } catch (err) {
      log.error({ err }, 'Forcing pass failed');
    }
  }

  if (!finalText) {
    log.warn(
      { finishReason: lastFinishReason, iterations: trace.iterations },
      'Kimi loop ended without final text',
    );
    finalText = "I couldn't generate a response.";
  }

  log.info(
    {
      iterations: trace.iterations,
      toolCalls: trace.toolCalls.length,
      tools: trace.toolCalls.map((t) => t.name),
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      stopReason: lastFinishReason,
    },
    'agent_turn',
  );

  return finalText;
}

function buildUserOrAssistantMessage(turn: Turn): ChatMessage {
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: turn.content };
  }
  const parts = turn.attachments ?? [];
  if (parts.length === 0) {
    return { role: 'user', content: turn.content };
  }
  const content: unknown[] = [{ type: 'text', text: turn.content }];
  for (const att of parts) content.push(att.toContentPart());
  return { role: 'user', content };
}

function buildOpenAiTools(specs: ToolSpec[]): unknown[] {
  return specs.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Order-stable JSON.stringify so { a: 1, b: 2 } and { b: 2, a: 1 } produce
 * the same cache key. Only used for the per-turn dedupe cache.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
