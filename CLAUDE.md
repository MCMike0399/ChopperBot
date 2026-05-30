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

As of 2026-05-27 the live deployment runs on a **Raspberry Pi** (`raspberrypi`, `aarch64`, Node 22 at `/usr/bin/node`), supervised by a **systemd user service**. This repo directory at `/home/burbujamc/Documentos/ChopperBot` **IS** that live deployment. The former macOS/launchd host was decommissioned; the full migration record is kept in a **local-only, gitignored** `RASPBERRY_PI_MIGRATION.md` on this host (it was scrubbed from the repo's git history, so it exists on disk here but not in the repository).

**Edits here affect the running bot — but only after `pnpm run build`**, since systemd runs `node dist/index.js` directly (not `pnpm`, not `tsx watch`). To pick up changes:

```bash
pnpm run build && systemctl --user restart chopperbot.service
systemctl --user status chopperbot.service        # confirm: active (running)
```

The single unit is **`chopperbot.service`** (a `systemd --user` unit at `~/.config/systemd/user/chopperbot.service`). It runs `node dist/index.js` with `WorkingDirectory=` the repo root (so dotenv reads `.env` from here), `Restart=always`/`RestartSec=15`, and a crashloop guard (`StartLimitIntervalSec=300`/`StartLimitBurst=10`). `loginctl enable-linger` is set so it starts at **boot** without an interactive login. Running `node` directly (no shell rc sourced) is deliberate — it stops a stale `export KIMI_API_KEY=...` in `~/.bashrc` from shadowing `.env`.

The unit is generated from the template at **`deploy/systemd/chopperbot.service`** by substituting two placeholders (`__REPO__` → repo root, `__NODE__` → node path). That snapshot is not auto-synced — if you change the installed unit, re-copy it into `deploy/` (and run `systemctl --user daemon-reload`).

**The three auxiliary launchd agents were intentionally NOT ported.** On the Mac, `com.user.chopperbot-watcher` (log-watcher → desktop notifications), `com.user.chopperbot-daily-summary` (21:00 notification), and `com.user.chopperbot-health-check` (every 30 min) all fired `osascript`/Sosumi notifications, and `chopperbot-status.sh` was a SwiftBar menu-bar plugin — none of that exists on a headless Pi. **On the Pi there are no timers and no log-watcher: observability is `journalctl` only** (see "Logs & observability"). The one exception is the IG monitor, which now alerts the **config Discord channel directly** from the scheduler (auth-expired, circuit-breaker, budget, polling-resumed, and a 21:00 daily status digest — see "Instagram monitor scheduler"), replacing the Mac watcher's role for those signals and reviving the old `chopperbot-daily-summary` 21:00 notification. Other notable log lines (e.g. crashes) still just sit in the journal — grep for them manually. If broader push alerts are wanted, the cleanest add is a log-tail service POSTing to ntfy.sh or a Discord webhook (`deploy/bin/chopperbot-log-watcher.py` has the matching logic; only the `notify()` sink changes).

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

### Image attachments (vision input, `src/attachments/`)

The bot accepts **images only** — the Kimi Code API rejects documents (PDF/csv/docx), so `resolveAttachments()` drops anything that isn't `png`/`jpeg`/`gif`/`webp` (detected by content-type first, then file extension) with a `Unsupported attachment type, skipping` warning. It is called in `handlers.ts` *before* `buildTurn()` and attaches the resolved images to the user `Turn`. Caps (config): `MAX_ATTACHMENT_COUNT` (5 — extras silently ignored) and `MAX_ATTACHMENT_BYTES` (10 MB — oversize skipped); downloads have a 30 s abort timeout and a failed download is logged, not fatal. In `llm/client.ts`, `buildUserOrAssistantMessage()` only emits OpenAI multi-part `content` (a `text` part + one `image_url` part per image, base64 `data:` URI via `ImageAttachable.toContentPart()`) **when attachments are present** — a plain-text turn stays a plain string. Attachments ride only the *current* user turn; history turns reconstructed by `buildHistory()` carry text only.

### Capabilities and tools

Each Capability composes one or more `ToolSource`s via `composeToolSources()` (`src/tools/source.ts`). Tool specs are **provider-neutral** (`{ name, description, inputSchema }`); the LLM client is the only place that knows how to wrap them into OpenAI's `{ type: 'function', function: {...} }` shape. Tool name collisions across sources fail at boot — fix the duplicate, don't suppress.

### Persistence

Single SQLite file, **one row per capability+version in `_migrations`** (see `src/memory/migrations.ts`). Each capability owns its tables by **id-prefix convention** (`calendar_events`, `instagram_monitor_accounts`, `configuration_bindings`) — the framework does not enforce this, but the `configuration` capability's admin tools rely on it for scoped inspection.

`NamespacedMemory` wraps the shared store for one capability: it forwards `db()` to the raw handle but fixes `capabilityId` on `migrate()` so a capability cannot migrate another's tables. `__framework__` is reserved for framework-level state (currently just the user directory).

### Routing

`src/capabilities/routing.ts` builds a `MutableCapabilityRouter` from an initial channel→capability map. The `configuration` capability holds the only reference that can call `setBinding`/`removeBinding` — read-only consumers type their dep as the parent `CapabilityRouter`. Bindings are persisted to SQLite, so live re-bindings from chat survive restarts; **no bot restart needed when re-binding a channel.**

### Instagram monitor scheduler

`InstagramMonitorScheduler` ticks every minute (`DEFAULT_TICK_MS`), polling at most `ACCOUNTS_PER_TICK=1` due account per tick (`MAX_PUSHES_PER_ACCOUNT_PER_TICK_PER_CHANNEL=5`). Each account's poll interval is **adaptive** — learned from its own posting cadence (see "Adaptive polling & budget governor" below), not a flat 60 min; `DEFAULT_POLL_INTERVAL_MS` (60 min) now survives only as the scheduler's nominal/log value (the per-account cold-start fallback is 12 h). **First-ever poll for an account seeds the dedup anchor and does NOT backfill** — only posts strictly newer than the last seen IG post id are processed.

**One account per tick + jitter (anti-burst).** Polling is one account per minute (never a synchronized burst), and `store.dueAccounts()` adds a per-account jitter of up to `POLL_JITTER_FRACTION` (50%, now defined in `store.ts`) of **that account's own adaptive interval** to its next-due time, so accounts decorrelate and requests scatter irregularly across the window. This both looks less bot-like and reduces IP throttling.

**Anti-detection layers (see scheduler.ts / fetcher.ts).** Designed to survive IG automation detection on a *personal* account (a banned account is catastrophic):
- **Quiet hours** 02:00–07:00 America/Mexico_City, with a deterministic per-day ±20-min jitter on each edge (`inQuietHours`) so the resume time isn't a fixed daily tell.
- **~8% random whole-tick skips** (`tickSkipProbability`, set in `capability.ts`) so polling isn't a perfect metronome.
- **Per-poll randomness in `fetcher.ts`**: 50%-probability HTML warmup + 1–3 s delay, a 400–1500 ms human delay between the pk-resolve and the feed request, and a randomized feed `count` (10–16).
- **`IG_USER_AGENT`** is sent on every API *and* CDN request (`publisher.ts` shares it via `setIgCdnUserAgent`) — set it to **match the browser the cookies were extracted from**; a mismatched UA is a fingerprint signal.

**Adaptive polling & budget governor (store migrations v6 + v7, added 2026-05-29).** A flat 60-min cadence starved the 120-request budget across many accounts, round-robining it equally so a 6-day-cadence account got the same share as a 2-hour one. Now each account's interval is **learned from its own `posted_at` history** and the budget is spent where posts actually happen. Detection *latency* varies, not coverage (the feed returns 10–16 items, so a longer interval can't miss posts unless an account posts >~10× within it — only the most active accounts, which get the shortest intervals).
- `computeCadenceInterval()` (in `store.ts`, pure + unit-tested) takes an account's distinct recent post times (**deduped across channels** — `seen_posts` is per-channel, so the query `GROUP BY ig_post_id` or the median halves) and returns `interval = clamp(median_inter-post_gap × 0.5, 45 min, 12 h)`, with a recency-decay stretch toward MAX once an account goes quiet, and a coverage clamp. (The ceiling was raised 6 h → 12 h on 2026-05-30: live data showed the 6 h cap was clamping genuinely-rare accounts — e.g. `semillasderebeldia` ~20 h median gap wants ~10 h, `revueltasperiodico` ~26 h wants ~13 h — to roughly half their natural interval, wasting the request budget the active accounts need. Per-account interval is purely a budget lever; IG rate-limits on the *session's* aggregate rate, not per-account, so a longer ceiling carries no extra ban risk.) It returns `null` (→ cold-start) until there are ≥ `CADENCE_MIN_SAMPLES` (5) posts spanning ≥ `CADENCE_MIN_SPAN_MS` (**24 h**) — `MIN_SAMPLES` rejects tiny bursts; the 24 h span rejects a single-afternoon flurry while still accepting a real multi-day cadence (a 26-post/2.9-day account would be wrongly rejected at a 3-day threshold).
- **Cold start** (`CADENCE_COLD_START_INTERVAL_MS` = 12 h, kept == MAX): accounts without a trusted cadence poll slowly *on purpose* — few posts ⇒ empirically a rare poster, so we don't burn budget on unknowns; they speed up automatically as history accrues. (This is why the default fallback is 12 h, not the old 60 min. Polling slowly does NOT slow learning — cadence is learned from detected posts, and a 12 h interval can't miss a rare account's posts since the feed window holds 10–16.)
- The interval is cached on `instagram_monitor_accounts` (`poll_interval_ms`, `posts_per_day`, `cadence_updated_at`; **v6**) and read by `dueAccounts()` via `effectiveBaseIntervalMs()` = `(poll_interval_ms ?? cold-start) × poll_stretch`, clamped to MAX. The failure-backoff cap is decoupled to `min(base × 2^failures, max(MAX_BACKOFF_MS, base))` — `MAX_BACKOFF_MS` stays 6 h while the cadence ceiling is now 12 h, so this `max(…)` guard genuinely binds: a 12 h-cadence account with failures still polls every ~12 h, not exponentially slower.
- **Budget governor** (`computeGovernorStretch()`): a single global `poll_stretch` (runtime row, **v7**) raised above 1.0 so the **realized** projected daily requests stay ≤ `IG_DAILY_REQUEST_BUDGET × CADENCE_BUDGET_HEADROOM` (**0.75**). It is **clamp-aware** (fixed 2026-05-30): because `interval × stretch` saturates at the 12 h ceiling, an already-maxed account contributes a fixed request rate the stretch can't reduce — so the old `projected / ceiling` closed form under-corrected whenever accounts sat at the clamp, letting realized spend overshoot. The governor now binary-searches the smallest `stretch` whose *realized* (post-clamp) projection `Σ (activeFraction × day / min(interval × stretch, MAX)) × callsPerPoll` (callsPerPoll 1.5 — feed + ~50% warmup, pk cached) meets the ceiling; one multiplier preserves the active-vs-rare allocation, and the hard budget gate stays the backstop. The 25% headroom now only absorbs the restart pk-resolve burst + warmup variance.
- **Recompute triggers:** opportunistically right after a poll detects new posts (single account, in `processAccount`), and a once-per-`CADENCE_TTL_MS` (24 h) sweep over all accounts from the tick's `finally` block (`recomputeAllCadence`, which also recomputes `poll_stretch`). The sweep runs **even while polling is paused** (pure SQLite, no IG calls) — recomputing cadence is exactly what lets a budget-pinned monitor shrink its intervals and recover. Log line: `instagram_monitor.cadence_sweep` (`swept` count + `stretch` + `projected`).

