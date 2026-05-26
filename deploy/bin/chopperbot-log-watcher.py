#!/usr/bin/env python3
"""Reads pino-JSON log lines from stdin and fires macOS notifications via
$NOTIFY (the chopperbot-notify.sh shell wrapper)."""
import json
import os
import subprocess
import sys

NOTIFY = os.environ.get("NOTIFY", os.path.expanduser("~/.local/bin/chopperbot-notify.sh"))


def notify(kind: str, title: str, msg: str, sub: str = "ChopperBot") -> None:
    try:
        subprocess.run([NOTIFY, kind, title, msg, sub], check=False, timeout=5)
    except Exception as exc:
        print(f"[notify-err] {exc}", flush=True)


EMOJI = {
    "alerta": "⚠️",
    "evento": "📅",
    "convocatoria": "📣",
    "acuerpamiento": "🤝",
    "actualización": "🔄",
    "noticia": "📰",
}


def main() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue

        msg = d.get("msg", "")
        level = d.get("level", 0)
        account = d.get("account", "")
        type_ = d.get("type", "")
        shortcode = d.get("shortcode", "")
        failures = d.get("failures", 0)
        tag = d.get("tag", "")

        if msg == "instagram_monitor.push":
            kind = type_ if type_ in (
                "alerta", "evento", "convocatoria",
                "acuerpamiento", "actualizacion", "noticia",
            ) else "push"
            title = f"{EMOJI.get(type_, '📸')} @{account}"
            body = (type_ or "post") + (f" — {shortcode}" if shortcode else "")
            notify(kind, title, body)
            print(f"[push] @{account} {type_} {shortcode}", flush=True)

        elif msg == "instagram_monitor.fetch.failed":
            if failures >= 3:
                notify(
                    "fetch-failure",
                    "Fetch failing",
                    f"@{account} — {failures} consecutive failures",
                )
                print(f"[fetch-failure] @{account} {failures}", flush=True)

        elif msg == "instagram_monitor.auth.expired":
            notify(
                "auth-expired",
                "🔑 IG session expired",
                f"@{account} — refresh IG_SESSIONID/IG_CSRFTOKEN in .env",
            )
            print(f"[auth-expired] @{account}", flush=True)

        elif msg == "Discord client ready":
            notify("reconnect", "Discord online",
                   f"as {tag}" if tag else "websocket up")
            print(f"[ready] tag={tag}", flush=True)

        elif level >= 60:
            notify("crash", "ChopperBot FATAL", (msg or "fatal error")[:80])
            print(f"[fatal] {msg}", flush=True)

        elif level >= 50:
            if any(k in msg.lower() for k in ("error", "failed", "auth", "401", "403", "fatal")):
                notify("crash", "ChopperBot error", (msg or "error")[:80])
                print(f"[warn] {msg}", flush=True)


if __name__ == "__main__":
    main()
