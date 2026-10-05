# Contributing to ChopperBot

Thanks for helping. ChopperBot is the community Discord bot for Revolución Z; see
[README.md](README.md) for what it does and [CLAUDE.md](CLAUDE.md) for the architecture
map and the per-area docs under `docs/`.

## Setup

Node 22 and pnpm 11. The minutas tests also need `ffmpeg` on your `PATH`.

```bash
pnpm install
pnpm run typecheck
pnpm test          # vitest, real in-memory SQLite, mocked LLM — no secrets needed
pnpm run build
pnpm run format    # Prettier; CI runs format:check
```

You do not need a `.env` to run the tests. A few calendar tests read private Canva
templates that are not in this repo; they skip automatically when the files are absent.

**Do not run anything under `scripts/` unless you know what it does.** Several scripts talk
to the real DeepSeek API, Instagram or Discord and spend real budget. None of them are tests.

## Pull requests

1. Fork, branch from `main`, keep the change focused.
2. Add or update tests for behavior changes, and update the matching doc under `docs/`.
3. Open the PR. CI (format, typecheck, tests, build on arm64) must pass before merge. For
   first-time contributors a maintainer approves the CI run first.
4. Don't bump `package.json` or edit `CHANGELOG.md`; maintainers do that when releasing.

## Releases (maintainers)

Bump `package.json` (semver) and add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`
in community-friendly Spanish, then merge to `main`. Once CI is green it creates the
`vX.Y.Z` tag and the GitHub Release from that section, and the production host picks the
tag up and deploys it on its own. The Discord announcement is posted separately with
`pnpm run release` (always `--dry-run` first).