Net effect on the real 14-account deployment (measured against the live DB on 2026-05-30, after the 12 h ceiling + clamp-aware governor): genuinely-rare accounts relax to 12 h (e.g. `revueltasperiodico`, `red.savia.urbana`, the 5 low-data cold-starts), which — combined with the governor now correctly accounting for the clamp — drops `poll_stretch` from **≈2.0 → ≈1.1** and **realized** spend from **~108 → ~90 calls/day** (exactly the `0.75 × 120` ceiling, a comfortable 25 % under the hard cap). The freed budget flows to active accounts: `yoxlas40horas`'s effective interval drops ~1.5 h → ~50 min (near its 45-min floor / true cadence) instead of being throttled to subsidize maxed-out rare accounts. The earlier symptom — `budget_exhausted` firing repeatedly during evening peak hours (~100 ticks in a 2 h window) — stops. Live convergence: the cold-start change + governor apply on the first post-restart tick; the rare accounts' cached 6 h intervals recompute to their true 10–12 h on the next daily `cadence_sweep` (≤ 24 h, or sooner via the opportunistic recompute when they next post).

**Guardrails / circuit breaker — the bot STOPS instead of escalating into a ban.** State lives in the `instagram_monitor_runtime` table (store migration **v5**, a single row id=1) so it survives restarts; `clearFailureBackoff()` deliberately never touches it.
- **429 / throttle** → `InstagramRateLimitError` → global in-memory cooldown (base 2 h, ×2 per throttle in a 6 h window, cap 12 h); halts ALL polling. Two throttles in 6 h trips the persistent kill-switch.
- **Persistent kill-switch (`global_stop`)** — manual-resume-only. Trips on a SESSION-level auth failure (`require_login`/checkpoint/challenge — see below) or repeated throttles, fires `postCircuitBrokenAlert` to the config channel, and **stays stopped across restarts** until an operator runs `config_instagram action:resume_monitor confirm:true`. `tickOnce()` reads the row first and returns early while stopped (`instagram_monitor.tick.global_stop`).
- **Session vs account-specific auth failures.** `InstagramAuthError.sessionLevel` is true only for `require_login`/checkpoint/challenge/consent (the cookies/account are flagged → halt everything + trip). A **bare 401/403 on one handle** (private/restricted/blocked-relative-to-your-account, or transient) is logged `instagram_monitor.account_auth_failed` and only bumps that account's `consecutive_auth_failures` → it auto-pauses at `AUTH_PAUSE_THRESHOLD` (5) via `dueAccounts()` while the other accounts keep polling. **Do not** treat a per-account 401 as session death — that would stop the whole monitor over one bad handle.
- **Daily request budget** `IG_DAILY_REQUEST_BUDGET` (default 120) — a rolling-24 h ceiling on outbound IG HTTP calls (the scheduler counts them via `fetcher.observeRequests`); on hit, polling soft-pauses (auto-recovers as the window drains) + one alert (`postBudgetExhaustedAlert`), and `postResumedAlert` fires once on recovery. One poll ≈ **1.5 calls steady-state** (feed + ~50 % warmup; pk-resolve is cached after the first poll, so ~2–3 calls only on the first poll of each account after a restart). The adaptive **budget governor** (above) keeps the steady-state projection below this ceiling, so it should rarely trip.
- **Admin visibility**: `config_instagram action:status` reports kill-switch state/reason, active cooldowns, 24 h request count, paused/auth-blocked counts, an `adaptive` block (accounts with a learned cadence + the governor `poll_stretch`), and a `digest_preview` (the exact daily-digest text). `action:digest_now` returns that digest on demand; `action:list` now includes each account's `poll_interval_min` / `posts_per_day`. The scheduler mirrors its in-memory cooldowns into the runtime row once per tick (`writeHeartbeat`) so the (DB-only) admin tool can see them.

