# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This is the always-loaded index — keep it slim.** `AGENTS.md` is a symlink to this file.

## Doc protocol — READ in, UPDATE out (mandatory)

`docs/` is the full documentation surface — a router + topic files, **never read whole**. Two rules bind every change:

> **① READ before you touch code.** Match your task to the routing table below and open *only* the listed doc(s); say which doc(s) you read before you start.
>
> **② UPDATE after you ship — gated on proof.** A change is not done until you hold *proof it worked* (green gates + observed behavior) AND the same topic doc reflects it — plus a `CHANGELOG.md` entry when user-visible. Edit this index only when commands, architecture, or the map itself change. Docs written ahead of proof rot the next agent's context (standing user directive: docs must not go stale).

## Documentation map (signal → READ first; UPDATE the same doc after)

| Working on… | Read first |
|---|---|
| **Onboarding / "what does this bot do?"** — one deep, self-contained tour of every RevZ capability, the live channel wiring, config reference, runbook and failure-mode index. **Orientation only — never the change-gated source of truth; the topic docs below are.** | [docs/revolucion-z-capabilities.md](docs/revolucion-z-capabilities.md) |
| LLM client — dual backend (selectable text brain, **live: Kimi** — recovered from the 2026-08-11 outage same day; DeepSeek takes over permanently 2026-08-23 / Nova vision), effort tiers, content-filter recovery, tool loop, health watchdog, image attachments | [docs/llm.md](docs/llm.md) |
| Framework internals — boot sequence, per-turn pipeline, tool composition, persistence, capability routing | [docs/framework.md](docs/framework.md) |
| `calendar` — global calendar, recurrence, PDF/ICS publishing, month rollover, daily announcements, Discord-event sync | [docs/capabilities/calendar.md](docs/capabilities/calendar.md) |
| `instagram_monitor` — scheduler, adaptive cadence + budget governor, anti-detection, guardrails/kill-switch | [docs/capabilities/instagram-monitor.md](docs/capabilities/instagram-monitor.md) |
| `workshop` — private LLM sessions, bwrap sandbox, file lifecycle, MinIO object storage | [docs/capabilities/workshop.md](docs/capabilities/workshop.md) |
| `event_intake` — ticket funnel → calendar events, mod authority, mod pings | [docs/capabilities/event-intake.md](docs/capabilities/event-intake.md) |
| `file_scanner` — VirusTotal uploads scanning | [docs/capabilities/file-scanner.md](docs/capabilities/file-scanner.md) |
| `general_chat` — community assistant, guild profiles, server-directory tools | [docs/capabilities/general-chat.md](docs/capabilities/general-chat.md) |
| `configuration` — admin console, `config_system action:health`, per-capability admin sources | [docs/capabilities/configuration.md](docs/capabilities/configuration.md) |
| Pi deployment, systemd unit, alert surfaces, crash-restart detection, logs | [docs/deployment.md](docs/deployment.md) |
| Any env var, config seeding rules, AWS account wiring | [docs/environment.md](docs/environment.md) |

## Commands

```bash
pnpm install            # install deps
pnpm run typecheck      # tsc --noEmit (strict)
pnpm run build          # tsc → dist/
pnpm run start          # node dist/index.js (prod entry)
pnpm run dev            # tsx watch src/index.ts

# Tests — vitest, real SQLite (`:memory:`), mocked Bedrock client.
npx vitest run                                                # full suite
npx vitest                                                    # watch mode
npx vitest run src/capabilities/calendar/__tests__/store.test.ts   # single file
npx vitest run -t "creates an event"                          # single test by name pattern

# Live e2e smoke against REAL Amazon Bedrock (NOT run by `pnpm test`; spends token budget):
npx tsx scripts/live-bedrock-smoke.ts
```

`vitest.setup.ts` pre-fills required env vars at module load so `src/config.ts` (which validates at import) doesn't crash test runs. Note dotenv also loads the host's real `.env` into the vitest process — assertions about an *unset* optional var must stub `config.<KEY>` and restore it.

## Release notes & versioning — IMPORTANT

The bot has a **community-facing release-notes channel** on Discord (`RELEASE_NOTES_CHANNEL_ID`, default `1519178790058725508`). Versioning is **semantic**; `package.json` `version` is the numeric source of truth. **`CHANGELOG.md`** is the source of truth for release *content* — each `## <version> — <YYYY-MM-DD>` section is written in **community-friendly Spanish** (no tech jargon) because that exact text is what gets posted to Discord.

