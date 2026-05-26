#!/usr/bin/env bash
# chopperbot-health-check.sh — periodic sanity check fired by launchd every
# 30 min (com.user.chopperbot-health-check). Detects two slow-failure modes
# that the realtime log watcher would miss:
#
#   - Silent bot: process is alive but hasn't logged a scheduler tick in 2h
#     (could be hung, network stuck, etc.). Fires Funk-sound alarm.
#   - Account silent for 7d: an IG account hasn't seen a *new* post fetched
#     in 7 days (posted_at-wise). Could mean the account is banned, private,
#     or deactivated. Fires Submarine-sound info.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CHOPPERBOT_DB:-/Users/burbujamc/Documents/Documents - MacBook/ChopperBot-public/data/chopperbot.db}"
LOG="${CHOPPERBOT_LOG:-$HOME/Library/Logs/chopperbot-bot.out.log}"
NOTIFY="${CHOPPERBOT_NOTIFY:-$HOME/.local/bin/chopperbot-notify.sh}"

[[ -f "$DB" ]] || { echo "[$(date)] DB not found, skip"; exit 0; }
[[ -f "$LOG" ]] || { echo "[$(date)] log not found, skip"; exit 0; }

exec /usr/bin/env python3 -u - "$DB" "$LOG" "$NOTIFY" <<'PYEOF'
import json, os, re, sqlite3, subprocess, sys, time

DB, LOG, NOTIFY = sys.argv[1], sys.argv[2], sys.argv[3]

now_ms = int(time.time() * 1000)

# --- Silent-bot heartbeat: scan the LAST ~500 lines of the log for the most
# recent `instagram_monitor.tick`. If older than 2 hours, alert.
last_tick_ms = 0
try:
    with open(LOG, "rb") as fh:
        # Cheap "tail": seek to end - 200KB and read forward.
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 200 * 1024))
        tail = fh.read().decode(errors="replace")
    for line in reversed(tail.splitlines()):
        if '"instagram_monitor.tick"' in line and line.startswith("{"):
            try:
                d = json.loads(line)
                last_tick_ms = int(d.get("time", 0))
                if last_tick_ms:
                    break
            except Exception:
                continue
except Exception as exc:
    print(f"[health-err] reading log: {exc}", flush=True)

silent_for_min = (now_ms - last_tick_ms) // 60000 if last_tick_ms else None
if silent_for_min is None:
    # No ticks ever logged — possible at fresh install; don't alarm.
    pass
elif silent_for_min >= 120:
    subprocess.run([NOTIFY, "fetch-failure",
                    "ChopperBot silent",
                    f"No scheduler tick in {silent_for_min}m — bot may be hung",
                    "ChopperBot"], check=False)
    print(f"[silent-bot] no tick in {silent_for_min} min — alarm fired", flush=True)
else:
    print(f"[heartbeat] last tick {silent_for_min}m ago — OK", flush=True)

# --- Account-silent-7d: max(posted_at) per account; if > 7 days, alert once
# per day per account (track via timestamp file).
SEVEN_D = 7 * 24 * 3600 * 1000
STATE = os.path.expanduser("~/Library/Caches/chopperbot-notify/account-silent.state")
os.makedirs(os.path.dirname(STATE), exist_ok=True)
notified_today = set()
if os.path.exists(STATE):
    today = time.strftime("%Y-%m-%d")
    with open(STATE) as fh:
        for line in fh:
            d, u = line.strip().split("\t", 1) if "\t" in line else ("", "")
            if d == today:
                notified_today.add(u)

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
rows = con.execute("""
    SELECT a.username,
           (SELECT MAX(posted_at) FROM instagram_monitor_seen_posts s WHERE s.account_username = a.username) AS newest
    FROM instagram_monitor_accounts a
""").fetchall()

today = time.strftime("%Y-%m-%d")
new_state_lines = [f"{today}\t{u}" for u in notified_today]

for username, newest in rows:
    if newest is None:
        # Account hasn't been polled yet — silent watch won't alert until
        # at least one post has been fetched.
        continue
    age_d = (now_ms - newest) // (24 * 3600 * 1000)
    if age_d >= 7 and username not in notified_today:
        subprocess.run([NOTIFY, "silent",
                        "Account quiet",
                        f"@{username} — no new IG posts in {age_d} days",
                        "ChopperBot"], check=False)
        print(f"[account-silent] @{username} silent {age_d}d", flush=True)
        new_state_lines.append(f"{today}\t{username}")
    elif age_d >= 7:
        print(f"[account-silent] @{username} silent {age_d}d (already notified today)", flush=True)

# Persist today's notifications so we don't re-fire every 30 min.
with open(STATE, "w") as fh:
    fh.write("\n".join(new_state_lines))
PYEOF
