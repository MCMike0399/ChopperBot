#!/usr/bin/env bash
# chopperbot-daily-summary.sh — once-daily notification with today's bot activity.
# Triggered by launchd agent `com.user.chopperbot-daily-summary` at 21:00 local.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CHOPPERBOT_DB:-/Users/burbujamc/Documents/Documents - MacBook/ChopperBot-public/data/chopperbot.db}"
NOTIFY="${CHOPPERBOT_NOTIFY:-$HOME/.local/bin/chopperbot-notify.sh}"

if [[ ! -f "$DB" ]]; then
  echo "[$(date)] DB not found at $DB — skipping summary"
  exit 0
fi

exec /usr/bin/env python3 -u - "$DB" "$NOTIFY" <<'PYEOF'
import sqlite3, subprocess, sys, time

DB, NOTIFY = sys.argv[1], sys.argv[2]

# "Today" = last 16 hours. Wider than 16 by design — accounts for runs that
# fire slightly past midnight or first-of-month edge cases.
since_ms = int(time.time() * 1000) - 16 * 3600 * 1000

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
def q(sql, *args):
    return con.execute(sql, args).fetchall()

# Total pushed in window
total = q("SELECT count(*) FROM instagram_monitor_seen_posts WHERE pushed=1 AND posted_at >= ?", since_ms)[0][0]

# Breakdown by type
by_type = q("""
    SELECT json_extract(classification_json, '$.type'), count(*)
    FROM instagram_monitor_seen_posts
    WHERE pushed=1 AND posted_at >= ?
    GROUP BY 1 ORDER BY 2 DESC
""", since_ms)

# Skipped (irrelevant classifications)
skipped = q("""
    SELECT count(*) FROM instagram_monitor_seen_posts
    WHERE pushed=0 AND posted_at >= ?
      AND json_extract(classification_json, '$.relevant') = 0
""", since_ms)[0][0]

# Accounts with consecutive failures
fails = q("SELECT username, consecutive_failures FROM instagram_monitor_accounts WHERE consecutive_failures > 0")

# Build body
if total == 0 and not fails:
    body = f"No new pushes today.  ·  Skipped: {skipped}"
elif total == 0:
    body = f"No pushes today.  ·  ⚠️ {len(fails)} account(s) failing"
else:
    bits = []
    for t, c in by_type:
        if t:
            emoji = {"alerta":"⚠️","evento":"📅","convocatoria":"📣","acuerpamiento":"🤝","actualización":"🔄","noticia":"📰"}.get(t, "📸")
            bits.append(f"{emoji} {c} {t}")
    body = " · ".join(bits)
    if skipped:
        body += f"  ·  skipped {skipped}"
    if fails:
        body += f"  ·  ⚠️ {len(fails)} failing"

subprocess.run([NOTIFY, "summary", f"ChopperBot — daily ({total} pushed)", body, "ChopperBot"], check=False)
print(f"[summary] total={total} skipped={skipped} fails={len(fails)} by_type={by_type}", flush=True)
PYEOF
