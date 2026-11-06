#!/usr/bin/env bash
# Removes the agent-sleep mod, its block from every personal layout, its
# shared settings and the labels it left on terminals (finished ones too).
# Run it with the Herdr app closed: no copy of the mod is running then, and
# the app can't write its settings back. Terminals keep running (herdr-core).
# Agents asleep at that moment stay on their shell: their resume commands are
# printed and saved in ~/.config/herdr-app/.agent-sleep-backup/ before any
# label is removed.
# Layouts installed with --fit keep the Agents block's last size; drag it
# back, or `herdr-app do layout.resize`.
set -euo pipefail

app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
backups="$app_home/.agent-sleep-backup/$(date +%Y%m%d-%H%M%S)"
status=0

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
# Running if any of these says so: its CLI answers, its socket accepts a
# connection, or a herdr-app process exists. Any doubt counts as running.
app_running() {
  if command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; then return 0; fi
  if pgrep -u "$(id -u)" -x herdr-app >/dev/null 2>&1; then return 0; fi
  python3 - "$app_home/herdr-app.sock" <<'EOF'
import os, socket, sys
path = sys.argv[1]
if not os.path.exists(path):
    sys.exit(1)
s = socket.socket(socket.AF_UNIX)
s.settimeout(1)
try:
    s.connect(path)
except OSError:
    sys.exit(1)  # a socket left by a crash: nobody listens
sys.exit(0)
EOF
}
if app_running; then
  echo "Quit the Herdr app first (your terminals keep running), then run this again." >&2
  exit 1
fi

# 1. Labels. First save the resume command of every session the labels hold,
# with its folder (agents look sessions up by folder). Only once that is
# written, remove the labels. A session that runs right now is left out.
if ! command -v hc >/dev/null; then
  echo "hc not found: the agent-sleep labels on terminals weren't checked. Run this again where hc works." >&2
  status=1
elif ! python3 - "$backups" "$HOME" <<'EOF'
import json, os, re, subprocess, sys

backups, home = sys.argv[1], sys.argv[2]
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# Mirror mods/agent-sleep/adapters.js (`resume`, the foreground name in
# `isRunning`, `session`): keep both in step.
RESUME = {"claude": "claude --resume {}", "codex": "codex resume {}"}
PROGRAM = {"claude": "claude", "codex": "codex"}
KEYS = ["agent-sleep"] + [f"agent-sleep.{k}" for k in
        ("agent", "title", "since", "unseen", "state", "at", "prompt", "waker", "cwd", "viewed")]

def hc(*args):
    return subprocess.run(["hc", *args], capture_output=True, text=True)

def as_json(r):
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError:
        return None

def running_session(agent, pid):
    """The session the agent process runs, or None if it can't be told."""
    try:
        if agent == "claude":
            with open(os.path.join(home, ".claude", "sessions", f"{pid}.json")) as f:
                return json.load(f).get("sessionId")
        if agent == "codex":
            for fd in os.listdir(f"/proc/{pid}/fd"):
                try:
                    target = os.readlink(f"/proc/{pid}/fd/{fd}")
                except OSError:
                    continue  # closed meanwhile
                m = re.search(r"/rollout-\S*-([0-9a-f-]{36})\.jsonl$", target)
                if m:
                    return m.group(1)
    except (OSError, ValueError):
        pass
    return None

listing = as_json(hc("ls", "--all", "--json"))
if listing is None:
    sys.exit("Couldn't list the terminals (hc ls --all --json): labels not checked.")

failed, labelled, saved, running = False, [], {}, set()
if listing.get("hidden_finished"):
    failed = True
    print(f"{listing['hidden_finished']} finished terminals weren't listed: their labels (if any) are left.", file=sys.stderr)

