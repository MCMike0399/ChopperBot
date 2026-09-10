import OpenAI from "openai";
import { config, textBackend } from "../config.js";
import { log } from "../log.js";
import { Semaphore } from "./gate.js";
import { isContentFilterRejection, llmHealth } from "./health.js";
import type { Turn } from "../discord/history.js";
import {
   type ComposedTools,
   type ToolHandlerResult,
   type ToolSpec,
} from "../tools/source.js";

// ── One brain, one loop (v4.1 migration, 2026-09-14) ─────────────────────────
// Every turn — Discord chat, calendar/config tool-calling, event-intake
// proposals, the IG classifier, and anything carrying an image — runs on
// **DeepSeek-V4.1-Flash** (`deepseek-flash`) through the OpenAI-compatible
// chat-completions API. This replaced BOTH previous backends:
//
//   • Amazon Bedrock / Nova Lite — the old images-only vision path. V4.1 Flash
//     is natively multimodal (released 2026-09-10), so the two-stage "Nova
//     transcribes, the text brain acts" split was deleted along with its whole
//     Converse agent loop. Images now ride the same request as the tools.
//   • Moonshot Kimi — the old alternate text brain, retired with it.
//
// Effort no longer selects a backend or a model. There is ONE model; `effort`
// picks a thinking MODE plus DeepSeek's `reasoning_effort`:
//
//   'low'  → thinking DISABLED — conversational turns, classification, summaries
//   'high' → thinking enabled, `reasoning_effort: 'high'` — the tool-loop caps
//   'max'  → thinking enabled, `reasoning_effort: 'max'`  — the workshop only
//
// `'medium'` is still accepted as a LEGACY alias for `'high'`, because that is
// exactly what it meant on the old backend (thinking on) and stored config or a
// capability that has not been migrated must not silently lose thinking.
//
// READ BEFORE CHANGING THE EFFORT HANDLING — docs/llm.md carries the measured
// history. Summary of the two live probes (2026-09-14, on this exact model):
// `thinking.type` is load-bearing and reliable (disabled ⇒ 0 reasoning tokens);
// `reasoning_effort` is documented (low/high/max) but measured INERT — medians
// of 257 / 244 / 186 reasoning tokens for low/high/max, overlapping, with `max`
// landing lowest, and the control value "banana" returning 200 rather than an
// error. We still send it because it is the documented API, it costs nothing,
// and it becomes correct the day DeepSeek wires it up server-side. Do not
// "fix" the tiers by inventing a client-side approximation of depth.

const client = textBackend.apiKey
   ? new OpenAI({
        apiKey: textBackend.apiKey,
        baseURL: textBackend.baseUrl,
     })
   : null;

/**
 * Effort tier — a thinking mode on the one model, never a different model.
 *   low  — thinking disabled. Conversational turns and every classification /
 *          summary surface: essentially all the volume.
 *   high — thinking enabled at DeepSeek's `high`. The capabilities that drive
 *          multi-turn tool loops where a wrong call writes state.
 *   max  — thinking enabled at DeepSeek's `max`. Reserved for the workshop, the
 *          bot's longest and most tool-dense loop.
 */
export type Effort = "low" | "high" | "max";

/**
 * Legacy tier from the pre-v4.1 world. `'medium'` meant "thinking OFF" on the
 * old DeepSeek backend but "the IG classifier's text tier"; capabilities that
 * still declare it are normalised to `'high'` (thinking ON) because that is the
 * conservative direction — a turn that used to reason must not silently stop.
 */
export type LegacyEffort = "medium";

/** Normalise a declared tier, honouring the legacy `'medium'` spelling. */
export function normalizeEffort(
   effort: Effort | LegacyEffort | undefined,
): Effort {
   if (effort === "medium") return "high";
   return effort ?? "high";
}

/** Progress signal emitted by the agent loop: `thinking` right before each
 * model request, `tool` right before each tool handler runs (with the tool's
 * name). Callers use it to drive the status reaction on the user's message.
 * Callbacks must not throw (they're invoked inside the loop). */
export type AskPhase = "thinking" | "tool";

