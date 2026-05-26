# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install            # install deps
pnpm run typecheck      # tsc --noEmit (strict)
pnpm run build          # tsc → dist/
pnpm run start          # node dist/index.js (prod entry)
pnpm run dev            # tsx watch src/index.ts

# Tests — vitest, real SQLite (`:memory:`), mocked OpenAI client.
npx vitest run                                                # full suite
npx vitest                                                    # watch mode
npx vitest run src/capabilities/calendar/__tests__/store.test.ts   # single file
npx vitest run -t "creates an event"                          # single test by name pattern

# Smoke test against the REAL Kimi API (NOT run by `pnpm test`; costs request budget):
KIMI_API_KEY=sk-kimi-... tsx scripts/live-kimi-smoke.ts
```

`vitest.setup.ts` pre-fills required env vars at module load so `src/config.ts` (which validates at import) doesn't crash test runs.

## Deployment context — IMPORTANT

This `ChopperBot-public` directory is the **open-source mirror**. The actually-deployed bot runs from a sibling `ChopperBot/` directory (private), supervised by macOS launchd. **Code edits here do not affect the running bot.** See `~/Library/LaunchAgents/com.user.chopperbot*.plist` if you need to verify which path the supervisor points at.

## Architecture

**One Discord channel = exactly one Capability.** A Capability is a self-contained bundle of system prompt + tools + private SQLite namespace. Three ship: `configuration` (admin console, hardcoded to one channel), `calendar` (per-channel/per-user events with daily/weekly/monthly recurrence), `instagram_monitor` (autonomous background poller).

### Boot sequence (`src/app.ts`)

1. Open shared SQLite at `data/chopperbot.db` (WAL, FK on).
2. Migrate the framework `users` directory (reserved capability id `__framework__`).
3. Instantiate the candidate capabilities, call `init()` on each **before Discord login**. A capability that throws is skipped; the bot continues with the rest.
4. Load channel→capability bindings: env-var seed → DB (via `ConfigurationCapability.bootStore()`) → build router.
5. Construct the Discord client, register handlers, `client.login()`.
6. Call each capability's optional `start()` for background work (instagram_monitor's scheduler starts here).

**Lazy deps gotcha:** `CapabilityInitDeps` exposes `getDiscordClient`, `getRegistry`, `getRouter`, `getUserDirectory` as **getters that throw if called during `init()`**. They are only safe to invoke at `buildTurn()` time (post-bootstrap). This is by design — capabilities that need them (configuration) capture the getters in `init()` and call them later.

### Per-turn flow (`src/discord/handlers.ts` → `src/llm/client.ts`)

1. Message arrives. Bot responds only if @-mentioned or a reply to one of its own messages in an authorized channel.
2. `userDirectory.upsert()` registers the Discord user (lazy, idempotent — bumps `last_seen_at`).
3. `buildHistory()` walks the reply chain backward (max 8 turns / 16k chars), strips the `_…sigue ↓_` continuation footer from bot turns, and reverses to chronological order.
4. `capability.buildTurn(ctx)` returns `{ system, tools }` for *this* message. Capabilities decide whether to rebuild every turn (calendar embeds an upcoming-events snapshot, configuration embeds current time) or cache.
5. `ask({ system, messages, tools })` drives a multi-turn agent loop against Kimi (max `MAX_TOOL_ITERATIONS`). Within a single `ask()` call, identical `(toolName, JSON-stable-input)` tool calls are deduplicated from a per-turn cache (only successful results are cached).
6. If the loop runs out of iterations while still emitting tool_calls, a final **forcing pass** runs the model **without tools** to extract a text answer instead of leaving the user with a fallback string.
7. Long replies are split by `chunkBotReply()` — markdown code fences are preserved across chunk boundaries (closed with ``` and reopened with the same language tag); non-tail chunks get the `_…sigue ↓_` footer so users know to reply to the last message.

### LLM client (`src/llm/client.ts`)

Moonshot Kimi Code via the OpenAI SDK. Two non-obvious behaviors:

