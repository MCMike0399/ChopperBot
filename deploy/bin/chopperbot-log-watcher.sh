#!/usr/bin/env bash
# chopperbot-log-watcher.sh — tail ChopperBot's pino-JSON log and fire
# macOS notifications via chopperbot-notify.sh for interesting events.
# Designed to run forever under launchd (com.user.chopperbot-watcher).
#
# Watches:
#   - instagram_monitor.push                       → push/noticia/alerta/evento/...
#   - instagram_monitor.fetch.failed (failures>=3) → fetch-failure
#   - "Discord client ready"                       → reconnect
#   - pino level 50 (warn) / 60 (error/fatal)      → crash
#
# Activity is logged to ~/Library/Logs/chopperbot-watcher.out.log.
set -euo pipefail

LOG="${CHOPPERBOT_LOG:-$HOME/Library/Logs/chopperbot-bot.out.log}"
export NOTIFY="${CHOPPERBOT_NOTIFY:-$HOME/.local/bin/chopperbot-notify.sh}"
PARSER="${CHOPPERBOT_PARSER:-$HOME/.local/bin/chopperbot-log-watcher.py}"

while [[ ! -f "$LOG" ]]; do
  echo "[$(date)] waiting for $LOG..."
  sleep 10
done

echo "[$(date)] tailing $LOG (parser=$PARSER)"

# tail -F survives log rotation. -n 0 means "only new lines from now."
# The Python parser must be in its own file (NOT a heredoc) because the
# heredoc would shadow stdin from the pipe.
exec tail -F -n 0 "$LOG" 2>/dev/null | /usr/bin/env python3 -u "$PARSER"
