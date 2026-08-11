# Framework internals

> Topic doc — part of the [CLAUDE.md](../CLAUDE.md) router. Read it BEFORE working in this area, and keep it current in the same change as any behavior change (doc protocol ①/② in the index).

The cross-cutting machinery every capability rides on: boot, the per-turn pipeline, tool composition, persistence, routing.

## Boot sequence (`src/app.ts`)

1. Open shared SQLite at `data/chopperbot.db` (WAL, FK on).
2. Migrate the framework `users` directory (reserved capability id `__framework__`).
3. Instantiate the candidate capabilities, call `init()` on each **before Discord login**. A capability that throws is skipped; the bot continues with the rest.
4. Load channel→capability bindings: env-var seed → DB (via `ConfigurationCapability.bootStore()`) → build router.
5. Construct the Discord client, register handlers, `client.login()`.
6. Call each capability's optional `start()` for background work (instagram_monitor's scheduler starts here).

**Lazy deps gotcha:** `CapabilityInitDeps` exposes `getDiscordClient`, `getRegistry`, `getRouter`, `getUserDirectory` as **getters that throw if called during `init()`**. They are only safe to invoke at `buildTurn()` time (post-bootstrap). This is by design — capabilities that need them (configuration) capture the getters in `init()` and call them later.

## Per-turn flow (`src/discord/handlers.ts` → `src/llm/client.ts`)

0b. **Conversation styles — `TurnPresenter` (v1.17.0, `src/discord/presenter.ts`).** How progress and the reply reach the user is a per-surface presenter the pipeline drives blindly (`onQueued`/`begin`/`onPhase`/`deliver`/`fail`/`discard`). Two styles ship: **public channels → `ReactionTurnPresenter`** — status reactions on the user's message + the native typing indicator (refreshed every **5 s**, kept alive until the first reply chunk actually posts — at 8 s a busy Pi event loop let Discord's ~10 s indicator lapse mid-turn and a member read it as "se trabó", live 2026-08-06) and **no extra bot messages, ever** (the v1.12.0 20 s escalation to a status line was removed 2026-08-11 by user directive — the rich status belongs to talleres); the reply is a normal Discord reply so `buildHistory`'s reply-chain walk keeps working, with a channel-send fallback if the user's message is gone. **Workshop sessions → `WorkshopTurnPresenter`** — the live status line that morphs into the reply (see docs/capabilities/workshop.md). `chunkBotReply` still caps a reply at `MAX_REPLY_CHUNKS` (5) with a Spanish truncation note. Presenters are tested against a fake-message op log (`src/discord/__tests__/presenter.test.ts`).

0. **Turn queue + status reactions (added 2026-08-06, v1.11.0).** Every message-driven turn (main handler AND workshop sessions — one shared `TurnQueue` built in `app.ts`) runs through `src/discord/turn-queue.ts`: strict **FIFO per channel** (a queued turn builds its history only when it starts, so it sees the previous reply) and at most `MAX_CONCURRENT_TURNS` (3) executing across channels; a >5-deep channel backlog gets the polite `QUEUE_BUSY_REPLY`. Separately, `KIMI_MAX_CONCURRENT` (default **1**) gates concurrent Kimi HTTP *requests* inside `llm/client.ts` (`gate.ts` semaphore, FIFO with atomic slot handoff) — requests, not whole turns, so two agent loops interleave. This is the fix for the live 2026-08-05 failure where two overlapping mentions made one turn return empty content. Progress is shown as a **status reaction** on the user's message (`status-reactions.ts`, replaces the old single 🔍): ⏳ queued → 🤔 thinking → 🛠️ tool running → removed on success / ❌ kept on failure, driven by the `onPhase` callback `ask()` now accepts.
1. Message arrives. Bot responds only if @-mentioned or a reply to one of its own messages in an authorized channel.
2. `userDirectory.upsert()` registers the Discord user (lazy, idempotent — bumps `last_seen_at`).
3. `buildHistory()` walks the reply chain backward (max 8 turns / 16k chars), strips the `_…sigue ↓_` continuation footer from bot turns, and reverses to chronological order. `normalizeTurns()` then merges consecutive same-role turns and — since **v1.16.0** — **folds** any *leading* assistant turns into the first user turn as a quoted `[Contexto — mensaje anterior de ChopperBot…]` block instead of dropping them. That drop was silently fatal for **bot-initiated** threads: the calendar's "falta crear el evento de Discord" nudge, the daily announcement and admin alerts all speak first, so a mod replying to one produced a window whose only history turn was that bot message — deleted, leaving the model a context-free `"crea el evento"`. Live 2026-08-10 (`historyTurns: 1`, `toolCalls: 0`): the bot answered its own nudge about event #29 with "¿qué evento quieres crear?" and asked for a title and a date it had itself just published. The API constraint is only that the sequence *start* with a user turn — that never required destroying content.
4. `capability.buildTurn(ctx)` returns `{ system, tools }` for *this* message. Capabilities decide whether to rebuild every turn (calendar embeds an upcoming-events snapshot, configuration embeds current time) or cache.
5. `ask({ system, messages, tools })` drives a multi-turn agent loop against Bedrock (max `MAX_TOOL_ITERATIONS`). Within a single `ask()` call, identical `(toolName, JSON-stable-input)` tool calls are deduplicated from a per-turn cache (only successful results are cached).
6. If the loop runs out of iterations while still emitting tool_calls, a final **forcing pass** runs the model **without tools** to extract a text answer instead of leaving the user with a fallback string.
7. Long replies are split by `chunkBotReply()` — markdown code fences are preserved across chunk boundaries (closed with ``` and reopened with the same language tag); non-tail chunks get the `_…sigue ↓_` footer so users know to reply to the last message.


## Capabilities and tools

Each Capability composes one or more `ToolSource`s via `composeToolSources()` (`src/tools/source.ts`). Tool specs are **provider-neutral** (`{ name, description, inputSchema }`); the LLM client is the only place that knows how to wrap them into Bedrock Converse's `{ toolSpec: { name, description, inputSchema: { json } } }` shape. Tool name collisions across sources fail at boot — fix the duplicate, don't suppress.

## Persistence

Single SQLite file, **one row per capability+version in `_migrations`** (see `src/memory/migrations.ts`). Each capability owns its tables by **id-prefix convention** (`calendar_events`, `instagram_monitor_accounts`, `configuration_bindings`) — the framework does not enforce this, but the `configuration` capability's admin tools rely on it for scoped inspection.

`NamespacedMemory` wraps the shared store for one capability: it forwards `db()` to the raw handle but fixes `capabilityId` on `migrate()` so a capability cannot migrate another's tables. `__framework__` is reserved for framework-level state (currently just the user directory).


## Routing

`src/capabilities/routing.ts` builds a `MutableCapabilityRouter` from an initial channel→capability map. The `configuration` capability holds the only reference that can call `setBinding`/`removeBinding` — read-only consumers type their dep as the parent `CapabilityRouter`. Bindings are persisted to SQLite, so live re-bindings from chat survive restarts; **no bot restart needed when re-binding a channel.**