**Pinned-post ordering gotcha.** Instagram returns *pinned* posts first, out of chronological order. The scheduler sorts fetched posts by `takenAtMs` before the dedup walk and anchor advance — otherwise a pinned (old) post sitting at array index 0 would freeze detection (the walk would hit the anchor immediately and never see newer posts below the pins).

**Anchor-missing gotcha (the dedup anchor is `(id, takenAtMs)`, not just an id).** The walk down to the anchor id assumes the anchor post is still in the returned window. IG sometimes returns a *stale or paginated* window that **omits** the anchor post (eventual consistency, or the post was deleted). The old code then treated the entire returned batch as "new" and **backfilled weeks-old posts**, and `markPollSuccess` moved the anchor *backward* to that batch's older newest — re-arming the backfill every poll. The fix: each account also stores `last_post_at` (the anchor's `takenAtMs`, added in store migration v3, backfilled from `MAX(seen_posts.posted_at)`). When the anchor id is present we still slice above it (preserving pinned handling); when it's **absent** we fall back to a strict capture-time gate (`takenAtMs > last_post_at`), and the anchor is only ever advanced *forward* in time. Watch for `instagram_monitor.anchor_missing.time_gated` (a stale window was rejected) and `…anchor_missing.reseed` (a legacy row with no recorded `last_post_at` re-seeding once).

