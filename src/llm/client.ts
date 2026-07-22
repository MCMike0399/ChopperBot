import OpenAI from 'openai';
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

// ── Two backends, chosen per turn ────────────────────────────────────────────
// DEFAULT (LLM_TEXT_BACKEND=kimi, self-hosted/Pi): EVERY text turn — Discord
// chat, calendar/config tool-calling, event-intake proposals, and the IG
// classifier's caption-only fallback — runs on Moonshot Kimi 2.7 Thinking via
// the OpenAI-compatible chat-completions API. Bedrock serves ONLY images there:
// Kimi is text-only, so a turn carrying an attachment goes to Amazon Nova Lite
// (the effort `low` tier). The routing rule:
//
//   has an image OR effort 'low'    → Bedrock (Amazon Nova Lite) — images only
//   text + LLM_TEXT_BACKEND=kimi    → Kimi 2.7 Thinking
//   text + LLM_TEXT_BACKEND=bedrock → Bedrock Converse (BEDROCK_MODEL_ID)
//
// The bedrock text mode exists for AWS-native deploys (the ECS sancus ops bot):
// no external LLM API key is available there, so text runs on the same Bedrock
// client, authenticated by the task role. The Kimi coding endpoint gates by
// client fingerprint: requests with the default openai-node User-Agent get a
// 403 ("Kimi For Coding is currently only available for Coding Agents…").
// `claude-cli/1.0.0` is empirically on the allowlist; override via
// KIMI_USER_AGENT if it changes. The client is constructed LAZILY — in bedrock
// text mode no KIMI_API_KEY exists and no Kimi client is needed.
const kimi = config.KIMI_API_KEY
  ? new OpenAI({
      apiKey: config.KIMI_API_KEY,
      baseURL: config.KIMI_BASE_URL,
      defaultHeaders: {
        'User-Agent': config.KIMI_USER_AGENT,
      },
    })
  : null;

// Bedrock client (vision path always; text path when LLM_TEXT_BACKEND=bedrock).
// Credentials: the short ACCESS_KEY_ID / SECRET_ACCESS_KEY pair from .env when
// set (NOT the AWS_-prefixed standard names, so a stray AWS CLI credential on
// the host can't shadow them); otherwise the AWS default credential chain
// (ECS task role, instance profile, or AWS_PROFILE). Region defaults to
// us-east-1.
const bedrock = new BedrockRuntimeClient({
  region: config.AWS_REGION,
  ...(config.ACCESS_KEY_ID && config.SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: config.ACCESS_KEY_ID,
          secretAccessKey: config.SECRET_ACCESS_KEY,
          ...(config.AWS_SESSION_TOKEN ? { sessionToken: config.AWS_SESSION_TOKEN } : {}),
        },
      }
    : {}),
});

/**
 * Effort tier. Since the 2026-07-13 Kimi repoint, `high` and `medium` are both
 * text → Kimi; `low` is the Nova Lite vision tier. Bedrock (Nova Lite) is used
 * ONLY for image turns — see the routing rule in ask().
 *   high   — chat + calendar + event-intake (Kimi 2.7 Thinking).
 *   medium — IG classifier (Kimi for the caption text; Nova Lite when the flyer
 *            image is attached, via the images-always-go-to-Nova rule).
 *   low    — the vision tier: Amazon Nova Lite (images).
 */
export type Effort = 'high' | 'medium' | 'low';

export interface AskInput {
  system: string;
  messages: Turn[];
  tools: ComposedTools;
  /** Model tier. Defaults to 'high' (Kimi). Images always route to Nova Lite
   * regardless of tier; 'low' also forces Nova Lite. */
  effort?: Effort;
}

interface AgentTrace {
  iterations: number;
  toolCalls: Array<{ name: string; input: unknown; status: 'success' | 'error' }>;
  inputTokens: number;
  outputTokens: number;
}

/** Run one LLM call, reporting its outcome to the LLM health watchdog
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
 * Entry point. Bedrock (Amazon Nova Lite) serves image turns always: route
 * there when the turn carries an image, or when effort 'low' (the vision tier)
 * is requested explicitly. Text turns go to Kimi by default, or to Bedrock
 * (BEDROCK_MODEL_ID) when LLM_TEXT_BACKEND=bedrock (AWS-native deploys with no
 * external LLM key). Both run the same multi-turn agent loop contract; the wire
 * shape differs by backend.
 */
export async function ask(input: AskInput): Promise<string> {
  const { messages, effort = 'high' } = input;
  const hasImages = messages.some((m) => (m.attachments?.length ?? 0) > 0);
  if (hasImages || effort === 'low') {
    return askBedrock({ ...input, effort });
  }
  if (config.LLM_TEXT_BACKEND === 'bedrock') {
    return askBedrock({ ...input, effort, modelId: config.BEDROCK_MODEL_ID });
  }
  return askKimi(input);
}

// ── Kimi (OpenAI-compatible chat completions) ────────────────────────────────

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      // Kimi-specific: in thinking mode every assistant turn (including
      // tool_calls turns) comes back with reasoning_content, and the gateway
      // rejects follow-up requests that don't echo it back. Optional on OpenAI
      // proper, which ignores unknown fields.
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Multi-turn agent loop against Moonshot Kimi 2.7 Thinking (OpenAI-compatible
 * chat completions). Each iteration sends the current message list; if the
 * model emits tool_calls, we run them and append role:'tool' messages for the
 * next iteration. Caps at MAX_TOOL_ITERATIONS to bound cost. Text-only — image
 * turns never reach here (see ask()).
 */
