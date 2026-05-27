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

As of 2026-05-27 the live deployment runs on a **Raspberry Pi** (`raspberrypi`, `aarch64`, Node 22 at `/usr/bin/node`), supervised by a **systemd user service**. This repo directory at `/home/burbujamc/Documentos/ChopperBot` **IS** that live deployment. The former macOS/launchd host was decommissioned; see `RASPBERRY_PI_MIGRATION.md` for the full migration record.

**Edits here affect the running bot — but only after `pnpm run build`**, since systemd runs `node dist/index.js` directly (not `pnpm`, not `tsx watch`). To pick up changes:

```bash
pnpm run build && systemctl --user restart chopperbot.service
systemctl --user status chopperbot.service        # confirm: active (running)
```

The single unit is **`chopperbot.service`** (a `systemd --user` unit at `~/.config/systemd/user/chopperbot.service`). It runs `node dist/index.js` with `WorkingDirectory=` the repo root (so dotenv reads `.env` from here), `Restart=always`/`RestartSec=15`, and a crashloop guard (`StartLimitIntervalSec=300`/`StartLimitBurst=10`). `loginctl enable-linger` is set so it starts at **boot** without an interactive login. Running `node` directly (no shell rc sourced) is deliberate — it stops a stale `export KIMI_API_KEY=...` in `~/.bashrc` from shadowing `.env`.

The unit is generated from the template at **`deploy/systemd/chopperbot.service`** by substituting two placeholders (`__REPO__` → repo root, `__NODE__` → node path). That snapshot is not auto-synced — if you change the installed unit, re-copy it into `deploy/` (and run `systemctl --user daemon-reload`).

**The three auxiliary launchd agents were intentionally NOT ported.** On the Mac, `com.user.chopperbot-watcher` (log-watcher → desktop notifications), `com.user.chopperbot-daily-summary` (21:00 notification), and `com.user.chopperbot-health-check` (every 30 min) all fired `osascript`/Sosumi notifications, and `chopperbot-status.sh` was a SwiftBar menu-bar plugin — none of that exists on a headless Pi. **On the Pi there are no timers and no watcher: observability is `journalctl` only** (see "Logs & observability"). In particular, the `instagram_monitor.auth.expired` log line that the Mac watcher turned into a notification now just sits in the journal — grep for it manually. If push alerts are wanted later, the cleanest add is a log-tail service POSTing to ntfy.sh or a Discord webhook (`deploy/bin/chopperbot-log-watcher.py` has the matching logic; only the `notify()` sink changes).

The old macOS artifacts are kept in **`deploy/`** purely for reference/rollback: `deploy/launchd/` = the 4 original plists, `deploy/bin/` = the 6 helper scripts. They are **not** used by the Pi.

## Architecture

**One Discord channel = at most one specialized Capability**, with `general_chat` as the baseline fallback for any unbound guild channel. A Capability is a self-contained bundle of system prompt + tools + private SQLite namespace. Four ship today:

- `configuration` — admin console, hardcoded to one channel.
- `calendar` — **per-user globally**: events belong to a Discord user, visible from any channel bound to the capability. No channel scoping. Daily/weekly/monthly recurrence.
- `instagram_monitor` — global account list + fan-out: one row per IG username, posts pushed to **every channel currently bound to the capability**. Per-channel dedup table gives newly-bound channels no backfill.
- `general_chat` — baseline conversation/redirect. Never bound to a channel; runs automatically when the bot is @-mentioned in any guild channel that has no specialized binding.

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

`InstagramMonitorScheduler` ticks every minute (`DEFAULT_TICK_MS`), polls each due account every ~20 min (`DEFAULT_POLL_INTERVAL_MS`), with `ACCOUNTS_PER_TICK=1` and `MAX_PUSHES_PER_ACCOUNT_PER_TICK_PER_CHANNEL=5`. **First-ever poll for an account seeds the dedup anchor and does NOT backfill** — only posts strictly newer than the last seen IG post id are processed.

**One account per tick + jitter (anti-burst).** Polling is one account per minute (never a synchronized burst), and `store.dueAccounts()` adds a deterministic per-(account, cycle) jitter of up to `POLL_JITTER_FRACTION` (50%) of the interval to each account's next-due time, so accounts decorrelate and requests scatter irregularly across the window. The jitter is stable within a cycle (so an account never flickers in/out of "due" between ticks) and reshuffles after each poll. This both looks less bot-like and reduces IP throttling.

**Pinned-post ordering gotcha.** Instagram returns *pinned* posts first, out of chronological order. The scheduler sorts fetched posts by `takenAtMs` before the dedup walk and anchor advance — otherwise a pinned (old) post sitting at array index 0 would freeze detection (the walk would hit the anchor immediately and never see newer posts below the pins).