export interface AskInput {
   system: string;
   messages: Turn[];
   tools: ComposedTools;
   /** Thinking tier. Defaults to `'high'`. See {@link Effort}. */
   effort?: Effort | LegacyEffort;
   /** Optional progress hook for user-visible status (see {@link AskPhase}). */
   onPhase?: (phase: AskPhase, detail?: string) => void;
   /**
    * Optional cooperative cancellation, checked between steps of the agent
    * loop (before each model request and before each tool execution — never
    * mid-tool, so a create/write is never half-applied). When it returns true
    * the loop stops and {@link TurnAbortedError} is thrown. Used by workshop
    * sessions: a new message from the session owner interrupts the running
    * turn instead of queueing behind it for minutes.
    */
   shouldAbort?: () => boolean;
}

/** Thrown by ask() when the caller's `shouldAbort` interrupted the loop. */
export class TurnAbortedError extends Error {
   constructor() {
      super("Turn aborted by caller");
      this.name = "TurnAbortedError";
   }
}

/**
 * Gate on concurrent DeepSeek HTTP requests (NOT whole turns — two agent loops
 * interleave their requests, so multi-user chat stays responsive while the
 * provider never sees more than DEEPSEEK_MAX_CONCURRENT requests in flight).
 * See gate.ts for the live failure this fixes.
 */
const deepseekGate = new Semaphore(textBackend.maxConcurrent);

