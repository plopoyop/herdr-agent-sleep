// How to put one kind of agent to sleep and wake it up again.
//
// An adapter answers four questions for the agent it handles:
//   - matches(agent, terminal): is this terminal running that agent?
//   - session(pid):             which session is that process on? (id + start time)
//   - hasDraft(screen):         is there unsent text in its prompt?
//   - quit / resume(id):        what to type to leave, what command brings it back.
//                               (uninstall.sh mirrors resume, the foreground name and the
//                               session lookup in Python: keep both in step.)
//
// To support another agent, add an adapter here. Mark it `experimental: true`
// until it has been tried for real.

import { exec, home, readTextFile } from "herdr";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
// Session ids end up in a command typed into a shell: only well-formed ones pass.
export const isSessionId = (id) => typeof id === "string" && UUID_RE.test(id);

// A draft is any text in the prompt: after the marker on its line, and, when
// the prompt sits in a box, on the lines below it up to the box's border (a
// multi-line draft can start with an empty line). No marker found: count it
// as a draft, so nobody's typing is ever thrown away.
function draftAfter(marker, border = null) {
  return (screen) => {
    const lines = screen.split("\n");
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trimStart().startsWith(marker)) {
        at = i;
        break;
      }
    }
    if (at < 0) return true;
    if (lines[at].trimStart().slice(marker.length).trim() !== "") return true;
    if (!border) return false;
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith(border)) return false;
      if (l !== "") return true;
    }
    return true; // no border below: can't tell where the prompt ends
  };
}

// Work that keeps running while Claude's prompt is idle, which quitting would
// kill: background shells and tasks, shown in the footer below the prompt box
// ("1 shell", "2 tasks"), running sub-agents (a "◯ <type>  <description>" row
// there), and shell processes Claude started. The footer's "← N agents" is
// left out: it also counts sub-agents that already finished. (Claude also
// reports "working" while a background sub-agent runs, so those are normally
// skipped before this check.)
async function claudeBackgroundWork(screen, pid) {
  const lines = screen.split("\n");
  let border = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("─")) {
      border = i;
      break;
    }
  }
  const footer = lines.slice(border + 1).join(" ");
  if (/\b\d+\s+(background\s+)?(shells?|bash(es)?|tasks?|loops?|jobs?)\b/i.test(footer)) return true;
  if (lines.slice(border + 1).some((l) => /^\s*◯\s+\S/.test(l))) return true;
  const r = await exec("pgrep", ["-l", "-P", String(pid)]).catch(() => null);
  if (!r) return true; // can't tell: stay awake
  // pgrep exits 1 when there are no children.
  if (r.code !== 0) return r.code !== 1;
  return r.stdout.split("\n").some((l) => /\s(bash|sh|zsh|fish|dash)$/.test(l.trim()));
}

export const ADAPTERS = [
  {
    id: "claude",
    name: "Claude Code",
    icon: "icons/claude.svg",
    experimental: false,
    matches: (agent, terminal) => agent.app === "claude-code" && terminal.foreground?.name === "claude",
    isRunning: (terminal) => terminal.foreground?.name === "claude",
    // Claude Code writes ~/.claude/sessions/<pid>.json for each running process.
    async session(pid) {
      const raw = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
      if (!raw) return null;
      try {
        const s = JSON.parse(raw);
        // `status` is Claude's own: "idle", "busy" (a turn or a background
        // sub-agent running), "shell" (background shells running).
        return isSessionId(s.sessionId) ? { id: s.sessionId, startedAt: s.startedAt ?? null, status: s.status ?? null } : null;
      } catch {
        return null;
      }
    },
    hasDraft: draftAfter("❯", "─"),
    hasBackgroundWork: claudeBackgroundWork,
    quit: "/exit",
    resume: (id) => `claude --resume ${id}`,
  },
  {
    id: "codex",
    name: "Codex",
    icon: "icons/codex.svg",
    experimental: true,
    matches: (agent, terminal) => agent.app === "codex" && terminal.foreground?.name === "codex",
    isRunning: (terminal) => terminal.foreground?.name === "codex",
    // Codex keeps its rollout file open while it runs:
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
    async session(pid) {
      const r = await exec("ls", ["-l", `/proc/${pid}/fd`]).catch(() => null);
      if (!r || r.code !== 0) return null;
      const m = r.stdout.match(new RegExp(`/rollout-[^\\s]*-(${UUID})\\.jsonl`));
      return m ? { id: m[1], startedAt: null, status: null } : null;
    },
    // Untested: if Codex shows placeholder text in an empty prompt, this
    // reads as a draft and Codex agents simply stay awake.
    hasDraft: draftAfter("›"),
    hasBackgroundWork: async () => false, // unknown for Codex
    quit: "/quit",
    resume: (id) => `codex resume ${id}`,
  },
];

export const adapterFor = (agent, terminal) => ADAPTERS.find((a) => a.matches(agent, terminal)) ?? null;
// Unknown ids (a newer version, a typo, a forged label) get no adapter: never
// resume a session with another agent's command.
export const adapterById = (id) => ADAPTERS.find((a) => a.id === id) ?? null;