```bash
pnpm run release                 # publish the latest (topmost) CHANGELOG version
pnpm run release 1.0.1           # publish a specific version
npx tsx scripts/publish-release.ts 1.0.1 --dry-run   # preview the post, send nothing
pnpm run release 1.0.1 --commit --push               # publish, THEN git add -A + commit + push
```

`scripts/publish-release.ts` is a **dev-side script** (NOT a runtime capability): logs into Discord with `DISCORD_TOKEN`, parses the version out of `CHANGELOG.md`, posts it. `RELEASE_NOTES_CHANNEL_ID` is read straight from the env and is **not** in the Zod schema. Always `--dry-run` first — posting is a live, hard-to-reverse community message. `--commit`/`--push` are opt-in, run only after a successful post, and stage the *whole working tree* (`git add -A`) — use them from a tree that's clean except for this release.

**Standing SHIP CHECKLIST for future sessions — when you ship a user-visible feature or fix, gate on GREEN, then release:**
1. **Verify it's green FIRST** — never publish red. At minimum: `pnpm run typecheck` + `npx vitest run` pass, `pnpm run build` succeeds, the service restarts `active (running)`, and where there's a runtime surface you've *observed the new behavior work* (drive it / check `journalctl`), not just trusted the tests.
2. Bump `package.json` `version` (PATCH for fixes, MINOR for new features, MAJOR for breaking changes).
3. Add a new dated section to `CHANGELOG.md` in community-friendly Spanish (this exact text is what posts to Discord).
4. **Update the relevant doc under `docs/`** (per the map above) so it keeps reflecting the live feature set — update this index only if commands/architecture/the map changed.
5. Commit + push the change, then **`--dry-run` the release** to preview, then publish for real: `pnpm run release <version>` (optionally `--commit --push`). Publishing to the community is live and hard to reverse — only do it once steps 1–4 are done and green. If unsure whether to post publicly, publish the code/commit but leave the Discord announcement for the user to confirm.

## Deployment — summary

The live deployment is a **Raspberry Pi** and **this repo directory IS that deployment**; a systemd **user** unit `chopperbot.service` runs `node dist/index.js` (`Restart=always`, boot autostart via linger). **Edits go live only after `pnpm run build` + `systemctl --user restart chopperbot.service`.** The unit is generated from `deploy/systemd/chopperbot.service` — keep that template in sync. Discord-facing alerts (IG monitor, LLM health, crash-restart detection) post to the config channel; there are no log files, everything is `journalctl --user -u chopperbot`. Full details (alert surface, lifecycle, macOS rollback artifacts, observability recipes): [docs/deployment.md](docs/deployment.md).

## Architecture

**One Discord channel = at most one specialized Capability**, with `general_chat` as the baseline fallback for any unbound guild channel. A Capability is a self-contained bundle of system prompt + tools + private SQLite namespace. Seven ship today:

- `configuration` — admin console, hardcoded to one channel → [doc](docs/capabilities/configuration.md)
- `calendar` — **global** server calendar: mods talk in the INPUT channel; month PDF/PNG + ICS publish to OUTPUT; daily event announcements to ANNOUNCE → [doc](docs/capabilities/calendar.md)
- `instagram_monitor` — global account list + fan-out to every bound channel, per-channel dedup → [doc](docs/capabilities/instagram-monitor.md)
- `file_scanner` — **passive, NOT channel-bound**: own `MessageCreate` listener scans non-image/video uploads with VirusTotal → [doc](docs/capabilities/file-scanner.md)
- `event_intake` — **passive, NOT channel-bound**: watches the ticket category, proposes normalized events, a MOD approves → calendar create → [doc](docs/capabilities/event-intake.md)
- `workshop` — **passive, NOT channel-bound**: react 🎓 in `#bienvenidx` → private channel with a web-LLM-style assistant (sandboxed Python, document skills, MinIO-backed files) → [doc](docs/capabilities/workshop.md)
- `general_chat` — **the community assistant**: answers @-mentions in unbound channels; guild profiles (today: Revolución Z) ground it in the community → [doc](docs/capabilities/general-chat.md)

`src/capabilities/redacted-ops/` ships in the repo but is **intentionally NOT registered** here (removed from `app.ts`'s `candidates` 2026-08-06 — registering it leaks it into general_chat's capability snapshot and the LLM advertised it to users). Kept for its separate deploy; do not add it back.

### Repository layout (where the big pieces live)