interface AgentTrace {
   iterations: number;
   toolCalls: Array<{
      name: string;
      input: unknown;
      status: "success" | "error";
   }>;
   inputTokens: number;
   outputTokens: number;
   reasoningTokens: number;
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
 * Same as observedCompletion, but re-labels a provider moderation refusal as a
 * ContentFilterRejection so ask() can recover from it (one retry) instead of
 * surfacing an error to the member. `toolCallsExecuted` is read at throw time:
 * it's what makes the retry decision safe.
 */
async function observedTextCompletion<T>(
   call: () => Promise<T>,
   trace: AgentTrace,
): Promise<T> {
   try {
      return await observedCompletion(call);
   } catch (err) {
      if (isContentFilterRejection(err)) {
         throw new ContentFilterRejection(err, trace.toolCalls.length);
      }
      throw err;
   }
}

/**
 * Thrown when the provider's risk/moderation filter refused the request (see
 * isContentFilterRejection). Carries how many tool calls the loop had already
 * executed, because that decides whether retrying is safe.
 */
class ContentFilterRejection extends Error {
   constructor(
      readonly original: unknown,
      readonly toolCallsExecuted: number,
   ) {
      super(original instanceof Error ? original.message : String(original));
      this.name = "ContentFilterRejection";
   }
}

/** Last resort when the retry is refused too. Spanish + in-voice: the member
 * should learn the provider blocked it, not read a stack-trace hint.
 * Exported for history filtering (see EMPTY_RESPONSE_FALLBACK). */
export const CONTENT_FILTER_FALLBACK =
   "El filtro del proveedor del modelo bloqueó esa pregunta, así que no me llega la respuesta. Si la planteas de otra forma le entro sin problema.";

/**
 * Entry point. ONE path: the selected effort tier is normalised, the turn
 * (images included) goes to DeepSeek, and a provider moderation refusal is
 * retried once before falling back to a Spanish message.
 */
export async function ask(input: AskInput): Promise<string> {
   const effort = normalizeEffort(input.effort);
   try {
      return await askDeepSeek({ ...input, effort });
   } catch (err) {
      if (!(err instanceof ContentFilterRejection)) throw err;
      return recoverFromContentFilter({ ...input, effort }, err);
   }
}

/** Prose nudge on the tools-free forcing pass. */
const FORCING_NUDGE =
   "Responde AHORA al usuario en prosa, en español, sin llamar herramientas y sin describir llamadas a herramientas. " +
   "Resume lo que ya lograste con las herramientas y, si algo quedó pendiente, dilo en una línea. " +
   "NUNCA afirmes haber enviado archivos ni haber completado acciones que no ejecutaste con herramientas en esta vuelta: " +
   'si un archivo quedó generado pero sin enviar, dilo explícitamente ("quedó listo pero no alcancé a adjuntarlo — pídeme que lo envíe").';

const FORCING_NUDGE_RETRY =
   "Último intento: NO uses herramientas, ya no están disponibles. " +
   "Escribe la respuesta para el usuario como texto normal, aunque sea parcial.";

/**
 * Recovery for a moderated prompt: retry once, then give up with a Spanish
 * message.
 *
 * Why a retry at all — the filter is probabilistic, not a verdict on the text:
 * the prompt that broke on 2026-08-06 ("¿qué deberíamos hacer con las personas
 * que apoyan a china…?") answered normally when replayed minutes later, as did
 * the same question about Israel. So the cheapest correct recovery is to ask
 * again.
 *
 * The old second leg of this ladder — failing over to Amazon Nova — is GONE
 * with the Bedrock backend. Note the measured upside: DeepSeek does NOT refuse
 * RevZ-shaped political prompts (0/4 refusals where Moonshot 400'd), it deflects
 * in-band with HTTP 200 instead, so this path fires rarely.
 */
async function recoverFromContentFilter(
   input: AskInput,
   first: ContentFilterRejection,
): Promise<string> {
   // The retry restarts the agent loop from scratch. That is only safe before
   // any tool has run: retrying after e.g. calendar_create_event would create
   // the event a second time. A rejection on the first request — the common
   // case — has executed nothing.
   if (first.toolCallsExecuted > 0) {
      log.warn(
         { toolCallsExecuted: first.toolCallsExecuted, err: first.message },
         "llm.content_filter.no_retry_after_tools",
      );
      return CONTENT_FILTER_FALLBACK;
   }

   log.warn({ err: first.message }, "llm.content_filter.retrying");
   try {
      return await askDeepSeek(input);
   } catch (err) {
      if (!(err instanceof ContentFilterRejection)) throw err;
      log.warn("llm.content_filter.retry_refused");
      return CONTENT_FILTER_FALLBACK;
   }
}

// ── DeepSeek (OpenAI-compatible chat completions) ────────────────────────────

type ToolCall = {
   id: string;
   type: "function";
   function: { name: string; arguments: string };
};

/** Retries when the model returns a non-tool finish with empty text. */
const MAX_EMPTY_RESPONSE_RETRIES = 2;

/** Posted when every attempt came back empty — Spanish, matching the bot's
 * voice (the old English "I couldn't generate a response." was jarring).
 * Exported so history builders can filter it OUT of conversation context:
 * live 2026-08-06, a session whose history contained two of these taught the
 * model to answer the user's next question with the same fallback verbatim. */
export const EMPTY_RESPONSE_FALLBACK =
   "No pude generar una respuesta esta vez — inténtalo de nuevo en un momento.";

type ChatMessage =
   | { role: "system"; content: string }
   | { role: "user"; content: string | OpenAiContentPart[] }
   | {
        role: "assistant";
        content: string | null;
        tool_calls?: ToolCall[];
        // DeepSeek thinking mode returns reasoning_content on every assistant
        // turn, and the docs REQUIRE it be echoed back on subsequent requests
        // whenever the request carries `tools` ("If your code does not correctly
        // pass back reasoning_content, the API will return a 400 error"). Probed
        // 2026-09-14: omitting it happened to still return 200, so the echo is
        // belt-and-braces — keep it, the docs are explicit and the failure mode
        // is a hard 400 mid-tool-loop.
        reasoning_content?: string;
     }
   | { role: "tool"; tool_call_id: string; content: string };

/** OpenAI-style multimodal content part. Images are supported in `user`
 * messages ONLY — DeepSeek 400s "Image in assistant message is not supported"
 * (probed), which is why historical turns stay text-only (see buildHistory). */
type OpenAiContentPart =
   | { type: "text"; text: string }
   | { type: "image_url"; image_url: { url: string; detail?: string } };

/**
 * Multi-turn agent loop against DeepSeek V4.1 Flash. Each iteration sends the
 * current message list; if the model emits tool_calls, we run them and append
 * role:'tool' messages for the next iteration. Caps at MAX_TOOL_ITERATIONS to
 * bound cost. Image turns use the SAME loop — attachments are inlined as
 * `image_url` data URLs into the user turn as part of building the convo.
 */
async function askDeepSeek({
   system,
   messages,
   tools,
   effort = "high",
   onPhase,
   shouldAbort,
}: AskInput): Promise<string> {
   if (!client) {
      throw new Error(
         "no DeepSeek API key is set — set DEEPSEEK_API_KEY (or DEEP_SEEK_API_KEY)",
      );
   }
   // ONE model. Effort never buys a pricier one (V4-Pro measured identical to
   // Flash on the tool battery while being ~48% slower and 3.1× the price).
   const modelId = textBackend.modelId;
   const tier = normalizeEffort(effort);
   let thinking = buildThinkingParam(tier);
   const convo: ChatMessage[] = [
      { role: "system", content: system },
      ...messages.map(buildChatMessage),
   ];

   const trace: AgentTrace = {
      iterations: 0,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
   };
   let finalText = "";
   let lastFinishReason: string | undefined;
   // Thinking mode can spend every output token on reasoning_content and return
   // empty `content` with finish_reason 'stop' or 'length' (observed live
   // 2026-08-05; again 2026-09-02 in the workshop, where 3×16384 output tokens
   // produced no visible text at all). Retry the completion a bounded number of
   // times before giving up.
   let emptyRetries = 0;
   /** Set when visible text was discarded as scaffolding — forces a clean pass. */
   let degenerate = false;

   // Per-turn dedup cache: identical (toolName, inputJson) returns the cached
   // result. Only cache successes; errors get retried (the model usually fixes
   // the input on the next try).
   const toolCache = new Map<string, ToolHandlerResult>();
   const openAiTools = buildOpenAiTools(tools.tools);

   for (let i = 0; i < config.MAX_TOOL_ITERATIONS; i++) {
      trace.iterations = i + 1;
      if (shouldAbort?.()) throw abortTurn(trace, "deepseek");

      safePhase(onPhase, "thinking");
      // No `temperature` / `top_p` / penalties: thinking mode ignores temperature
      // and the penalty params entirely (DeepSeek deprecated them), and top_p is
      // clamped to >= 0.95. Sending them would be noise; the contract test pins
      // that we don't.
      const response = await observedTextCompletion(
         () =>
            deepseekGate.run(() =>
               client.chat.completions.create({
                  model: modelId,
                  messages: convo.slice() as never,
                  tools:
                     openAiTools.length > 0
                        ? (openAiTools as never)
                        : undefined,
                  max_tokens: textBackend.maxOutputTokens,
                  ...thinking,
               } as never),
            ),
         trace,
      );

      accumulateUsage(trace, response.usage);

      const choice = response.choices?.[0];
      if (!choice) {
         log.warn("DeepSeek returned no choices");
         break;
      }
      lastFinishReason = choice.finish_reason ?? undefined;
      const assistantMsg = choice.message;
      if (!assistantMsg) {
         log.warn(
            { finishReason: lastFinishReason },
            "DeepSeek returned no message",
         );
         break;
      }

      // The provider's own filter omitted the content but returned HTTP 200
      // (`finish_reason: 'content_filter'`). That is semantically the same event
      // as the 400-shaped refusal isContentFilterRejection catches, so route it
      // through the same one-retry ladder instead of returning an empty reply.
      if (lastFinishReason === "content_filter") {
         throw new ContentFilterRejection(
            new Error("finish_reason: content_filter"),
            trace.toolCalls.length,
         );
      }

      const toolCalls = (assistantMsg.tool_calls ?? []) as ToolCall[];
      const reasoningContent = (assistantMsg as { reasoning_content?: string })
         .reasoning_content;
      convo.push({
         role: "assistant",
         content:
            typeof assistantMsg.content === "string"
               ? assistantMsg.content
               : null,
         ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
         ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      if (choice.finish_reason !== "tool_calls" || toolCalls.length === 0) {
         const raw =
            typeof assistantMsg.content === "string"
               ? assistantMsg.content
               : "";
         finalText = extractText(raw);
         // Degenerate scaffolding is worse than nothing: treat it as empty so the
         // retry / forcing path produces real prose instead of showing the loop.
         if (finalText && isDegenerateOutput(finalText)) {
            log.warn(
               { chars: finalText.length, finishReason: lastFinishReason },
               "llm.degenerate_output_discarded",
            );
            finalText = "";
            degenerate = true;
         }
         if (!finalText) {
            // Empty content on a non-tool finish: drop the empty assistant echo so
            // the retry resends the same convo, and give the model another shot.
            convo.pop();
            emptyRetries += 1;
            if (emptyRetries <= MAX_EMPTY_RESPONSE_RETRIES) {
               log.warn(
                  { finishReason: lastFinishReason, attempt: emptyRetries },
                  "DeepSeek returned empty text on a non-tool finish — retrying",
               );
               // Live 2026-09-02 workshop: `high` burned the entire output budget
               // on reasoning (finish_reason `length`, 3×16384 tokens, 0 tools)
               // and the thinking-on retry emptied out again. Flip thinking off so
               // the retry can emit visible text.
               if (
                  lastFinishReason === "length" &&
                  textBackend.supportsThinkingSwitch
               ) {
                  thinking = buildThinkingParam("low");
                  log.warn("llm.thinking_disabled_after_length_cap");
               }
               continue;
            }
         }
         break;
      }

      // Run every tool_call, then append one role:'tool' message per result
      // (OpenAI's contract: one message per tool result).
      for (const tc of toolCalls) {
         if (shouldAbort?.()) throw abortTurn(trace, "deepseek");
         const name = tc.function?.name;
         const rawArgs = tc.function?.arguments ?? "{}";
         if (!tc.id || !name) {
            convo.push({
               role: "tool",
               tool_call_id: tc.id ?? "unknown",
               content: JSON.stringify({
                  error: "Malformed tool_call (missing id or name).",
               }),
            });
            continue;
         }

         let parsedInput: unknown;
         try {
            parsedInput = rawArgs.length > 0 ? JSON.parse(rawArgs) : {};
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            convo.push({
               role: "tool",
               tool_call_id: tc.id,
               content: JSON.stringify({
                  error: `Invalid tool arguments JSON: ${msg}`,
               }),
            });
            trace.toolCalls.push({ name, input: rawArgs, status: "error" });
            continue;
         }

         const cacheKey = `${name}:${stableStringify(parsedInput)}`;
         let result: ToolHandlerResult;
         const cached = toolCache.get(cacheKey);
         if (cached) {
            log.info({ tool: name, cached: true }, "tool_call_cached");
            result = cached;
         } else {
            safePhase(onPhase, "tool", name);
            result = await tools.handle(name, parsedInput);
            if (result.status === "success") toolCache.set(cacheKey, result);
         }
         trace.toolCalls.push({
            name,
            input: parsedInput,
            status: result.status,
         });

         convo.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result.payload ?? null),
         });
      }
   }

