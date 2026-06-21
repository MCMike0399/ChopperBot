# ChopperBot

A multi-capability Discord assistant for a fintech/community project, powered by the Moonshot Kimi Code API. Each authorized Discord channel is bound to exactly one **Capability** — a self-contained bundle of system prompt, tools, and a private SQLite namespace. Bindings are managed live from chat via an admin console; no restart needed. Any unbound channel where the bot is @-mentioned falls back to `general_chat`. Image attachments (PNG/JPEG/GIF/WebP) are forwarded to the model as vision input in any capability; documents are not supported.

Four capabilities ship in this repo:

| Capability | What it does |
|---|---|
| `configuration` | Admin console hard-bound to one Discord channel (`CHOPPERBOT_CONFIG_CHANNEL_ID`). Bind/unbind channels to capabilities, inspect the SQLite DB, list registered capabilities, and run scoped per-capability data admin — including full Instagram-monitor control (status, pause/resume, force-poll, kill-switch reset). |
| `calendar` | A **global** server calendar — one shared set of events (rewritten from the old per-user model 2026-06-21). Mods manage events in natural language from a bound **input** channel; every create/update/delete is persisted, rendered into the month's PDF/PNG template, and published with a master ICS to a separate **output** channel. Daily / weekly / monthly recurrence with an optional end date and per-occurrence exceptions ("just this day" / "this and following" / "the whole series"). |
| `instagram_monitor` | Background poller over a **global** list of public Instagram accounts. It classifies each new post with Kimi in Spanish (`evento` / `convocatoria` / `alerta` / `acuerpamiento` / `actualización` / `noticia` / `otro`) and fans the relevant ones — media re-uploaded as a Discord attachment — out to **every** channel bound to the capability. Polling cadence is **adaptive** (learned from each account's own posting history) under a daily request budget, with anti-detection jitter/quiet-hours and a persistent kill-switch that halts on real ban signals. |
| `general_chat` | The baseline conversation. Never bound to a channel — it runs automatically when the bot is @-mentioned in any guild channel that has no specialized binding. Introduces the bot and redirects the user to the right channel. |

## Stack

- TypeScript (strict) on Node ≥ 20 (the live deployment runs Node 22)
- [discord.js](https://discord.js.org/) for the Discord gateway client
- [Moonshot Kimi Code](https://www.kimi.com/code/console) via the OpenAI-compatible SDK (`kimi-for-coding` model)
- SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL) for all persistence — one file, namespaced per capability
- [pino](https://getpino.io/) for structured JSON logs
- [vitest](https://vitest.dev/) for tests

## Quickstart

```bash
pnpm install
cp .env.example .env && $EDITOR .env   # set DISCORD_TOKEN, CHOPPERBOT_CONFIG_CHANNEL_ID, KIMI_API_KEY
pnpm run typecheck
pnpm test
pnpm run build
pnpm run start
```

**Required** env vars: `DISCORD_TOKEN`, `CHOPPERBOT_CONFIG_CHANNEL_ID`, `KIMI_API_KEY`. Everything else has a default — see `.env.example` for the full list (Kimi base URL / model / User-Agent, attachment caps, Instagram session cookies and request budget, etc.).

The bot logs JSON via pino; pipe through `pino-pretty` for readable output:

```bash
pnpm run start | pino-pretty
```

## Configuration & bindings

The `configuration` capability is hard-bound to `CHOPPERBOT_CONFIG_CHANNEL_ID`. From that channel you @-mention the bot to bind other channels to capabilities, inspect tables, and administer the Instagram monitor. Bindings persist in SQLite, so live re-bindings survive restarts — **no restart needed to re-route a channel.**

Initial bindings can also be seeded via env (priority order; after first boot these only seed — the DB is the source of truth):

1. `DISCORD_CHANNEL_CAPABILITIES` — preferred. JSON array of `{ guildId?, guildName?, channels: [{ id, capability }] }`.
2. `DISCORD_AUTHORIZED_CHANNELS` — legacy: all listed channels run `DEFAULT_CAPABILITY`.
3. `DISCORD_CHANNEL_ID` — legacy single channel.

## Adding a capability

Each capability is a class implementing the `Capability` interface in `src/capabilities/capability.ts`:

```ts
export interface Capability {
  readonly id: string;
  readonly description: string;
  init(deps: CapabilityInitDeps): Promise<void>;                        // boot, before Discord login
  buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle>; // per user message
  start?(deps: CapabilityStartDeps): Promise<void>;                     // optional, post-login background work
  dispose?(): Promise<void>;                                            // optional, shutdown
}
```

`init()` runs at boot before Discord login (load prompts, run migrations). `buildTurn()` returns `{ system, tools }` per user message — capabilities that need fresh data (calendar, configuration) rebuild every turn; static ones can cache. `start()` runs once after login for autonomous work (e.g. the Instagram scheduler).

Register a new capability by adding it to the candidates array in `src/app.ts`; it becomes a binding target after the next restart.

## Persistence

A single SQLite file at `data/chopperbot.db` (WAL, foreign keys on), namespaced per capability via the `_migrations` table (one row per capability + version). Each capability owns its own tables, prefixed with its id (`calendar_events`, `instagram_monitor_accounts`, `configuration_bindings`). A reserved `__framework__` namespace holds the cross-capability Discord-user directory. The `configuration` capability's admin tools can inspect any table from chat.

## Tests

```bash
pnpm test                                                   # full suite (vitest run)
pnpm run test:watch                                         # watch mode
pnpm run typecheck                                          # strict tsc --noEmit
npx vitest run src/capabilities/calendar/__tests__/store.test.ts   # single file
npx vitest run -t "creates an event"                        # single test by name pattern
```

Tests use real SQLite (`:memory:`) and a mocked OpenAI client. A smoke test against the **real** Kimi API is available but is not part of `pnpm test` (it spends request budget):

```bash
KIMI_API_KEY=sk-kimi-... tsx scripts/live-kimi-smoke.ts
```

## Deployment

The live deployment runs on a Raspberry Pi (aarch64, Node 22), supervised by a `systemd --user` service (`chopperbot.service`) that runs `node dist/index.js` directly. Because systemd runs the compiled output, **changes take effect only after a rebuild**:

```bash
pnpm run build && systemctl --user restart chopperbot.service
systemctl --user status chopperbot.service                    # confirm: active (running)
journalctl --user -u chopperbot -f -o cat | npx pino-pretty   # live logs
```

Observability is `journalctl` only — there are no log files on the Pi. See [`CLAUDE.md`](CLAUDE.md) for the full deployment, scheduler, and Instagram anti-detection / guardrail details.

## License

[MIT](LICENSE) © 2026 Miguel Quintero.