for term in listing.get("terminals", []):
    addr = term.get("address", "")
    if not addr or "/" in addr:
        continue  # other machines: not ours
    t = as_json(hc("get", addr, "--json"))
    if t is None:
        failed = True
        print(f"{addr}: couldn't read it, its labels (if any) are left", file=sys.stderr)
        continue
    live = t.get("state") == "live"
    fg = t.get("foreground") or {}
    # Any terminal can run a session, labelled or not.
    for a, prog in PROGRAM.items():
        if live and fg.get("name") == prog and fg.get("pid"):
            sid_now = running_session(a, fg["pid"])
            if sid_now:
                running.add(sid_now)
    labels = t.get("labels") or {}
    if not any(k in labels for k in KEYS):
        continue
    sid, agent = labels.get("agent-sleep", ""), labels.get("agent-sleep.agent", "")
    if sid and agent not in RESUME:
        # An agent this script doesn't know (a newer mod?): never drop its session.
        failed = True
        print(f"{addr}: unknown agent {agent!r}, labels left in place", file=sys.stderr)
        continue
    labelled.append(addr)
    if not UUID.match(sid):
        continue  # not a session of ours, or tampered with: nothing to save
    # The same session can sit on a finished terminal and a live one: keep the live one.
    if sid in saved and not live:
        continue
    cwd = labels.get("agent-sleep.cwd") or (f"{t['cwd']}  (the terminal's folder now: may not be the agent's)" if t.get("cwd") else "?")
    saved[sid] = [addr, labels.get("agent-sleep.title", ""), cwd, RESUME[agent].format(sid)]

# A session that seems to run right now is still saved (a quit under way, or
# a stale record, must never lose it), with a warning: resuming a running one
# would fork it.
saved = {sid: f"{a}  {title}\n  in:  {cwd}\n  run: {cmd}"
         + ("\n  note: it seems to be running right now: check before resuming it" if sid in running else "")
         for sid, (a, title, cwd, cmd) in saved.items()}

if saved:
    text = "\n".join(saved.values()) + "\n"
    print(text, end="")
    try:
        os.makedirs(backups, exist_ok=True)
        path = os.path.join(backups, "sleeping.txt")
        with open(path, "w") as f:
            f.write(text)
    except OSError as e:
        sys.exit(f"Couldn't save them ({e}): labels left in place. Copy the commands above, then run this again.")
    print(f"Resume commands saved in {path}")

for addr in labelled:
    if hc("label", addr, *[f"{k}=" for k in KEYS]).returncode != 0:
        failed = True
        print(f"{addr}: couldn't remove its agent-sleep labels", file=sys.stderr)
sys.exit(1 if failed else 0)
EOF
then
  status=1
fi

# 2. The block, from every personal layout.
python3 - "$app_home/layouts" <<'EOF' || status=1
import json, os, pathlib, shutil, sys, tempfile

def strip(node):
    kids = node.get("children")
    if kids is None:
        return False
    keep = [c for c in kids if c.get("id") != "agent-sleep"]
    changed = len(keep) != len(kids)
    node["children"] = keep
    return any([strip(c) for c in keep]) or changed

failed = False
for path in sorted(pathlib.Path(sys.argv[1]).glob("*.json")):
    try:
        doc = json.loads(path.read_text())
        if not strip(doc):
            continue
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".agent-sleep-", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
        print(f"{path}: Sleeping list removed")
    except Exception as e:  # one bad layout must not stop the others
        failed = True
        print(f"{path}: skipped ({e})", file=sys.stderr)
sys.exit(1 if failed else 0)
EOF

# 3. Shared settings (delay, leader, visibility): the app is closed, so
# nothing else writes the file.
shared_file="$app_home/shared.json"
if [ -f "$shared_file" ]; then
  python3 - "$shared_file" <<'EOF' || status=1
import json, os, shutil, sys, tempfile

path = sys.argv[1]
try:
    with open(path) as f:
        doc = json.load(f)
    keys = [k for k in doc if k == "agent-sleep" or k.startswith("agent-sleep.")]
    if keys:
        for k in keys:
            del doc[k]
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".agent-sleep-", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
except (OSError, ValueError) as e:
    sys.exit(f"{path}: agent-sleep settings not removed ({e})")
EOF
fi

# 4. The mod.
rm -rf "$app_home/mods/agent-sleep"

if [ "$status" -ne 0 ]; then
  echo "agent-sleep removed, but some steps above failed: see the messages. Running this again is safe." >&2
  exit 1
fi
echo "agent-sleep removed."