   // Forcing pass without `tools` so the model must synthesize prose. Runs when
   // we ran out of iterations mid-tool-calling, OR when the model lost the
   // tool-call protocol and emitted scaffolding as text (removing the tools is
   // exactly what un-sticks that). The prose nudge goes in EVERY time — live
   // 2026-08-06 (workshop, whole-book summary): a cap-reached force with no
   // nudge came back `finish_reason: 'tool_calls'` again (a model keeps calling
   // tools from history even with none advertised) and the user got the empty
   // fallback. One bounded retry covers a forcing pass that still misfires.
   //
   // DeepSeek accepts this shape: probed 2026-09-14 (§5d), a history still
   // carrying reasoning_content + tool_calls sends fine with no `tools` key.
   // (The AWS Converse backend 400'd on the equivalent request, which is why the
   // deleted Bedrock loop had to flatten tool blocks into text first.)
   if (
      !finalText &&
      (lastFinishReason === "tool_calls" ||
         lastFinishReason === "length" ||
         degenerate)
   ) {
      log.info(
         {
            iterations: trace.iterations,
            toolCalls: trace.toolCalls.length,
            degenerate,
            finishReason: lastFinishReason,
         },
         "Forcing final answer without tools",
      );
      if (lastFinishReason === "length" && textBackend.supportsThinkingSwitch) {
         thinking = buildThinkingParam("low");
      }
      convo.push({
         role: "user",
         content: FORCING_NUDGE,
      });
      for (let attempt = 1; attempt <= 2 && !finalText; attempt++) {
         safePhase(onPhase, "thinking");
         try {
            const forced = await observedCompletion(() =>
               deepseekGate.run(() =>
                  client.chat.completions.create({
                     model: modelId,
                     messages: convo.slice() as never,
                     max_tokens: textBackend.maxOutputTokens,
                     // Same mode as the main loop: the forcing pass must not silently
                     // change the model's behavior relative to the turn it's rescuing.
                     ...thinking,
                  } as never),
               ),
            );
            accumulateUsage(trace, forced.usage);
            lastFinishReason =
               forced.choices?.[0]?.finish_reason ?? lastFinishReason;
            const forcedContent = forced.choices?.[0]?.message?.content;
            finalText =
               typeof forcedContent === "string"
                  ? extractText(forcedContent)
                  : "";
            if (finalText && isDegenerateOutput(finalText)) {
               log.warn("llm.degenerate_output_discarded_on_forcing");
               finalText = "";
            }
            if (!finalText && attempt < 2) {
               log.warn(
                  { finishReason: lastFinishReason, attempt },
                  "Forcing pass returned no usable text — retrying",
               );
               convo.push({
                  role: "user",
                  content: FORCING_NUDGE_RETRY,
               });
            }
         } catch (err) {
            if (err instanceof ContentFilterRejection) throw err;
            log.error({ err }, "Forcing pass failed");
            break;
         }
      }
   }

