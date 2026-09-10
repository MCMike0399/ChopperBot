# LLM client (`src/llm/client.ts`)

> Topic doc — part of the [CLAUDE.md](../CLAUDE.md) router. Read it BEFORE working in this area, and keep it current in the same change as any behavior change (doc protocol ①/② in the index).

**One backend, one model, one loop (v4.1 migration, 2026-09-14).** Every turn — Discord chat, the calendar/config tool-calling, event-intake proposals, the IG classifier, and anything carrying an **image** — runs on **DeepSeek V4.1 Flash** (`deepseek-flash`) through the OpenAI-compatible chat-completions API (the `openai` SDK) against `https://api.deepseek.com/v1`. `ask()` has no routing branch left: it normalises the effort tier, sends the turn, and recovers from a provider moderation refusal.

This replaced **two** backends in one change, and the reasons they are gone are load-bearing:

- **Amazon Bedrock / Amazon Nova Lite — deleted.** Nova was the images-only vision path, because no text brain could see. V4.1 Flash (released 2026-09-10) is natively multimodal, so the two-stage *"Nova transcribes, the text brain acts"* split and the whole Bedrock Converse agent loop were removed. `@aws-sdk/client-bedrock-runtime` is gone from `package.json`.
- **Moonshot Kimi — deleted.** It was the alternate text brain in the `LLM_TEXT_BACKEND` selector; with Nova gone the selector selected nothing meaningful.