**Accounts are global** (one row per username, `instagram_monitor_accounts.UNIQUE(username)`). On every detection cycle the scheduler reads the live router for the list of channels currently bound to `instagram_monitor` and **fans out each new post to every bound channel** with per-channel dedup via `instagram_monitor_seen_posts (ig_post_id, channel_id)`. Consequences:
- A newly-bound channel sees no backfill — its `seen_posts` rows start empty and the global `last_post_id` anchor is already current.
- If no channels are bound when a poll fires, the anchor still advances; no posts are classified or recorded as seen.
- Pause / remove / force-poll affect every bound channel.

Posts are pushed in chronological order even though the IG endpoint returns newest-first.

The bot fetches **direct** from the host's residential IP — there is no longer any fetch indirection. (A former `INSTAGRAM_RELAY_LAMBDA_ARN` AWS Lambda relay was removed on 2026-05-30: Instagram blocks all AWS datacenter IP ranges, so rotating within the Lambda pool never helped, and it was unused.) Direct mode requires the spoofed `sec-fetch-*` headers in `fetcher.ts` because Node's undici sends `sec-fetch-site: cross-site` by default and IG rejects it with a 400.

**Two fetch modes in `DirectInstagramFetcher`:**
- **Anonymous** (no `IG_SESSIONID`): hits the public `web_profile_info` GraphQL endpoint. Returns timeline media but is heavily IP-throttled (frequent `401 require_login`).
- **Authenticated** (`IG_SESSIONID` + `IG_CSRFTOKEN` + `IG_DS_USER_ID` set, optional `IG_MID`/`IG_DID`): far higher rate limits. **Gotcha:** authed `web_profile_info` returns an *empty* timeline, so auth mode does a two-step fetch — resolve the account's numeric pk via `web_profile_info` (cached per handle), then read the private `feed/user/{pk}` endpoint (different REST item shape, parsed by `parseUserFeedBody`). The bare post id is recovered from the string `item.id` (`"{pk}_{owner}"`), not the numeric `item.pk` (which exceeds `Number.MAX_SAFE_INTEGER` and loses precision); this keeps dedup anchors consistent with the old GraphQL ids. The deployment now uses a **personal** IG account (the throwaway was flagged after ~4 days), which is why the guardrails above (hard stop on real signals, UA matching the cookie source, low/irregular volume) exist — automated polling always carries some ban risk.