   if (!finalText) {
      log.warn(
         { finishReason: lastFinishReason, iterations: trace.iterations },
         "DeepSeek loop ended without final text",
      );
      finalText = EMPTY_RESPONSE_FALLBACK;
   }

   log.info(
      {
         backend: textBackend.provider,
         effort: tier,
         model: modelId,
         iterations: trace.iterations,
         toolCalls: trace.toolCalls.length,
         tools: trace.toolCalls.map((t) => t.name),
         inputTokens: trace.inputTokens,
         outputTokens: trace.outputTokens,
         reasoningTokens: trace.reasoningTokens,
         stopReason: lastFinishReason,
      },
      "agent_turn",
   );

   return finalText;
}

/**
 * The thinking half of the request. `low` disables thinking outright; `high`
 * and `max` enable it and pass the tier through as `reasoning_effort`.
 *
 * On providers without the switch this is empty — today that is nobody, but the
 * flag keeps the escape hatch in one place.
 */
function buildThinkingParam(
   tier: Effort,
):
   | { thinking: { type: "enabled"; reasoning_effort: Effort } }
   | { thinking: { type: "disabled" } }
   | Record<string, never> {
   if (!textBackend.supportsThinkingSwitch) return {};
   if (tier === "low") return { thinking: { type: "disabled" } };
   return { thinking: { type: "enabled", reasoning_effort: tier } };
}

