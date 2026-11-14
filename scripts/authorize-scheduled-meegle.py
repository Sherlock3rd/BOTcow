"""Complete official OAuth inside the daily task's Windows context.

Device codes stay in process memory; only safe status and a non-secret user
acknowledgement file cross process boundaries. No automatic authorization polling.
"""
import json
import os
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = Path(os.environ.get("MEEGLE_PLUGIN_SCRIPTS", "C:/Users/example/.codex/plugins/cache/lg-ai-plugins/lg-feishu/0.4.3/scripts"))
sys.path.insert(0, str(PLUGIN))
from toolkit_feishu.meegle_cli import start_meegle_login, poll_meegle_login_once

status_path = ROOT / "runtime/scheduled-meegle-auth-status.json"
ack_path = ROOT / "runtime/scheduled-meegle-auth-ack.txt"

def report(status):
    status_path.write_text(json.dumps(status), encoding="utf-8")

try:
    if ack_path.exists():
        raise RuntimeError("stale acknowledgement file")
    login = start_meegle_login(ROOT)
    opened = webbrowser.open(login.authorization_url)
    report({"status": "waiting_for_user", "browser_opened": opened})
    deadline = time.monotonic() + login.expires_in
    while time.monotonic() < deadline:
        if ack_path.exists():
            ack_path.unlink()
            result = poll_meegle_login_once(ROOT, login)
            report(result)
            if result.get("connected") is True:
                break
            if result.get("status") != "authorization_pending":
                sys.exit(1)
        time.sleep(1)
    else:
        report({"status": "authorization_expired", "connected": False})
        sys.exit(1)
except Exception:
    report({"status": "authorization_setup_failed", "connected": False})
    sys.exit(1)
