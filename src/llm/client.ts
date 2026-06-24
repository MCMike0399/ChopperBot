import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';
import { log } from '../log.js';
import { llmHealth } from './health.js';
import type { Turn } from '../discord/history.js';
import type { ComposedTools, ToolHandlerResult, ToolSpec } from '../tools/source.js';

// Single Bedrock client. Credentials are the short ACCESS_KEY_ID /
// SECRET_ACCESS_KEY pair from .env (NOT the AWS_-prefixed standard names, so a
// stray AWS CLI credential on the host can't shadow them). Region defaults to
// us-east-1. The Converse API gives one uniform messages/tools/image interface
// across every Bedrock model, so swapping BEDROCK_MODEL_ID needs no code change.
const client = new BedrockRuntimeClient({
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.ACCESS_KEY_ID,
    secretAccessKey: config.SECRET_ACCESS_KEY,
    ...(config.AWS_SESSION_TOKEN ? { sessionToken: config.AWS_SESSION_TOKEN } : {}),
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

/** Run one Converse call, reporting its outcome to the LLM health watchdog
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

/**
 * Multi-turn agent loop against Amazon Bedrock via the Converse API. Each
 * iteration sends the current message list; if the model returns `tool_use`
 * content blocks, we run them and append a user turn carrying one `toolResult`
 * block per call for the next iteration. Caps at MAX_TOOL_ITERATIONS to bound
 * cost.
 */
export async function ask({ system, messages, tools }: AskInput): Promise<string> {
  const convo: Message[] = messages.map(buildMessage);

  const trace: AgentTrace = {
    iterations: 0,
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
  };

  let finalText = '';
  let lastStopReason: string | undefined;

  // Per-turn deduplication cache. If the model emits the exact same
  // (toolName, inputJson) twice in a single ask() call, return the cached
  // result. Only cache successes; errors get retried because the model
  // usually fixes the input on the second try.
  const toolCache = new Map<string, ToolHandlerResult>();

  const toolConfig = buildToolConfig(tools.tools);
  const systemBlocks = system ? [{ text: system }] : undefined;

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    trace.iterations = i + 1;

    const response = await observedCompletion(() =>
      client.send(
        new ConverseCommand({
          modelId: config.BEDROCK_MODEL_ID,
          system: systemBlocks,
          // Snapshot the array — we mutate `convo` after this call returns.
          messages: convo.slice(),
          ...(toolConfig ? { toolConfig } : {}),
          inferenceConfig: { maxTokens: config.MAX_OUTPUT_TOKENS },
        }),
      ),
    );

    if (response.usage) {
      trace.inputTokens += response.usage.inputTokens ?? 0;
      trace.outputTokens += response.usage.outputTokens ?? 0;
    }

    lastStopReason = response.stopReason;
    const assistantMsg = response.output?.message;
    if (!assistantMsg) {
      log.warn({ stopReason: lastStopReason }, 'Bedrock returned no message');
      break;
    }

    // Echo the assistant turn back verbatim — Converse requires the toolUse
    // blocks be present in history for the matching toolResult to validate.
    convo.push({ role: 'assistant', content: assistantMsg.content ?? [] });

    const blocks = assistantMsg.content ?? [];
    const toolUses = blocks.filter((b): b is ContentBlock.ToolUseMember => 'toolUse' in b);

    if (response.stopReason !== 'tool_use' || toolUses.length === 0) {
      finalText = extractText(blocks);
      break;
    }

    // Run every tool_use in this assistant turn, then append ONE user message
    // carrying one toolResult block per call (Converse's contract).
    const resultBlocks: ContentBlock[] = [];
    for (const { toolUse } of toolUses) {
      const id = toolUse.toolUseId;
      const name = toolUse.name;
      const input = toolUse.input ?? {};
      if (!id || !name) {
        resultBlocks.push({
          toolResult: {
            toolUseId: id ?? 'unknown',
            content: [{ text: JSON.stringify({ error: 'Malformed tool_use (missing id or name).' }) }],
            status: 'error',
          },
        });
        continue;
      }

      const cacheKey = `${name}:${stableStringify(input)}`;
      let result: ToolHandlerResult;
      const cached = toolCache.get(cacheKey);
      if (cached) {
        log.info({ tool: name, cached: true }, 'tool_call_cached');
        result = cached;
      } else {
        result = await tools.handle(name, input);
        if (result.status === 'success') toolCache.set(cacheKey, result);
      }
      trace.toolCalls.push({ name, input, status: result.status });

      resultBlocks.push({
        toolResult: {
          toolUseId: id,
          content: [{ text: JSON.stringify(result.payload ?? null) }],
          status: result.status === 'error' ? 'error' : 'success',
        },
      });
    }
    convo.push({ role: 'user', content: resultBlocks });
  }

  // Forcing pass: if the loop ran out of iterations while the model was still
  // calling tools, do one more Converse call WITHOUT `toolConfig` so the model
  // is forced to synthesize a text answer from everything it gathered, instead
  // of leaving the user with a generic fallback.
  if (!finalText && lastStopReason === 'tool_use') {
    log.info(
      { iterations: trace.iterations, toolCalls: trace.toolCalls.length },
      'Forcing final answer without tools (iteration cap reached)',
    );
    try {
      const forced = await observedCompletion(() =>
        client.send(
          new ConverseCommand({
            modelId: config.BEDROCK_MODEL_ID,
            system: systemBlocks,
            messages: convo.slice(),
            inferenceConfig: { maxTokens: config.MAX_OUTPUT_TOKENS },
          }),
        ),
      );
      if (forced.usage) {
        trace.inputTokens += forced.usage.inputTokens ?? 0;
        trace.outputTokens += forced.usage.outputTokens ?? 0;
      }
      lastStopReason = forced.stopReason ?? lastStopReason;
      finalText = extractText(forced.output?.message?.content ?? []);
    } catch (err) {
      log.error({ err }, 'Forcing pass failed');
    }
  }

  if (!finalText) {
    log.warn(
      { stopReason: lastStopReason, iterations: trace.iterations },
      'Bedrock loop ended without final text',
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
      stopReason: lastStopReason,
    },
    'agent_turn',
  );

  return finalText;
}

/** Concatenate all `text` content blocks in a Converse message. */
function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock.TextMember => 'text' in b)
    .map((b) => b.text)
    .join('')
    .trim();
}

function buildMessage(turn: Turn): Message {
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: [{ text: turn.content }] };
  }
  const content: ContentBlock[] = [{ text: turn.content }];
  for (const att of turn.attachments ?? []) {
    content.push({ image: { format: att.format, source: { bytes: att.bytes } } });
  }
  return { role: 'user', content };
}

function buildToolConfig(specs: ToolSpec[]): ToolConfiguration | undefined {
  if (specs.length === 0) return undefined;
  const tools: Tool[] = specs.map(
    (t): Tool.ToolSpecMember => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        // inputSchema.json is a Smithy `DocumentType` (recursive JSON value);
        // a JSON-Schema object is a valid document but `Record<string, unknown>`
        // doesn't structurally match the strict union, so cast at this boundary.
        inputSchema: { json: t.inputSchema as never },
      },
    }),
  );
  return { tools };
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