- `src/index.ts` → `src/app.ts` — process entry and boot wiring.
- `src/config.ts` — Zod-validated env config; **validates at import**, so a missing required var crashes the process (and any test that imports it — hence `vitest.setup.ts`).
- `src/lifecycle.ts` — signal handling + clean-vs-crash restart detection (drives the crash-restart Discord alert).
- `src/llm/` — the dual-backend LLM client (`client.ts`, the agent loop) and the health watchdog (`health.ts`) → [docs/llm.md](docs/llm.md).
- `src/discord/` — gateway `client.ts`, per-turn `handlers.ts`, reply-chain `history.ts`, reply splitting `chunk.ts`, the shared `admin-alert.ts`, and `mod-roles.ts` (approver roles + `<@&id>` notify-ability; pure, shared by event_intake, the config console and the calendar announcer so "who may approve" and "who gets pinged" can't drift).
- `src/capabilities/<name>/` — one self-contained dir per capability. `capability.ts` (interface), `registry.ts`, and `routing.ts` are the framework glue.
- `src/tools/source.ts` — provider-neutral `ToolSource` composition (`composeToolSources`); the LLM client is the only place that knows the wire shape.
- `src/memory/` — the shared SQLite store (`store.ts`) + the per-capability migration runner (`migrations.ts`).
- `src/storage/` — the provider-neutral object-storage layer (`ObjectStorage` in `object-storage.ts`): `minio.ts` (MinIO on the Pi's 1 TB SSD at `/srv/minio`, via `@aws-sdk/client-s3`, path-style, localhost endpoint), `local.ts` (dev/test backend), `index.ts` (the config-driven factory; returns `null` when `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` are unset → callers keep their pre-storage behavior). Used today by the workshop for durable session-file storage.
- `src/users/` — the framework Discord-user directory (the reserved `__framework__` namespace).
- `src/attachments/` — image (vision) resolution for incoming Discord attachments.
- `scripts/` — dev/proof/calibration scripts, **not tests** (some spend real Bedrock/IG budget — see the per-doc notes).
- `deploy/` — the reference `systemd/` unit (live) plus the decommissioned macOS `launchd/`+`bin/` artifacts (reference/rollback only).
- `calendar/` — the 7 Canva month-PDF templates; **tracked in git** and read at runtime from the repo root.
- `docs/` — the topic documentation routed by the map at the top of this file.

### Framework essentials — summary

Full details: [docs/framework.md](docs/framework.md). The load-bearing facts:

- **Boot:** capabilities `init()` before Discord login (a throwing capability is skipped, boot continues), bindings load from SQLite, `start()` runs background work after login. Init-time dep getters (`getDiscordClient`, `getRegistry`, …) throw during `init()` — call them at `buildTurn()` time.
- **Turns:** one shared `TurnQueue` (strict FIFO per channel, `MAX_CONCURRENT_TURNS`=3 across channels); `buildHistory` (8 turns/16k) → `buildTurn` → `ask()` agent loop (per-turn tool-call dedup; tools-free forcing pass at the iteration cap); replies chunk with fences preserved, `MAX_REPLY_CHUNKS`=5. Progress/reply delivery is a per-surface `TurnPresenter` (`src/discord/presenter.ts`): public channels = reactions (⏳🤔🛠️/❌) + typing ONLY; workshop sessions = the live status line that morphs into the reply.
- **Persistence:** one SQLite file, one `_migrations` row per capability+version, tables owned by id-prefix convention.
- **Routing:** channel→capability bindings persist in SQLite and re-bind live without restart; `configuration` holds the only mutable router reference.

## Env & configuration — summary

Full per-var reference and gotchas: [docs/environment.md](docs/environment.md). The universal rules:

- **dotenv `override: false`** — a stale `export FOO=...` in a shell rc shadows `.env`; `unset FOO`, don't flip override.
- **Required at boot:** `DISCORD_TOKEN`, `CHOPPERBOT_CONFIG_CHANNEL_ID`, the key for the selected text brain (`LLM_TEXT_BACKEND=kimi` → `KIMI_API_KEY`, the default; `=deepseek` → `DEEPSEEK_API_KEY`/`DEEP_SEEK_API_KEY`), `ACCESS_KEY_ID`+`SECRET_ACCESS_KEY` (the images-only Nova backend — required under every text backend, since no text brain can see images). Everything else has a schema default.
- **Channel settings seed-then-DB-wins:** env vars seed SQLite settings on first boot only; after that the DB is the source of truth, managed live from the config channel — no restart needed.

## Logs & observability — quick reference

```bash
journalctl --user -u chopperbot -f                    # live tail
journalctl --user -u chopperbot -f -o cat | npx pino-pretty   # pretty
journalctl --user -u chopperbot -b -n 100 --no-pager  # since boot / last 100 lines
```

JSON (pino) to stdout → journald; no log files. If `systemctl --user` over SSH says "Failed to connect to bus": `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. Key log lines and per-capability journal vocabulary: [docs/deployment.md](docs/deployment.md).
