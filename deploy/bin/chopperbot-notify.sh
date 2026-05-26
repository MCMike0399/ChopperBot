#!/usr/bin/env bash
# chopperbot-notify.sh — single-shot macOS notification with sound + rate-limit.
# Usage: chopperbot-notify.sh <kind> <title> <message> [subtitle]
#
# Kinds (controls sound + rate-limit):
#   alerta         — Sosumi, never rate-limited (real-world urgent posts)
#   evento         — Glass,   never rate-limited (events with concrete dates)
#   push           — Pop,     rate-limit 30s    (generic IG push)
#   noticia        — Pop,     rate-limit 30s    (news category push)
#   convocatoria   — Tink,    rate-limit 30s    (calls to action)
#   acuerpamiento  — Tink,    rate-limit 30s    (collective presence requests)
#   actualizacion  — Pop,     rate-limit 30s
#   reconnect      — Hero,    rate-limit 5s     (Discord came back online)
#   disconnect     — Basso,   rate-limit 5s     (Discord went offline)
#   crash          — Basso,   rate-limit 5s     (process error / restart)
#   fetch-failure  — Funk,    rate-limit 60s    (3+ consecutive IG failures)
#   auth-expired   — Sosumi,  rate-limit 60min  (IG session cookies expired)
#   silent         — Submarine, rate-limit 60min (no events in N hours)
#   summary        — Submarine, never rate-limited (daily roundup)
#   info           — default,  rate-limit 5s     (everything else)
#
# All notifications are tagged with subtitle "ChopperBot" so macOS groups them
# together in Notification Center.
set -euo pipefail

KIND="${1:-info}"
TITLE="${2:-ChopperBot}"
MESSAGE="${3:-}"
SUBTITLE="${4:-ChopperBot}"

case "$KIND" in
  alerta)               SOUND="Sosumi";   MIN_GAP=0 ;;
  evento)               SOUND="Glass";    MIN_GAP=0 ;;
  push|noticia|actualizacion) SOUND="Pop"; MIN_GAP=30 ;;
  convocatoria|acuerpamiento) SOUND="Tink"; MIN_GAP=30 ;;
  reconnect)            SOUND="Hero";     MIN_GAP=5 ;;
  disconnect|crash)     SOUND="Basso";    MIN_GAP=5 ;;
  fetch-failure)        SOUND="Funk";     MIN_GAP=60 ;;
  auth-expired)         SOUND="Sosumi";   MIN_GAP=3600 ;;
  silent)               SOUND="Submarine"; MIN_GAP=3600 ;;
  summary)              SOUND="Submarine"; MIN_GAP=0 ;;
  *)                    SOUND="default";  MIN_GAP=5 ;;
esac

RATE_DIR="$HOME/Library/Caches/chopperbot-notify"
mkdir -p "$RATE_DIR"
RATE_FILE="$RATE_DIR/$KIND.last"
NOW=$(date +%s)
if (( MIN_GAP > 0 )) && [[ -f "$RATE_FILE" ]]; then
  LAST=$(stat -f %m "$RATE_FILE" 2>/dev/null || echo 0)
  if (( NOW - LAST < MIN_GAP )); then
    exit 0
  fi
fi
touch "$RATE_FILE"

# Escape backslashes first, then double-quotes, for AppleScript.
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
T=$(escape "$TITLE")
M=$(escape "$MESSAGE")
S=$(escape "$SUBTITLE")

osascript -e "display notification \"$M\" with title \"$T\" subtitle \"$S\" sound name \"$SOUND\"" >/dev/null 2>&1 || true
