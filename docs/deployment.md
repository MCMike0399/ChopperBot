# Deployment context — IMPORTANT

> Topic doc — part of the [CLAUDE.md](../CLAUDE.md) router. Read it BEFORE working in this area, and keep it current in the same change as any behavior change (doc protocol ①/② in the index).


As of 2026-05-27 the live deployment runs on a **Raspberry Pi** (`raspberrypi`, `aarch64`, Node 22 at `/usr/bin/node`), supervised by a **systemd user service**. This repo directory at `/home/burbujamc/Documentos/ChopperBot` **IS** that live deployment. The former macOS/launchd host was decommissioned; the full migration record is kept in a **local-only, gitignored** `RASPBERRY_PI_MIGRATION.md` on this host (it was scrubbed from the repo's git history, so it exists on disk here but not in the repository).

**Edits here affect the running bot — but only after `pnpm run build`**, since systemd runs `node dist/index.js` directly (not `pnpm`, not `tsx watch`). To pick up changes:

```bash
pnpm run build && systemctl --user restart chopperbot.service
systemctl --user status chopperbot.service        # confirm: active (running)
```

The single unit is **`chopperbot.service`** (a `systemd --user` unit at `~/.config/systemd/user/chopperbot.service`). It runs `node dist/index.js` with `WorkingDirectory=` the repo root (so dotenv reads `.env` from here), `Restart=always`/`RestartSec=15`, and a crashloop guard (`StartLimitIntervalSec=300`/`StartLimitBurst=10`). `loginctl enable-linger` is set so it starts at **boot** without an interactive login. Running `node` directly (no shell rc sourced) is deliberate — it stops a stale `export ACCESS_KEY_ID=...` in `~/.bashrc` from shadowing `.env`.

The unit is generated from the template at **`deploy/systemd/chopperbot.service`** by substituting two placeholders (`__REPO__` → repo root, `__NODE__` → node path). That snapshot is not auto-synced — if you change the installed unit, re-copy it into `deploy/` (and run `systemctl --user daemon-reload`).

**The three auxiliary launchd agents were intentionally NOT ported.** On the Mac, `com.user.chopperbot-watcher` (log-watcher → desktop notifications), `com.user.chopperbot-daily-summary` (21:00 notification), and `com.user.chopperbot-health-check` (every 30 min) all fired `osascript`/Sosumi notifications, and `chopperbot-status.sh` was a SwiftBar menu-bar plugin — none of that exists on a headless Pi. **On the Pi there are no timers and no log-watcher: the bot alerts the config Discord channel directly, and everything else is `journalctl`** (see "Logs & observability"). The alert surface (all through the shared `sendAdminAlert` in `src/discord/admin-alert.ts`, all Spanish, all swallow their own send errors):
- **IG monitor** (from the scheduler): auth-expired, circuit-breaker, budget-exhausted, polling-resumed, and the 21:00 daily status digest — see "Instagram monitor scheduler". These replaced the Mac watcher's role and revived the old `chopperbot-daily-summary`.
- **LLM health** (`src/llm/health.ts`, added 2026-06-12): every LLM call in `ask()` — **both** the Kimi (OpenAI SDK) text path and the Bedrock vision path — reports to `llmHealth`; deterministic 4xx (400/401/403/404/422 — config/protocol errors that never self-heal: an invalid Kimi API key, a `ValidationException`, revoked/insufficient IAM creds, a missing `bedrock:InvokeModel` permission, a bad model id) alert on the FIRST failure, transient errors (Throttling/5xx/network) after 3 consecutive, rate-limited to 1 per 6 h, with a one-shot recovery notice (`✅ LLM recuperado`) when service returns. Status lives on `err.status` (OpenAI SDK / Kimi) or `err.$metadata.httpStatusCode` (AWS SDK), with a name-based fallback (`Throttling*` transient, `Validation/AccessDenied/ResourceNotFound*` deterministic). Sink injected in `app.ts` post-login; without a sink (tests/scripts) it just logs (`llm.health.alerting` / `llm.health.recovered`). Verify end-to-end: `npx tsx scripts/verify-llm-alert.ts` (posts a clearly-marked synthetic alert).
  - **A third kind: `content_filter` (added 2026-08-06) — the provider refused ONE prompt, the backend is fine.** `isContentFilterRejection()` is checked BEFORE the status rules and matches a moderation refusal (a 400/403/451 whose message says `considered high risk` / `content filter` / `safety` / …). It **never alerts** and — critically — never touches `consecutiveFailures` or `alertedThisOutage`: it's counted on its own axis (`content_filter_rejections` + `last_content_filter_*` in the snapshot, reported by `config_system action:health`, which flags it as a *problem* only from 3 rejections up). The match is deliberately narrow so a genuine bad-parameter 400 (the `temperature` case) keeps its first-failure page.
  - **Why (live incident 2026-08-06 09:57 CST, `#💠club-de-cine`):** a member asked general_chat "¿qué deberíamos hacer con las personas que apoyan a china en este servidor?" and Moonshot returned `400 The request was rejected because it was considered high risk` (`param: "prompt"`). Under the old rules that 400 was *deterministic*, so the config channel got paged with "error de configuración — no se va a resolver solo" and then, two minutes later, `✅ LLM recuperado` on the next ordinary reply — two false signals for one moderated prompt. Meanwhile the member got the English `Sorry, I hit an error…`, which the channel read as the bot dodging the question. **Expect this to recur:** RevZ's own Estatutos are explicitly anti-imperialist and anti-Zionist, so members will keep asking a Chinese provider exactly the questions its risk filter is tuned against.
- **Crash restarts** (`src/lifecycle.ts`): SIGINT/SIGTERM write `data/.shutdown-clean`; boot consumes it and compares against `data/.boot-stamp`. Booted-before + no clean marker = the previous process died (crash/OOM/SIGKILL) and systemd revived it → `⚠️ ChopperBot se reinició tras un fallo` after login. Crashloop-debounced (previous boot <15 min ago → log `lifecycle.unclean_restart_detected` only, no Discord spam; systemd's StartLimitBurst caps the loop anyway). Note this means a `kill -9` test WILL page the channel.
If broader push alerts are ever wanted (phone push without Discord), the cleanest add is still a log-tail service POSTing to ntfy.sh (`deploy/bin/chopperbot-log-watcher.py` has the matching logic; only the `notify()` sink changes).

The old macOS artifacts are kept in **`deploy/`** purely for reference/rollback: `deploy/launchd/` = the 4 original plists, `deploy/bin/` = the 6 helper scripts. They are **not** used by the Pi.


## Logs & observability

The bot logs JSON (pino) to stdout, which systemd routes to **journald**. There are no log files on the Pi.

```bash
journalctl --user -u chopperbot -f                    # live tail
journalctl --user -u chopperbot -f -o cat | npx pino-pretty   # pretty
journalctl --user -u chopperbot -b -n 100 --no-pager  # since boot / last 100 lines
```

Log lines worth recognizing: `Discord client ready` (gateway up), `InstagramMonitorCapability scheduler started` then recurring `instagram_monitor.tick` (poller alive), `instagram_monitor.auth.expired` (**IG cookies expired** — refresh `IG_SESSIONID`/`IG_CSRFTOKEN`/`IG_DS_USER_ID` in `.env`, then `systemctl --user restart chopperbot.service`), `llm.health.alerting`/`llm.health.recovered` (Bedrock requests failing/recovered — mirrors the Discord alert), `lifecycle.unclean_restart_detected` (previous process crashed), and pino `level: 50/60` = warn/error/fatal.

For ad-hoc state (no status UI on the Pi), query SQLite directly, e.g. `sqlite3 data/chopperbot.db 'SELECT username, consecutive_failures, last_polled_at FROM instagram_monitor_accounts ORDER BY username;'`.

If `systemctl --user` over SSH says "Failed to connect to bus", the session has no user D-Bus: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.

For local dev (not the deployed service), `pnpm run start | pino-pretty` still works.
