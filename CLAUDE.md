# herdr-agent-sleep

Public Herdr mod (target: GitHub, topic `herdr-mod`). Everything here is published: English only, no personal paths, names or work titles (screenshots included).

## Layout

- `mods/agent-sleep/main.js`: view + engine. `adapters.js`: one adapter per agent (Claude supported, Codex experimental).
- `install.sh` / `uninstall.sh`: bash + python3, must stay shell-agnostic for the terminals they touch.
- `RECIPE.md` follows Herdr's recipe format (What you see / How it behaves / Built from / Watch out / Done when). Update it with every behaviour change, as well as `README.md`.

## Rules

- Check after every change: `herdr-app check mods/agent-sleep`.
- Herdr's API truth is `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts` (rewritten by the app on each start), plus `~/.config/herdr-app/AGENTS.md`.
- Never clear a prompt with ctrl+c/esc: a draft must block sleep, never be discarded.
- Commands typed into terminals must work in any shell (bash, zsh, fish, nu…): only the agent's quit command (in the agent) and its resume command (in the shell, only if the shell's line is unchanged since sleep).
- Don't test `hc send` from an agent's terminal: it wraps text in `<hc from=…>` tags. Test from the mod.
- Labels are written before the quit; session ids are UUID-checked before being typed anywhere.
- A new adapter starts `experimental: true` until tried for real.
- Shared keys and terminal labels are all prefixed `agent-sleep`: `uninstall.sh` removes every `agent-sleep.*` shared key, but a new label must be added to `KEYS` there.
- `uninstall.sh` runs with the app closed and mirrors the adapters in Python: a new or changed adapter (`resume`, foreground name, session lookup) must be mirrored in `RESUME`, `PROGRAM` and `running_session` there.