/**
 * Turn one history `Turn` into the wire message. User turns carrying images
 * become a content-part array: a text part followed by one `image_url` part per
 * attachment, base64-inlined as a data URL (the Discord CDN URL is signed and
 * short-lived, so handing DeepSeek the URL would be a flaky second fetch).
 *
 * Probed 2026-09-14: `deepseek-flash` accepts JPEG/PNG/GIF/WebP up to 32 MiB
 * this way — including several images in one turn — and rejects a degenerate
 * 1×1 PNG with "You have uploaded an unsupported image", which is a decode
 * error rather than a capability gap. Images in assistant/system messages 400.
 */
function buildChatMessage(m: Turn): ChatMessage {
   if (m.role === "assistant") {
      return { role: "assistant", content: m.content };
   }
   const attachments = m.attachments ?? [];
   if (attachments.length === 0) {
      return { role: "user", content: m.content };
   }
   const parts: OpenAiContentPart[] = [{ type: "text", text: m.content }];
   for (const att of attachments) {
      parts.push({
         type: "image_url",
         image_url: { url: toDataUrl(att.mimeType, att.bytes) },
      });
   }
   return { role: "user", content: parts };
}

/** base64 `data:` URL for an inline image part. */
function toDataUrl(mimeType: string, bytes: Uint8Array): string {
   return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function accumulateUsage(
   trace: AgentTrace,
   usage:
      | {
           prompt_tokens?: number;
           completion_tokens?: number;
           completion_tokens_details?: { reasoning_tokens?: number };
        }
      | undefined,
): void {
   if (!usage) return;
   trace.inputTokens += usage.prompt_tokens ?? 0;
   trace.outputTokens += usage.completion_tokens ?? 0;
   // Reasoning bills at the OUTPUT rate, so it is tracked explicitly: it is the
   // single biggest cost lever the effort tier controls.
   trace.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
}

function buildOpenAiTools(specs: ToolSpec[]): unknown[] {
   return specs.map((t) => ({
      type: "function",
      function: {
         name: t.name,
         description: t.description,
         parameters: t.inputSchema,
      },
   }));
}

/** Log + build the abort error (the turn's partial work is already durable —
 * tools either ran fully or not at all; nothing is half-applied). */
function abortTurn(trace: AgentTrace, backend: string): TurnAbortedError {
   log.info(
      {
         backend,
         iterations: trace.iterations,
         toolCalls: trace.toolCalls.length,
      },
      "agent_turn_aborted",
   );
   return new TurnAbortedError();
}

/** Invoke the caller's progress hook without letting it break the loop. */
function safePhase(
   onPhase: AskInput["onPhase"],
   phase: AskPhase,
   detail?: string,
): void {
   try {
      onPhase?.(phase, detail);
   } catch {
      // The hook is UI-only; never let it disturb the agent loop.
   }
}

/** Strip any `<thinking>…</thinking>` / `<think>…</think>` reasoning a model
 * inlines into visible text so raw chain-of-thought never reaches Discord.
 * DeepSeek returns reasoning in a separate `reasoning_content` field, so its
 * visible content is already clean — this is defensive (it was written for Nova,
 * which leaked). `<tool_call>` blocks are stripped for the same reason: a
 * confused model sometimes writes the call as TEXT instead of emitting it. */
function extractText(text: string): string {
   return (
      text
         // Well-formed <thinking>…</thinking> / <think>…</think> blocks.
         .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
         // Unclosed leading reasoning block (truncated by max_tokens): drop from the
         // opening tag to the first blank line, then any stray lone tags.
         .replace(/^\s*<think(?:ing)?>[\s\S]*?(?:\n\s*\n|$)/i, "")
         .replace(/<\/?think(?:ing)?>/gi, "")
         // Tool-call scaffolding written as prose (see isDegenerateOutput).
         .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "")
         .replace(/<\/?tool_call>/gi, "")
         .trim()
   );
}