- **User-Agent gating.** Requests with the default `openai-node` UA get a 403 ("Kimi For Coding is currently only available for Coding Agents…"). `KIMI_USER_AGENT` defaults to `claude-cli/1.0.0`, which passes. If the allowlist changes, override via env.
- **Reasoning content.** When thinking mode is on, every assistant turn (including tool_call turns) returns `reasoning_content`. The gateway rejects follow-ups that don't echo it back, so the loop re-attaches it to the assistant message before the next request.

### Capabilities and tools

Each Capability composes one or more `ToolSource`s via `composeToolSources()` (`src/tools/source.ts`). Tool specs are **provider-neutral** (`{ name, description, inputSchema }`); the LLM client is the only place that knows how to wrap them into OpenAI's `{ type: 'function', function: {...} }` shape. Tool name collisions across sources fail at boot — fix the duplicate, don't suppress.

### Persistence

Single SQLite file, **one row per capability+version in `_migrations`** (see `src/memory/migrations.ts`). Each capability owns its tables by **id-prefix convention** (`calendar_events`, `instagram_monitor_accounts`, `configuration_bindings`) — the framework does not enforce this, but the `configuration` capability's admin tools rely on it for scoped inspection.

`NamespacedMemory` wraps the shared store for one capability: it forwards `db()` to the raw handle but fixes `capabilityId` on `migrate()` so a capability cannot migrate another's tables. `__framework__` is reserved for framework-level state (currently just the user directory).

### Routing

`src/capabilities/routing.ts` builds a `MutableCapabilityRouter` from an initial channel→capability map. The `configuration` capability holds the only reference that can call `setBinding`/`removeBinding` — read-only consumers type their dep as the parent `CapabilityRouter`. Bindings are persisted to SQLite, so live re-bindings from chat survive restarts; **no bot restart needed when re-binding a channel.**

### Instagram monitor scheduler

`InstagramMonitorScheduler` ticks every minute (`DEFAULT_TICK_MS`), polls each due account every ~20 min (`DEFAULT_POLL_INTERVAL_MS`), with `ACCOUNTS_PER_TICK=3` and `MAX_PUSHES_PER_ACCOUNT_PER_TICK=5`. **First-ever poll for an account seeds the dedup anchor and does NOT backfill** — only posts strictly newer than the last seen IG post id are processed. Posts are pushed to Discord in chronological order even though the IG endpoint returns newest-first.

In production, IG fetches go through an AWS Lambda relay (`INSTAGRAM_RELAY_LAMBDA_ARN`, region `AWS_REGION_LAMBDA_RELAY`, default `us-west-2`) so the outbound IP rotates from the Lambda pool. Unset → direct fetch from this Node process (fine for dev, risks IP throttling in prod). Direct mode requires the spoofed `sec-fetch-*` headers in `fetcher.ts` because Node's undici sends `sec-fetch-site: cross-site` by default and IG rejects it with a 400.

## Env & configuration gotchas

- **dotenv `override: false`.** A stale `export KIMI_API_KEY=...` (or any other config var) in `~/.zshrc` shadows `.env`. The fix is `unset` in your shell, not flipping override — legitimate dev workflows depend on shell-var overrides.
- **Required** at boot: `DISCORD_TOKEN`, `CHOPPERBOT_CONFIG_CHANNEL_ID`, `KIMI_API_KEY`. Anything else has a default in the Zod schema.
- **`SECRETS_MANAGER_ID`** (optional) — if set, `src/secrets.ts` pulls a JSON secret from AWS Secrets Manager and merges into `process.env` **before** `config.ts` validates. Pre-existing env vars win.
- Three ways to seed channel→capability bindings via env (priority order, set in `src/config.ts`):
  1. `DISCORD_CHANNEL_CAPABILITIES` — preferred. JSON array of `{ guildId?, guildName?, channels: [{ id, capability }] }`.
  2. `DISCORD_AUTHORIZED_CHANNELS` — legacy: all listed channels run `DEFAULT_CAPABILITY`.
  3. `DISCORD_CHANNEL_ID` — legacy single channel.
  After first boot these only seed; the source of truth is the DB, managed live via the `configuration` capability.

## Logs & observability

The bot logs JSON via pino. For readable output pipe through `pino-pretty`: `pnpm run start | pino-pretty`.
