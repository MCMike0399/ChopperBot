#!/usr/bin/env bash
# Pull-based deploy for the Pi: fast-forward the deployment working tree to the
# newest `vX.Y.Z` release tag, build on the Pi, restart, health-check, and roll
# back if the new build does not come up. Run every few minutes by
# chopperbot-deploy.timer; safe to run by hand (`deploy/pull-deploy.sh --dry-run`).
#
# GitHub never reaches into the Pi: CI on GitHub-hosted runners creates the tag
# (.github/workflows/ci.yml), and this script only fetches the public repo.
#
# It refuses to touch the tree, and alerts the config channel once per distinct
# reason, when:
#   - HEAD is not on `main` (a manual rollback checkout pins the deploy),
#   - tracked files are modified (in-flight work on the Pi is never discarded),
#   - the tag is not on origin/main, or main cannot fast-forward to it.
# Untracked files (calendar/*.pdf, .env, data/, local-only docs) are never touched.
# A tag that failed its health check is remembered in data/.deploy-failed-tag and
# not retried; delete that file (or ship a newer tag) to try again.
set -euo pipefail

REPO="${CHOPPERBOT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE="${CHOPPERBOT_SERVICE:-chopperbot.service}"
BRANCH="${CHOPPERBOT_DEPLOY_BRANCH:-main}"
HEALTH_WAIT="${CHOPPERBOT_HEALTH_WAIT:-60}"
NOTIFY="${CHOPPERBOT_DEPLOY_NOTIFY:-1}"
READY_MARKER="Discord client ready"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

cd "$REPO"
mkdir -p data
STATE_BLOCKED="data/.deploy-blocked"
STATE_FAILED="data/.deploy-failed-tag"

exec 9>"data/.deploy.lock"
flock -n 9 || { echo "another deploy is running"; exit 0; }

log() { echo "deploy: $*"; }

# Post to the config channel with the bot's own token, read from .env.
notify() {
   [[ "$NOTIFY" == "1" ]] || { log "(notify off) $1"; return 0; }
   local token channel
   token=$(sed -n 's/^\(DISCORD_TOKEN\)=//p' .env | tail -1 | tr -d "\"'")
   channel=$(sed -n 's/^\(CHOPPERBOT_CONFIG_CHANNEL_ID\)=//p' .env | tail -1 | tr -d "\"'")
   if [[ -z "$token" || -z "$channel" ]]; then
      log "cannot notify: DISCORD_TOKEN or CHOPPERBOT_CONFIG_CHANNEL_ID missing from .env"
      return 0
   fi
   printf 'Authorization: Bot %s\n' "$token" | curl -sS -m 15 -o /dev/null -w '%{http_code}\n' \
      -H @- -H 'Content-Type: application/json' \
      --data-binary "$(jq -n --arg c "$1" '{content: $c, allowed_mentions: {parse: []}}')" \
      "https://discord.com/api/v10/channels/${channel}/messages" || true
}

# Alert once per distinct reason, then stay quiet until it changes.
blocked() {
   log "blocked: $1"
   if [[ "$DRY_RUN" == "0" && "$(cat "$STATE_BLOCKED" 2>/dev/null)" != "$1" ]]; then
      printf '%s' "$1" >"$STATE_BLOCKED"
      notify "⏸️ Despliegue automático en pausa: $1"
   fi
   exit 0
}

install_and_build() {
   # Called from `if`, where errexit is off: every step returns explicitly.
   local from="$1"
   if ! git diff --quiet "$from" HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml; then
      log "dependencies changed; pnpm install"
      pnpm install --frozen-lockfile --config.confirmModulesPurge=false || return 1
   fi
   pnpm run build || return 1
}

restart_and_check() {
   systemctl --user restart "$SERVICE" || return 1
   local invocation started
   invocation=$(systemctl --user show -p InvocationID --value "$SERVICE")
   started=$(systemctl --user show -p ExecMainStartTimestampMonotonic --value "$SERVICE")
   sleep "$HEALTH_WAIT"
   systemctl --user is-active --quiet "$SERVICE" || return 1
   # A crash-restart changes the main PID start time.
   [[ "$(systemctl --user show -p ExecMainStartTimestampMonotonic --value "$SERVICE")" == "$started" ]] || return 1
   journalctl --user -u "$SERVICE" "_SYSTEMD_INVOCATION_ID=${invocation}" -o cat --no-pager \
      | grep -q "$READY_MARKER"
}

git fetch --quiet --tags origin

tag=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
[[ -n "$tag" ]] || { log "no release tags yet"; exit 0; }

if git merge-base --is-ancestor "${tag}^{commit}" HEAD; then
   log "up to date with $tag"
   rm -f "$STATE_BLOCKED"
   exit 0
fi

if [[ "$(cat "$STATE_FAILED" 2>/dev/null)" == "$tag" ]]; then
   log "$tag failed its health check before; skipping"
   exit 0
fi

[[ "$(git symbolic-ref --short -q HEAD || true)" == "$BRANCH" ]] \
   || blocked "$tag está disponible, pero el repo del Pi no está en \`$BRANCH\` (¿rollback manual?)."
[[ -z "$(git status --porcelain --untracked-files=no)" ]] \
   || blocked "$tag está disponible, pero el repo del Pi tiene cambios sin commit."
git merge-base --is-ancestor "${tag}^{commit}" "origin/$BRANCH" \
   || blocked "$tag no está en origin/$BRANCH; no se despliega."
git merge-base --is-ancestor HEAD "${tag}^{commit}" \
   || blocked "$BRANCH en el Pi tiene commits que no están en $tag; no se puede avanzar sin fusionar."

if [[ "$DRY_RUN" == "1" ]]; then
   log "would deploy $(git rev-parse --short HEAD) -> $tag"
   exit 0
fi

prev=$(git rev-parse HEAD)
prev_desc=$(git describe --tags --always "$prev")
log "deploying $prev_desc -> $tag"
rm -f "$STATE_BLOCKED"
git merge --ff-only --quiet "${tag}^{commit}"

if install_and_build "$prev" && restart_and_check; then
   rm -f "$STATE_BLOCKED" "$STATE_FAILED"
   log "deployed $tag"
   notify "✅ Desplegada ChopperBot $tag (antes $prev_desc)."
   exit 0
fi

log "$tag failed; rolling back to $prev_desc"
printf '%s' "$tag" >"$STATE_FAILED"
bad=$(git rev-parse HEAD)
git reset --quiet --keep "$prev"
if install_and_build "$bad" && restart_and_check; then
   notify "⚠️ El despliegue de $tag falló y se regresó a $prev_desc. Revisa \`journalctl --user -u chopperbot\`; $tag no se volverá a intentar."
else
   notify "🚨 El despliegue de $tag falló y el regreso a $prev_desc tampoco arrancó bien. Hace falta revisar el Pi."
   exit 1
fi