**Session expiry → Discord alert.** A SESSION-level auth failure (`require_login` body, or checkpoint/challenge) throws `InstagramAuthError` with `sessionLevel=true`; the scheduler logs `instagram_monitor.auth.expired`, posts `postAuthExpiredAlert` to the config channel (rate-limited 1/6 h), and trips the kill-switch. To recover: clear any challenge in the IG app, refresh `IG_SESSIONID`/`IG_CSRFTOKEN`/`IG_DS_USER_ID` (+`IG_MID`/`IG_DID`) in `.env` from the **same browser** as `IG_USER_AGENT`, `pnpm run build && systemctl --user restart chopperbot.service`, then `config_instagram action:resume_monitor confirm:true`. (The old macOS launchd watcher that turned the log line into a Sosumi notification does not exist on the Pi — the bot now alerts Discord directly.)

**Resume alert + daily status digest (config channel).** Two operator-facing signals sit alongside the pause alerts:
- `postResumedAlert` (`✅ sondeo REANUDADO`) fires once when polling resumes after an **abnormal** pause — budget window drained, rate-limit cooldown elapsed, or the kill-switch cleared. The scheduler tracks one `lastBlockReason` set at each abnormal gate (NOT quiet-hours/random-skip, which are normal and leave it untouched) and emits at the proceed-point, debounced (`MIN_PAUSE_FOR_RESUME_MS` 10 min + `RESUME_ALERT_COOLDOWN_MS` 30 min) so a flapping budget can't spam. Seeded from `global_stop` in `start()` so a kill-switch cleared after a restart still alerts once. Log: `instagram_monitor.tick.resumed`.
- A **daily status digest** posts at `STATUS_DIGEST_HOUR` (21:00 America/Mexico_City) from the tick's `finally` block (so it runs regardless of the gates above), once per local day (`instagram_monitor_runtime.last_digest_at`, stamped *after* a successful send so a failed send — e.g. a restart landing in the digest hour before Discord is reachable — retries next tick). `formatStatusDigest()` (`format.ts`, shared with the admin `status`/`digest_now` so they can't drift) renders overall state, 24 h budget/headroom, governor stretch, and a per-account table (cadence, effective interval, last-post age, next-poll ETA, flags), truncated under Discord's 2000-char limit. This revives the role of the decommissioned macOS 21:00 daily-summary.

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