async function askKimi({ system, messages, tools, effort = 'high' }: AskInput): Promise<string> {
  if (!kimi) {
    throw new Error(
      'Kimi text backend selected but KIMI_API_KEY is not set — set the key, or LLM_TEXT_BACKEND=bedrock for AWS-native runs',
    );
  }
  const modelId = config.KIMI_MODEL_ID;
  const convo: ChatMessage[] = [
    { role: 'system', content: system },
    ...messages.map((m): ChatMessage =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.content }
        : { role: 'user', content: m.content },
    ),
  ];

  const trace: AgentTrace = { iterations: 0, toolCalls: [], inputTokens: 0, outputTokens: 0 };
  let finalText = '';
  let lastFinishReason: string | undefined;

  // Per-turn dedup cache: identical (toolName, inputJson) returns the cached
  // result. Only cache successes; errors get retried (the model usually fixes
  // the input on the next try).
  const toolCache = new Map<string, ToolHandlerResult>();
  const openAiTools = buildOpenAiTools(tools.tools);

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    trace.iterations = i + 1;

    // No `temperature`: the kimi-for-coding endpoint rejects any value except 1
    // (400 "only 1 is allowed for this model"). Omitting takes the server default.
    const response = await observedCompletion(() =>
      kimi.chat.completions.create({
        model: modelId,
        messages: convo.slice() as never,
        tools: openAiTools.length > 0 ? (openAiTools as never) : undefined,
        max_tokens: config.MAX_OUTPUT_TOKENS,
      } as never),
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
      finalText = extractText(typeof assistantMsg.content === 'string' ? assistantMsg.content : '');
      break;
    }

    // Run every tool_call, then append one role:'tool' message per result
    // (OpenAI's contract: one message per tool result).
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

  // Forcing pass: out of iterations while still calling tools → one more
  // completion WITHOUT `tools` so the model synthesizes a text answer.
  if (!finalText && lastFinishReason === 'tool_calls') {
    log.info(
      { iterations: trace.iterations, toolCalls: trace.toolCalls.length },
      'Forcing final answer without tools (iteration cap reached)',
    );
    try {
      const forced = await observedCompletion(() =>
        kimi.chat.completions.create({
          model: modelId,
          messages: convo.slice() as never,
          max_tokens: config.MAX_OUTPUT_TOKENS,
        } as never),
      );
      if (forced.usage) {
        trace.inputTokens += forced.usage.prompt_tokens ?? 0;
        trace.outputTokens += forced.usage.completion_tokens ?? 0;
      }
      lastFinishReason = forced.choices?.[0]?.finish_reason ?? lastFinishReason;
      const forcedContent = forced.choices?.[0]?.message?.content;
      finalText = typeof forcedContent === 'string' ? extractText(forcedContent) : '';
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
      backend: 'kimi',
      effort,
      model: modelId,
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

// ── Bedrock (Converse) — the vision backend ──────────────────────────────────

/**
 * Multi-turn agent loop against Amazon Bedrock via the Converse API. Serves the
 * image path on Amazon Nova Lite (BEDROCK_MODEL_LOW, the default `modelId`) and,
 * when LLM_TEXT_BACKEND=bedrock, the text path on BEDROCK_MODEL_ID. On
 * `stopReason === 'tool_use'` we run the tools and append a user turn carrying
 * one `toolResult` block per call. Caps at MAX_TOOL_ITERATIONS.
 */
async function askBedrock({
  system,
  messages,
  tools,
  effort = 'low',
  modelId = config.BEDROCK_MODEL_LOW,
}: AskInput & { modelId?: string }): Promise<string> {
  const convo: Message[] = messages.map(buildMessage);

  const trace: AgentTrace = { iterations: 0, toolCalls: [], inputTokens: 0, outputTokens: 0 };
  let finalText = '';
  let lastStopReason: string | undefined;

  const toolCache = new Map<string, ToolHandlerResult>();
  const toolConfig = buildToolConfig(tools.tools);
  const systemBlocks = system ? [{ text: system }] : undefined;

  for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
    trace.iterations = i + 1;

    const response = await observedCompletion(() =>
      bedrock.send(
        new ConverseCommand({
          modelId,
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
      finalText = extractTextBlocks(blocks);
      break;
    }

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

  // Forcing pass without toolConfig (iteration cap hit while still calling tools).
  if (!finalText && lastStopReason === 'tool_use') {
    log.info(
      { iterations: trace.iterations, toolCalls: trace.toolCalls.length },
      'Forcing final answer without tools (iteration cap reached)',
    );
    try {
      const forced = await observedCompletion(() =>
        bedrock.send(
          new ConverseCommand({
            modelId,
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
      finalText = extractTextBlocks(forced.output?.message?.content ?? []);
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
      backend: 'bedrock',
      effort,
      model: modelId,
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

/** Concatenate all `text` blocks in a Converse message, then strip reasoning. */
function extractTextBlocks(blocks: ContentBlock[]): string {
  const text = blocks
    .filter((b): b is ContentBlock.TextMember => 'text' in b)
    .map((b) => b.text)
    .join('');
  return extractText(text);
}

/** Strip any `<thinking>…</thinking>` / `<think>…</think>` reasoning a model
 * inlines into visible text (some models — e.g. Amazon Nova — leak it) so raw
 * chain-of-thought never reaches Discord, then trim. Kimi returns reasoning in a
 * separate `reasoning_content` field, so its visible content is already clean —
 * this is defensive. */
function extractText(text: string): string {
  return text
    // Well-formed <thinking>…</thinking> / <think>…</think> blocks.
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    // Unclosed leading reasoning block (truncated by max_tokens): drop from the
    // opening tag to the first blank line, then any stray lone tags.
    .replace(/^\s*<think(?:ing)?>[\s\S]*?(?:\n\s*\n|$)/i, '')
    .replace(/<\/?think(?:ing)?>/gi, '')
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