/**
 * Whether visible model text is DEGENERATE — self-directed scaffolding rather
 * than an answer for the user. Live 2026-08-06: after a 147k-input-token turn,
 * the model lost the tool-call protocol and posted ~8 Discord messages of
 * "Use the tool. Done. Now. {"name": "workshop_read_file", "arguments": …}"
 * into a member's private taller. Such text must never be shown; the caller
 * retries and then forces a tools-free pass to get real prose.
 *
 * Deliberately narrow (a legitimate answer may quote a tool name or JSON):
 * requires either a raw tool-call envelope, or several distinct scaffolding
 * tells at once.
 */
export function isDegenerateOutput(text: string): boolean {
   const t = text.trim();
   if (!t) return false;
   // A bare tool-call envelope written as text.
   if (/<tool_call>|<\|tool_call/i.test(t)) return true;
   if (
      /^\{\s*"(?:tool_)?name"\s*:\s*"[\w.]+"\s*,\s*"(?:arguments|parameters)"\s*:/i.test(
         t,
      )
   ) {
      return true;
   }
   const tells = [
      /\buse (?:the )?tool\b/gi,
      /\b(?:tool_name|"arguments"|"parameters")\b/gi,
      /\b(?:let'?s go|i'?ll output|now\.? end|stop\.? use)\b/gi,
   ];
   const hits = tells.reduce((acc, re) => acc + (t.match(re)?.length ?? 0), 0);
   // Loop-y self-talk repeats its tells many times; prose does not.
   return hits >= 5;
}

/**
 * Order-stable JSON.stringify so { a: 1, b: 2 } and { b: 2, a: 1 } produce
 * the same cache key. Only used for the per-turn dedupe cache.
 */
function stableStringify(value: unknown): string {
   if (value === null || typeof value !== "object")
      return JSON.stringify(value);
   if (Array.isArray(value))
      return "[" + value.map(stableStringify).join(",") + "]";
   const obj = value as Record<string, unknown>;
   const keys = Object.keys(obj).sort();
   return (
      "{" +
      keys
         .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
         .join(",") +
      "}"
   );
}
