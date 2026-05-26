# ChopperBot

A multi-capability Discord assistant. Each authorized Discord channel is bound to exactly one **Capability** — a self-contained bundle of system prompt, tools, and per-channel state. Bindings are managed live from chat via an admin console; no restart needed.

Three capabilities ship in this repo:

| Capability | What it does |
|---|---|
| `configuration` | Admin console hard-bound to one Discord channel. Manage channel→capability bindings, inspect the SQLite DB, list registered capabilities, and run scoped per-channel data admin. |
| `calendar` | A shared per-channel calendar — create, list, search, update, delete events. Persists in SQLite. Supports recurring events (daily / weekly / monthly) with optional end date. Scoped per Discord user within each channel. |
| `instagram_monitor` | Autonomously polls a list of public Instagram accounts every ~20 minutes, classifies each new post with `kimi-for-coding` in Spanish (`evento` / `convocatoria` / `alerta` / `acuerpamiento` / `actualización` / `noticia` / `otro`), and pushes the relevant ones (with media re-uploaded as a Discord attachment) into the bound channel. |

## Stack

- TypeScript + Node 22+
- [discord.js](https://discord.js.org/) for the Discord client
- [Moonshot Kimi Code](https://www.kimi.com/code/console) via the OpenAI-compatible API (`kimi-for-coding` model)
- SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for all persistence
- [pino](https://getpino.io/) for structured logs
- [vitest](https://vitest.dev/) for tests

## Quickstart

```bash
# 1. Install deps
pnpm install

# 2. Set required env vars in .env (see .env.example)
cp .env.example .env
$EDITOR .env

# 3. Run tests and build
pnpm run typecheck
npx vitest run
pnpm run build

# 4. Start
pnpm run start
```

The bot logs JSON via pino. Pipe through `pino-pretty` for readable output:

```bash
pnpm run start | pino-pretty
```

## Adding a capability

Each capability is a class implementing the `Capability` interface in `src/capabilities/capability.ts`:

```ts
export interface Capability {
  readonly id: string;
  readonly description: string;
  init(deps: CapabilityInitDeps): Promise<void>;
  buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle>;
  start?(deps: CapabilityStartDeps): Promise<void>;   // optional, for autonomous capabilities
  dispose?(): Promise<void>;
}
```

`init()` runs at boot before Discord login (load corpora, run migrations). `buildTurn()` returns `{ system, tools }` per user message — capabilities that need fresh data (calendar, configuration) rebuild every turn; capabilities with static prompts can cache. `start()` runs once after Discord login for capabilities that do their own background work (e.g. `instagram_monitor`'s scheduler).

To register a new capability, instantiate it in the candidates array in `src/app.ts`. The configuration capability surfaces it as a binding target the next time the bot is restarted.

## Persistence

A single SQLite file at `data/chopperbot.db`, namespaced per capability via the `_migrations` table. Each capability owns its own tables (prefixed with its id, e.g. `calendar_events`, `instagram_monitor_accounts`). The `configuration` capability's admin tools let you inspect any table from chat.

## Tests

```bash
npx vitest run           # full suite
npx vitest               # watch mode
pnpm run typecheck       # strict tsc --noEmit
```

Tests use real SQLite (`:memory:`) and a mocked OpenAI client.

## License

MIT — see [LICENSE](LICENSE).
