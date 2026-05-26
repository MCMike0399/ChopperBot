#!/usr/bin/env bash
# chopperbot-status.sh — SwiftBar plugin showing ChopperBot health.
# Symlink or copy to ~/Library/Application Support/SwiftBar/Plugins/chopperbot.30s.sh
# (the `30s` in the filename tells SwiftBar to refresh every 30 seconds).
#
# <swiftbar.title>ChopperBot</swiftbar.title>
# <swiftbar.author>Miguel</swiftbar.author>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>
# <swiftbar.runInBash>true</swiftbar.runInBash>

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO="${CHOPPERBOT_REPO:-/Users/burbujamc/Documents/Documents - MacBook/ChopperBot-public}"
DB="$REPO/data/chopperbot.db"
LOG="${CHOPPERBOT_LOG:-$HOME/Library/Logs/chopperbot-bot.out.log}"

exec /usr/bin/env python3 -u - "$REPO" "$DB" "$LOG" <<'PYEOF'
import sqlite3, subprocess, sys, time, os

REPO, DB, LOG = sys.argv[1], sys.argv[2], sys.argv[3]

def running():
    try:
        r = subprocess.run(["pgrep", "-f", "node.*dist/index.js"],
                           capture_output=True, timeout=2)
        return r.returncode == 0
    except Exception:
        return False

def query(sql, params=()):
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
        cur = con.execute(sql, params)
        rows = list(cur.fetchall())
        con.close()
        return rows
    except Exception:
        return []

is_up = running()
now_ms = int(time.time() * 1000)

# Push counts: total + last 24h (by row insertion order, which is also time order).
# We can't filter by "when the push happened" without a dedicated column, but
# rowid is monotonically increasing so counting recent rowids is a reasonable
# proxy for "recent activity."
pc_total = query("SELECT count(*) FROM instagram_monitor_seen_posts WHERE pushed=1")
pushed_total = pc_total[0][0] if pc_total else 0

# "Recent" = last 24 hours of *real-world clock*; we approximate "pushed
# recently" by counting rows whose IG posted_at is within 24h OR whose
# rowid is among the most-recent N rows (covers backfill of old posts).
recent_rowid = query(
    "SELECT count(*) FROM instagram_monitor_seen_posts "
    "WHERE pushed=1 AND rowid > (SELECT max(rowid) - 200 FROM instagram_monitor_seen_posts)"
)
pushed_recent = recent_rowid[0][0] if recent_rowid else 0

# Skip count (irrelevant classifications, all-time — typically small).
sc = query(
    "SELECT count(*) FROM instagram_monitor_seen_posts WHERE pushed=0 AND json_extract(classification_json,'$.relevant')=0"
)
skipped_total = sc[0][0] if sc else 0

# Accounts
accounts = query(
    "SELECT username, consecutive_failures, last_polled_at, last_post_id FROM instagram_monitor_accounts ORDER BY username"
)

failing = [a for a in accounts if a[1] > 0]
stale_poll = [a for a in accounts if a[2] and (now_ms - a[2]) > 30 * 60 * 1000]

# Recent pushes (5)
recent = query("""
    SELECT account_username,
           json_extract(classification_json,'$.type'),
           json_extract(classification_json,'$.title'),
           posted_at
    FROM instagram_monitor_seen_posts
    WHERE pushed=1
    ORDER BY rowid DESC
    LIMIT 5
""")

# --- MENU BAR LINE ---
# Use SF Symbols where available; SwiftBar accepts the standard "SF Symbol name"
# via `:symbol.name:`. We mix one symbol + status text.
if not is_up:
    print(f"🔴 ChopperBot")
elif failing:
    print(f"🟠 ChopperBot · {pushed_total}↑")
elif stale_poll:
    print(f"🟡 ChopperBot · {pushed_total}↑")
else:
    print(f"🟢 ChopperBot · {pushed_total}↑")

print("---")

# --- STATUS SECTION ---
print(f"{'🟢 Running' if is_up else '🔴 Stopped'} | size=13")
print(f"Pushed (total): {pushed_total}   ·   Recent: {pushed_recent}   ·   Skipped: {skipped_total} | size=12")
print("---")

# --- ACCOUNTS ---
print("Accounts (6 monitored) | size=12")
for username, fails, last_polled, last_post_id in accounts:
    if last_polled is None:
        line = f"⚪ @{username}   never polled"
    else:
        delta_min = (now_ms - last_polled) // 60000
        if fails > 0:
            line = f"🔴 @{username}   {fails} fail{'s' if fails>1 else ''} · last poll {delta_min}m ago"
        elif delta_min > 30:
            line = f"🟡 @{username}   stale · {delta_min}m ago"
        else:
            line = f"🟢 @{username}   {delta_min}m ago"
    print(f"{line} | size=11 href=https://www.instagram.com/{username}/")

# --- RECENT PUSHES ---
if recent:
    print("---")
    print("Recent pushes | size=12")
    for username, type_, title, posted_at in recent:
        if posted_at:
            ago_min = (now_ms - posted_at) // 60000
            when = f"{ago_min}m ago" if ago_min < 90 else f"{ago_min//60}h ago"
        else:
            when = ""
        title = (title or "")[:60]
        emoji = {
            "alerta": "⚠️", "evento": "📅", "convocatoria": "📣",
            "acuerpamiento": "🤝", "actualización": "🔄", "noticia": "📰",
        }.get(type_, "📸")
        print(f"{emoji} @{username} · {type_}{(' · ' + when) if when else ''}")
        if title:
            print(f"  {title} | size=10 color=#888")

# --- ACTIONS ---
print("---")
print(f"Open bot log… | shell=/usr/bin/open param1={LOG} terminal=false")
print(f"Open repo… | shell=/usr/bin/open param1={REPO} terminal=false")
print(f"Tail logs in Terminal… | shell=/usr/bin/open param1=-a param2=Terminal param3={LOG} terminal=false")
print("---")
print(f"Restart bot (launchctl kickstart) | shell=/bin/launchctl param1=kickstart param2=-k param3=gui/{os.getuid()}/com.user.chopperbot terminal=false")
print(f"Stop bot | shell=/bin/launchctl param1=bootout param2=gui/{os.getuid()}/com.user.chopperbot terminal=false")
print(f"Start bot | shell=/bin/launchctl param1=bootstrap param2=gui/{os.getuid()} param3=/Users/burbujamc/Library/LaunchAgents/com.user.chopperbot.plist terminal=false")
print(f"Refresh now | refresh=true")
PYEOF