**Do not reintroduce a provider slot or a vision model without re-reading the [§Evidence](#evidence-the-live-probes) section below.** Every fact in this doc that sounds like a warning is there because a previous decision was made on a measurement.

## Effort tiers — a thinking mode, never a model

`ask()`'s `effort` is `'low' | 'high' | 'max'`, and it selects **how hard the one model thinks**:

| Tier | Request shape | Who uses it |
| --- | --- | --- |
| `low` | `thinking: {type: 'disabled'}` | Everything conversational or single-shot: **general_chat**, the **IG classifier**, the calendar **announcer**, **minutas**, **workshop compaction** — i.e. essentially all the volume. |
| `high` | `thinking: {type: 'enabled', reasoning_effort: 'high'}` | The multi-turn tool loops where a wrong call writes state: **calendar**, **event_intake**, the **config console**. Also the default when a capability declares nothing. |
| `max` | `thinking: {type: 'enabled', reasoning_effort: 'max'}` | **Workshop only** — the longest, most tool-dense loop in the bot. |

Two footnotes that will otherwise cost someone an afternoon:

- **`'medium'` is still accepted, as a legacy alias for `'high'`.** On the pre-migration backend `medium` meant *thinking OFF*, but it also meant "the IG classifier's text tier", and a capability that still declares it must not silently lose the reasoning it used to have. `normalizeEffort()` in `client.ts` maps it to `high`; `CapabilityTurnBundle.effort` documents this.
- **`reasoning_effort` is documented but measured INERT on `deepseek-flash`.** See [§Evidence](#evidence-the-live-probes). We send it because it is the documented API, it is free, and it becomes correct the day DeepSeek wires it up server-side — **not** because it is known to work. Do not "fix" the tiers by inventing a client-side approximation of depth, and do not assume `max` costs more than `high` when doing cost math.

### Who gets which tier, and how to change it

A capability declares its tier via `CapabilityTurnBundle.effort` (`src/capabilities/capability.ts`); `discord/handlers.ts` passes `turn.effort` straight through. **Omitting it means `high`** (thinking ON) — the conservative default: a capability that forgot to declare one keeps reasoning. `src/llm/__tests__/effort-tier.test.ts` pins every mapping, the legacy alias, the default, the retry behaviour and the forcing pass.

## Images (vision input)

`resolveAttachments()` (`src/attachments/resolver.ts`) accepts **images only** — `png`/`jpeg`/`gif`/`webp`, detected by content-type first then file extension; anything else logs `Unsupported attachment type, skipping`. Caps: `MAX_ATTACHMENT_COUNT` (5, extras ignored) and `MAX_ATTACHMENT_BYTES` (10 MB, oversize skipped). Downloads have a 30 s abort timeout; a failed download is logged, not fatal.

`src/llm/client.ts`'s `buildChatMessage()` turns a user turn with attachments into an OpenAI content-part array — a `{type:'text'}` part followed by one `{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}` part per image. Consequences worth knowing:

- **Base64, not the CDN URL.** Discord CDN links are signed and short-lived, so handing the API a URL would be a flaky second fetch. The bytes are already downloaded.
- **One call.** The pixels ride the *same* request as the system prompt, the history and the tool bundle. A calendar flyer turn therefore costs one call, not two, and the model that reads the flyer is the model that decides what to do with it. Probed limits: JPEG/PNG/GIF/WebP, ≤32 MiB inline, ≤600 images per request, ≤8192 px per side (4096 when a request carries ≥15 images).
- **Images are legal in `user` messages only.** DeepSeek returns `400 Image in assistant message is not supported`. Historical turns from `buildHistory()` are text-only anyway (re-downloading old Discord attachments per reply is not worth the latency), and `buildChatMessage()` ignores attachments on an assistant turn rather than forwarding them into a 400.
- **A degenerate image is a hard 400.** A 1×1 PNG is rejected with *"You have uploaded an unsupported image"*. That is a decode error, not a capability gap — real flyers and screenshots are fine. Use a real ≥64×64 fixture when testing vision by hand.
- **Format detection is by content, not by MIME label.** So a mislabelled attachment is wasteful, not fatal — unlike the old Bedrock path, which 400'd on a format mismatch.

### The IG classifier is one multimodal call

`instagram_monitor/classifier.ts`'s `classifyPost()` sends the cover image **and** makes the relevance/type/date decision in a single `effort: 'low'` call. This is not a reversion to the pre-2026-07-15 shape: that one also sent one image call, but the routing rule sent it to **Nova**, a weak *decider* that intermittently emitted `"when": "null"` as a **string** (printed literally as `Cuándo: null` on the card). The bug was handing the decision to a small vision-only model, not attaching an image. `parseClassificationReply` still folds nullish string tokens, and the prompt still demands a JSON literal, so a regression stays caught. `parseClassificationReply`'s failure path marks the classification `undecided: true`, which is what makes the scheduler hold its dedup anchor back instead of losing the post.

## Content-filter recovery

`isContentFilterRejection()` (`src/llm/health.ts`) recognises the provider's own risk/moderation filter refusing **one prompt** — a `400`/`403`/`451` whose message matches the known moderation phrases. Two shapes reach the ladder:

1. The 400-shaped refusal (original incident: 2026-08-06, a member asked what the server should do about people who support China).
2. **`finish_reason: 'content_filter'` with HTTP 200** — DeepSeek omits the content instead of erroring. `askDeepSeek()` throws it through the same path; without that it would look like an ordinary empty response and burn the empty-retries instead.

The ladder is now **retry once → the Spanish `CONTENT_FILTER_FALLBACK`**. The old second leg (fail over to Amazon Nova) is deleted with the Bedrock backend. **The hard constraint is unchanged: never retry after a tool has run.** Both legs restart the agent loop from scratch, so a rejection arriving after `calendar_create_event` executed would create the event twice. `ContentFilterRejection` carries `toolCallsExecuted` (read at throw time) and a non-zero count skips straight to the Spanish message (`llm.content_filter.no_retry_after_tools`).

Measured upside worth remembering: **DeepSeek does not refuse RevZ-shaped political prompts** (0/4 refusals where Moonshot 400'd). It *deflects in-band* with HTTP 200 — the Tiananmen control answered "no he podido encontrar información sobre ese tema" — which is invisible to this classifier. So the ladder rarely fires.

## Loop mechanics (unchanged in spirit, one loop now)

- `system` + turns → `chat.completions.create`; `tool_calls` → run handlers → one `role:'tool'` message per result → repeat to `MAX_TOOL_ITERATIONS`, then a forcing pass **without `tools`** carrying a prose nudge, with one bounded retry.
- **`reasoning_content` is echoed back** on every assistant turn. DeepSeek's docs make this a hard requirement whenever the request carries `tools` ("If your code does not correctly pass back `reasoning_content`, the API will return a 400 error"). Probed 2026-09-14: omitting it happened to still return 200 — keep the echo anyway; the documented failure mode is a mid-tool-loop 400 and the echo costs nothing.
- **Per-turn tool dedup cache** keyed on `(name, stableStringify(input))`; only successes are cached. This is what makes the empty-response retry *and* the forcing pass safe: a retry that re-emits an identical write call is served from cache and does not re-execute.
- **Empty-content retry** (`MAX_EMPTY_RESPONSE_RETRIES = 2`): the empty assistant echo is dropped and the same convo re-sent. If `finish_reason` was `length`, thinking is **switched off** for the retry — otherwise it just burns the budget again (live 2026-09-02, workshop: 3 × 16384 output tokens, zero visible text). After the retries: `EMPTY_RESPONSE_FALLBACK`, which `buildHistory` filters out of context so the model cannot learn to repeat it.
- **Degenerate-output guard:** `extractText()` strips inline `<thinking>` blocks and `<tool_call>` scaffolding; `isDegenerateOutput()` discards loop-y self-talk so the forcing pass produces real prose instead of the model's internal monologue (live 2026-08-06: eight Discord messages of `Use the tool. Done. Now. {...}` into a member's private channel).
- **`shouldAbort`** is checked before each model request and each tool run — never mid-tool, so a write is never half-applied. Workshop uses it so a new message interrupts a running turn.
- **No sampling params.** Thinking mode ignores `temperature` and DeepSeek deprecated `presence_penalty`/`frequency_penalty`; `top_p` is clamped to ≥0.95 in thinking mode and pinned to 1.0 otherwise. The contract test asserts we send none of them.
- **`deepseekGate`** (a `Semaphore`, `src/llm/gate.ts`) caps concurrent upstream requests at `DEEPSEEK_MAX_CONCURRENT` (default 3). DeepSeek's own concurrency limit is 2500, so this is a Pi-protection knob, not a provider limit — it used to be `1` because the Kimi coding endpoint degraded under overlap.
- **Usage is logged per turn** (`agent_turn`): `backend`, `effort`, `model`, iterations, tool names, `inputTokens`, `outputTokens`, **`reasoningTokens`** and `stopReason`. Reasoning bills at the *output* rate, so it is tracked explicitly — it is the single biggest cost lever the tier controls.

## Health watchdog (`src/llm/health.ts`)

Every request reports to `llmHealth`. **Deterministic** 4xx (bad key, bad model id, a rejected parameter, and DeepSeek's documented `402` insufficient balance / `422` invalid parameters) alert on the **first** failure; **transient** 429/5xx/network alert only after `TRANSIENT_ALERT_THRESHOLD` (3) consecutive failures; **content-filter** refusals never alert and never count toward the streak (they are counted on their own axis and surfaced in `config_system action:health`). At most one alert per `ALERT_COOLDOWN_MS` (6 h), plus one recovery notice. `classifyLlmError` still reads `$metadata.httpStatusCode` alongside `.status` — MinIO's S3 client shares the shape.

## Evidence: the live probes

Two scripts exist specifically so these claims can be re-checked rather than trusted. Both were run live on 2026-09-14 against the real API; both print what they cost.

```bash
npx tsx scripts/probe-deepseek-v41-api.ts     # model id, base_url, effort shapes, vision, tool round-trip, max_tokens
npx tsx scripts/probe-deepseek-v41-vision.ts  # vision with REAL synthesized PNGs + effort on a hard task
npx tsx scripts/probe-deepseek-v41-effort.ts  # effort statistics: 6 fixed puzzles × 6 reps per tier
```

What they established:

- **Model name.** `deepseek-flash` is V4.1 Flash. The legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted and served by V4.1 Flash; a bogus id 400s, so the name is really validated.
- **Base URL.** Both `https://api.deepseek.com` and `https://api.deepseek.com/v1` work.
- **Vision works** — the probe's first attempt failed only because it sent a hand-rolled 1×1 PNG. Real 64×64/512×512 images read correctly: colours, shapes ("una bandera con cuatro franjas horizontales alternas"), and two images in one turn distinguished correctly. Images in `assistant` messages 400.
- **`reasoning_effort` is inert.** 6 fixed puzzles × 6 reps per tier: median reasoning tokens **257 (low) / 244 (high) / 186 (max)** — overlapping distributions, with `max` *lowest* — and the control value `"banana"` returned **HTTP 200** instead of erroring. This is the same signature the retired v4-flash showed on 2026-08-13 (where `low` produced *more* reasoning than `high`). `thinking.type` by contrast is exact: `disabled` ⇒ **0** reasoning tokens, every time.
- **Tool round-trip** with `thinking` on works, and a forcing pass with a history still carrying `reasoning_content` + `tool_calls` sends fine with no `tools` key — which is *why* the deleted Bedrock loop's `flattenBedrockMessagesForForcing()` workaround is not needed here.
- **`max_tokens`** must be in `[1, 393216]` (a 500 000 request 400s) and defaults to 64K in thinking mode / 8K otherwise. `DEEPSEEK_MAX_OUTPUT_TOKENS` defaults to **32768**: high enough for a `max`-effort workshop turn (one probe rep hit ~30K reasoning tokens), far inside the cap.
- **Pricing** (per [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing/), USD per 1M tokens, peak/off-peak where off-peak is half of peak): V4.1 Flash is **$0.15/$0.30 cache-miss input, $0.60/$1.20 output** (off-peak/peak), cache-hit input **$0.003/$0.006**. That is *cheaper* than the pre-2026-08-16 v4-flash rates, so the "≈$3.6/month off-peak" figure in the old notes is now an over-estimate. **Peak is 01:00–04:00 and 06:00–10:00 UTC** = 19:00–22:00 and 00:00–06:00 CST — the first window is exactly RevZ's evening Discord activity, so a real share of turns bills at peak. Cache matters: a stable system-prompt prefix hit **98%** in earlier testing and cache-hit input is ~30–50× cheaper than miss.
- **Error codes** (per [DeepSeek's error docs](https://api-docs.deepseek.com/quick_start/error_codes)): `400` invalid format, `401` auth, **`402` insufficient balance**, `422` invalid parameters, `429` rate limit, `500`/`503` server. All the non-429 4xx are deterministic and page on the first failure, which is right for a depleted balance.
- **`strict` tool mode** exists (`base_url=.../beta`, `strict: true` per function, all properties required + `additionalProperties: false`). **Not adopted**: it is beta, requires the beta base URL, and would reject the existing tool schemas. Revisit only with the schemas rewritten and measured.
- **The Responses API is deliberately NOT used.** ChopperBot rebuilds its window from Discord every turn (`buildHistory`), so the server-side conversation state that would justify it does not exist.

## Env & config

- **Required at boot:** `DEEPSEEK_API_KEY` (or the legacy spelling `DEEP_SEEK_API_KEY`, which is what the Pi's `.env` carries). There is no fallback backend, so a missing key is a hard boot failure (`superRefine` in `src/config.ts`).
- `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com/v1`), `DEEPSEEK_MODEL_ID` (default `deepseek-flash`), `DEEPSEEK_MAX_OUTPUT_TOKENS` (default `32768`), `DEEPSEEK_MAX_CONCURRENT` (default `3`), `MAX_TOOL_ITERATIONS` (default `10`), `MAX_CONCURRENT_TURNS` (default `3`).
- **Removed and now inert:** `LLM_TEXT_BACKEND`, `KIMI_*`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `BEDROCK_MODEL_ID`, `BEDROCK_MODEL_LOW`, `MAX_OUTPUT_TOKENS`. Zod strips unknown keys, so a stale `.env` line cannot crash boot — `src/__tests__/config.test.ts` pins that. Clean them out anyway.
- The resolved backend is the single `textBackend` object (`{provider, apiKey, baseUrl, modelId, supportsThinkingSwitch, maxOutputTokens, maxConcurrent}`); `client.ts` reads only that, which is the seam a future provider would use. `textBrainDisplayName()` returns `"DeepSeek V4.1 Flash"` and is interpolated into community-facing prompts — `health`/`bot_info` report `textBackend`, never a hardcoded name. That mistake has shipped twice (the console named `BEDROCK_MODEL_ID` after the Kimi repoint, then hardcoded Kimi after the DeepSeek cutover), so the console tests assert the payload contains neither `anthropic.claude` nor `nova`.

## Verify

```bash
npx vitest run src/llm src/__tests__/config.test.ts \
  src/capabilities/instagram_monitor/__tests__/classifier.test.ts \
  src/capabilities/configuration/__tests__/health.test.ts
```

| File | Covers |
| --- | --- |
| `src/llm/__tests__/client.test.ts` | the agent loop, tool round-trips, the per-turn cache, and images riding the same call as the tools |
| `src/llm/__tests__/effort-tier.test.ts` | every tier → request shape, the legacy `medium` alias, the default, retry and forcing-pass behaviour |
| `src/llm/__tests__/contract.test.ts` | the exact wire JSON, including the image data URL and the sampling params we must NOT send |
| `src/llm/__tests__/content-filter.test.ts` | the one-retry ladder, the `content_filter` finish_reason, and the no-retry-after-tools guard |
| `src/llm/__tests__/forcing-pass.test.ts`, `empty-retry.test.ts`, `degenerate.test.ts`, `abort.test.ts`, `gate.test.ts` | the loop's hardening paths |
| `src/llm/__tests__/health.test.ts` | error classification and the never-alert/never-mask accounting |
| `src/capabilities/instagram_monitor/__tests__/classifier.test.ts` | the single multimodal classification call and the `undecided` failure path |

**A dev script that drives a mod-gated capability MUST pass `isAdministrator: true` into `buildTurn`** (2026-08-13) — otherwise it grades the auth gate, not the model. The privileged-capability gate (`isModTurn`, fail-closed) reads `memberRoles`/`isAdministrator` off the turn context, and a synthetic ctx has neither, so the calendar hands back the read-only tool bundle instead of the full one and the battery reads 2/8 on every backend — indistinguishable from a regression. Two related harness traps, both of which also read as model regressions: (1) a scene must pass the **capability's declared tier**, since `ask()`'s own default is `high`; (2) **never put `\b` around an accented word** in a scorer regex — `\b` is ASCII-only in JS and the `u` flag does not change it, so `/\baquí\b/` can *never* match.
