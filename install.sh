#!/usr/bin/env bash
# Installs the agent-sleep mod and puts its "Sleeping" list under the Agents
# list of a layout. Herdr's own layouts are read-only, so a shipped one
# (main, terminals, win98) is first duplicated as "<name>-sleep".
#
# Usage: ./install.sh [--fit] [layout]
#   layout  default: the layout shown now
#   --fit   size the Agents and Sleeping lists to their rows (resizes the
#           Agents block; your own sizes for those two blocks are replaced)
# Needs: the Herdr app running, python3.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
backups="$app_home/.agent-sleep-backup/$(date +%Y%m%d-%H%M%S)"
shipped=(main terminals win98)

fit=false
layout=""
for arg in "$@"; do
  case "$arg" in
    --fit) fit=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) layout="$arg" ;;
  esac
done

command -v herdr-app >/dev/null || { echo "herdr-app not found in PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
herdr-app status >/dev/null 2>&1 || { echo "Start the Herdr app first" >&2; exit 1; }

# 1. Check the new mod where Herdr doesn't load it, then swap it in. The
# staging folder is hidden and on the same disk as mods/, so each move is a
# plain rename: Herdr never sees a half-copied mod.
staging="$(mktemp -d "$app_home/.agent-sleep-staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
cp -r "$here/mods/agent-sleep" "$staging/agent-sleep"
herdr-app check "$staging/agent-sleep"

mkdir -p "$app_home/mods"
if [ -d "$app_home/mods/agent-sleep" ]; then
  mkdir -p "$backups"
  mv "$app_home/mods/agent-sleep" "$backups/agent-sleep"
  echo "Previous mod kept in $backups/agent-sleep"
fi
mv "$staging/agent-sleep" "$app_home/mods/agent-sleep"

# 2. The layout.
if [ -z "$layout" ]; then
  layout="$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')"
fi
for s in "${shipped[@]}"; do
  if [ "$layout" = "$s" ]; then
    if [ ! -f "$app_home/layouts/$s-sleep.json" ]; then
      herdr-app do layout.clone "{\"name\":\"$s\",\"as\":\"$s-sleep\"}" >/dev/null
      for _ in $(seq 50); do
        [ -s "$app_home/layouts/$s-sleep.json" ] && break
        sleep 0.2
      done
    fi
    layout="$s-sleep"
  fi
done
file="$app_home/layouts/$layout.json"
[ -s "$file" ] || { echo "No layout file $file" >&2; exit 1; }

mkdir -p "$backups"
cp "$file" "$backups/$layout.json"

python3 - "$file" "$fit" <<'EOF'
import json, os, sys, tempfile

path, fit = sys.argv[1], sys.argv[2] == "true"
with open(path) as f:
    doc = json.load(f)

block = {"id": "agent-sleep", "type": "block", "size": {"weight": 0.5}, "content": {"mod": "agent-sleep"}}
if fit:
    block["content"]["props"] = {"fit": True}

def find(node):
    if node.get("id") == "agent-sleep":
        return node
    for c in node.get("children", []):
        f = find(c)
        if f:
            return f
    return None

def insert(node):
    kids = node.get("children", [])
    for i, child in enumerate(kids):
        if child.get("id") == "agents" or child.get("content", {}).get("mod") == "agents":
            kids.insert(i + 1, block)
            return True
        if insert(child):
            return True
    return False

existing = find(doc)
if existing:
    if not fit or existing.get("content", {}).get("props", {}).get("fit") is True:
        print(f"{path}: already has the Sleeping list")
        sys.exit(0)
    existing.setdefault("content", {}).setdefault("props", {})["fit"] = True
    print(f"{path}: fit turned on for the Sleeping list")
elif not insert(doc):
    sys.exit(f"{path}: no Agents block found. Add this block where you want the list:\n{json.dumps(block)}")
else:
    print(f"{path}: Sleeping list added under Agents")

# Write next to it, then rename: Herdr never reads a half-written layout.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".agent-sleep-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
EOF

herdr-app do layout.switch "{\"name\":\"$layout\"}" >/dev/null
echo "Layout backup: $backups/$layout.json"
echo "Done: layout '$layout' shows the Sleeping list. Idle agents sleep after 5 min (click 'after 5m' to change)."