**Anchor-missing gotcha (the dedup anchor is `(id, takenAtMs)`, not just an id).** The walk down to the anchor id assumes the anchor post is still in the returned window. IG sometimes returns a *stale or paginated* window that **omits** the anchor post (eventual consistency, or the post was deleted). The old code then treated the entire returned batch as "new" and **backfilled weeks-old posts**, and `markPollSuccess` moved the anchor *backward* to that batch's older newest — re-arming the backfill every poll. The fix: each account also stores `last_post_at` (the anchor's `takenAtMs`, added in store migration v3, backfilled from `MAX(seen_posts.posted_at)`). When the anchor id is present we still slice above it (preserving pinned handling); when it's **absent** we fall back to a strict capture-time gate (`takenAtMs > last_post_at`), and the anchor is only ever advanced *forward* in time. Watch for `instagram_monitor.anchor_missing.time_gated` (a stale window was rejected) and `…anchor_missing.reseed` (a legacy row with no recorded `last_post_at` re-seeding once).

**Accounts are global** (one row per username, `instagram_monitor_accounts.UNIQUE(username)`). On every detection cycle the scheduler reads the live router for the list of channels currently bound to `instagram_monitor` and **fans out each new post to every bound channel** with per-channel dedup via `instagram_monitor_seen_posts (ig_post_id, channel_id)`. Consequences:
- A newly-bound channel sees no backfill — its `seen_posts` rows start empty and the global `last_post_id` anchor is already current.
- If no channels are bound when a poll fires, the anchor still advances; no posts are classified or recorded as seen.
- Pause / remove / force-poll affect every bound channel.

Posts are pushed in chronological order even though the IG endpoint returns newest-first.

The `INSTAGRAM_RELAY_LAMBDA_ARN` Lambda relay exists in the code but is a **dead end in practice**: Instagram blocks all AWS (datacenter) IP ranges, so rotating within the Lambda pool doesn't help. The bot runs **direct** from the host's residential IP. Direct mode requires the spoofed `sec-fetch-*` headers in `fetcher.ts` because Node's undici sends `sec-fetch-site: cross-site` by default and IG rejects it with a 400.

**Two fetch modes in `DirectInstagramFetcher`:**
- **Anonymous** (no `IG_SESSIONID`): hits the public `web_profile_info` GraphQL endpoint. Returns timeline media but is heavily IP-throttled (frequent `401 require_login`).
- **Authenticated** (`IG_SESSIONID` + `IG_CSRFTOKEN` + `IG_DS_USER_ID` set, optional `IG_MID`/`IG_DID`): far higher rate limits. **Gotcha:** authed `web_profile_info` returns an *empty* timeline, so auth mode does a two-step fetch — resolve the account's numeric pk via `web_profile_info` (cached per handle), then read the private `feed/user/{pk}` endpoint (different REST item shape, parsed by `parseUserFeedBody`). The bare post id is recovered from the string `item.id` (`"{pk}_{owner}"`), not the numeric `item.pk` (which exceeds `Number.MAX_SAFE_INTEGER` and loses precision); this keeps dedup anchors consistent with the old GraphQL ids. Use a **throwaway** IG account — automated polling risks a ban.

**Session expiry → notification.** A 401/403 (or `require_login` body) on an *authenticated* request throws `InstagramAuthError`, which the scheduler logs as `instagram_monitor.auth.expired`. The launchd log-watcher (`chopperbot-log-watcher.py`) matches that msg and fires a macOS `auth-expired` notification (`chopperbot-notify.sh`, Sosumi, rate-limited 1/hr) telling the operator to refresh the cookies in `.env`. Editing the parser requires restarting the `com.user.chopperbot-watcher` agent.

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

The bot logs JSON (pino) to stdout, which systemd routes to **journald**. There are no log files on the Pi.

```bash
journalctl --user -u chopperbot -f                    # live tail
journalctl --user -u chopperbot -f -o cat | npx pino-pretty   # pretty
journalctl --user -u chopperbot -b -n 100 --no-pager  # since boot / last 100 lines
```

Log lines worth recognizing: `Discord client ready` (gateway up), `InstagramMonitorCapability scheduler started` then recurring `instagram_monitor.tick` (poller alive), `instagram_monitor.auth.expired` (**IG cookies expired** — refresh `IG_SESSIONID`/`IG_CSRFTOKEN`/`IG_DS_USER_ID` in `.env`, then `systemctl --user restart chopperbot.service`), and pino `level: 50/60` = warn/error/fatal.

For ad-hoc state (no status UI on the Pi), query SQLite directly, e.g. `sqlite3 data/chopperbot.db 'SELECT username, consecutive_failures, last_polled_at FROM instagram_monitor_accounts ORDER BY username;'`.

If `systemctl --user` over SSH says "Failed to connect to bus", the session has no user D-Bus: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.

For local dev (not the deployed service), `pnpm run start | pino-pretty` still works.
