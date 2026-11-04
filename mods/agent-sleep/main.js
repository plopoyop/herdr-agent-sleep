// agent-sleep: idle agents quit to free their memory, and come back with
// their whole conversation in one click.
//
// Every 30 s, an agent that has been done or idle for longer than the delay
// (5 min by default) is asked to quit, after its session id is noted. Its
// terminal stays, on the shell, and this list shows it under "Sleeping".
// Clicking it types the agent's resume command in that shell.
//
// Left awake: agents shown in the window (focused, or any pane of the tab on
// screen), pinned agents, agents with text in their prompt, agents not
// started from a shell, agents on other machines.
//
// State lives on the terminal as labels (visible with `hc get`), so it
// survives app restarts and every copy of this mod agrees:
//   agent-sleep=<session id>   agent-sleep.agent=<adapter id>
//   agent-sleep.title=<title>  agent-sleep.since=<ms>
//   agent-sleep.unseen=1       (it had finished while nobody was looking)
//   agent-sleep.state=quitting|waking, agent-sleep.at=<ms>  (in progress)
//   agent-sleep.prompt=<the shell's last line once asleep>
//   agent-sleep.cwd=<the agent's folder>  (for uninstall.sh's saved commands)
//   agent-sleep.waker=<copy id>  (which copy types the resume command)
//
// Nothing is typed into a sleeping terminal's shell unless its last line is
// still exactly what it was when the agent fell asleep: text the person typed
// there is never run along with the resume command.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, theme, run, hc, shared, setShared, notify, layout, props } from "herdr";
import { adapterFor, adapterById, isSessionId } from "./adapters.js";

const LABEL = "agent-sleep";
const L = {
  session: LABEL,
  agent: `${LABEL}.agent`,
  title: `${LABEL}.title`,
  since: `${LABEL}.since`,
  unseen: `${LABEL}.unseen`,
  state: `${LABEL}.state`,
  at: `${LABEL}.at`,
  prompt: `${LABEL}.prompt`,
  cwd: `${LABEL}.cwd`,
  waker: `${LABEL}.waker`,
};
const ALL_LABELS = Object.values(L);

const CHECK_EVERY_MS = 30_000;
const QUIT_WAIT_S = 15;
// A quit or a wake that hasn't shown its effect after this long failed.
const STEP_TIMEOUT_MS = 2 * 60_000;
// The shell's line is recorded only this soon after the quit: later, the
// person may have typed something there, and a recorded draft would let a
// wake run it.
const PROMPT_WINDOW_MS = 10_000;
const DELAYS = [5, 10, 20, 60, 0]; // minutes, 0 = off
const DEFAULT_DELAY = 5;
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "nu", "pwsh", "elvish", "xonsh"]);
// Only one copy acts (one per layout may exist); the others take over if it
// stops ticking.
const LEADER_KEY = "agent-sleep.leader";
// Every copy announces itself this often: the leader keeps its lead, and each
// window says which terminals it shows.
const PRESENCE_EVERY_MS = 15_000;
const LEADER_STALE_MS = 3 * PRESENCE_EVERY_MS;
const VISIBLE_KEY = "agent-sleep.visible";
const DELAY_KEY = "agent-sleep.delay";

// Fit (block props `fit: true`): the Agents block and this one take the
// height of their rows, so the Sleeping list sits right under the agents and
// the spare room goes to the block above. Heights mirror the shipped agents mod.
const AGENTS_BLOCK = "agents";
const SELF_BLOCK = "agent-sleep";
const AGENTS_MAX = 520;
const SELF_MAX = 320;
const ROW = 30;
const SUB_ROW = 26;

// `match`: a node id, or a predicate.
function findNode(node, match) {
  const hit = typeof match === "function" ? match : (n) => n.id === match;
  if (node && hit(node)) return node;
  for (const c of node?.children ?? []) {
    const f = findNode(c, hit);
    if (f) return f;
  }
  return null;
}

class LostLead extends Error {}

function agentsHeight() {
  const list = agents();
  if (list.length === 0) return 41 + 60;
  const byPriority = (shared("agents.sort") ?? "priority") === "priority";
  const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
  const groups = new Set(list.map((a) => (a.pinned ? "pinned" : byPriority ? rank[a.status] ?? 1 : a.space)));
  const listed = new Set(list.map((a) => a.address));
  const subs = terminals().filter((t) => t.state === "live" && t.parent && !listed.has(t.address)).length;
  return 41 + groups.size * ROW + list.length * ROW + subs * SUB_ROW + 8;
}

// Block props `demo: true`: sample rows, no engine, no actions. Used for the
// preview picture, so it never shows anyone's real work.
const DEMO = [
  ["claude", "api", "Fix login redirect loop", 12, true],
  ["claude", "web", "Add dark mode toggle", 47, false],
  ["claude", "infra", "Upgrade Postgres to 17", 190, false],
  ["codex", "docs", "Write the release notes", 1500, false],
];
const isDemo = () => props()?.demo === true;
const demoRows = (now) =>
  DEMO.map(([agent, space, title, minutes, unseen], i) => ({
    address: `demo${i}`,
    labels: {
      [L.session]: "00000000-0000-4000-8000-000000000000",
      [L.agent]: agent,
      [L.title]: title,
      [L.since]: String(now - minutes * 60_000),
      ...(unseen ? { [L.unseen]: "1" } : {}),
      "demo.space": space,
    },
  }));

const delay = () => {
  const d = shared(DELAY_KEY);
  return DELAYS.includes(d) ? d : DEFAULT_DELAY;
};

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// { ok: false } when hc itself failed: never read that as "the terminal is gone".
async function getTerminal(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return { ok: false, t: null };
  try {
    return { ok: true, t: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, t: null };
  }
}

// The shell's last non-empty line, to tell whether anything was typed there.
async function lastLine(address) {
  const r = await hc(["read", address]); // visible screen only
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return (lines[lines.length - 1] ?? "").slice(0, 200);
}

const local = (address) => !String(address).includes("/");
// A login shell's argv[0] starts with "-" ("-bash", "-zsh").
const basename = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");
const onShell = (t) => SHELLS.has(basename(t?.foreground?.name));
// The agent runs as a child of a shell, which stays when it quits. An agent
// that is the terminal's own program would end the terminal (and its tab).
const underShell = (t) => SHELLS.has(basename(t?.argv?.[0])) && t?.foreground?.pid !== t?.pid;
const setLabels = (address, pairs) => hc(["label", address, ...Object.entries(pairs).map(([k, v]) => `${k}=${v}`)]);
const clearLabels = (address) => hc(["label", address, ...ALL_LABELS.map((k) => `${k}=`)]);

// Terminal blocks of the shown layout (`content.terminal`), skipping hidden
// nodes and the inactive children of stacks.
function layoutTerminals(node, out = new Set()) {
  if (!node || node.hidden) return out;
  if (node.content?.terminal) out.add(node.content.terminal);
  const kids = node.children ?? [];
  // A stack shows one child: the active one, else the first.
  const shown = node.type === "stack" ? [kids.find((c) => c.id === node.active) ?? kids[0]].filter(Boolean) : kids;
  for (const c of shown) layoutTerminals(c, out);
  return out;
}

// Terminals this window shows: the focused one, the agent an agent block
// shows, every pane of the tab on screen, and terminal blocks of the layout.
function shownHere() {
  const f = focused();
  const seen = new Set([f?.terminal, f?.shown, f?.agent].filter(Boolean));
  for (const p of panes()) if (p.tab === f?.tab && p.terminal) seen.add(p.terminal);
  for (const t of layoutTerminals(layout())) seen.add(t);
  return seen;
}

// Terminals the person can see in any window of this app: this one's, plus
// what the other copies announced lately (shared is app-wide; focus isn't).
function visibleTerminals() {
  const seen = shownHere();
  const now = Date.now();
  for (const v of Object.values(shared(VISIBLE_KEY) ?? {})) {
    if (now - (v?.at ?? 0) < LEADER_STALE_MS) for (const a of v.terms ?? []) seen.add(a);
  }
  return seen;
}

export default class AgentSleep extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.busy = new Set(); // addresses being acted on, claimed before any await
    this.running = false; // one tick at a time
    this.folded = false;
    this.seeing = new Set(); // unseen marks being cleared
    this.waking = new Set(); // rows clicked, shown as waking before any label is written
    if (isDemo()) return;
    cx.timer.every(CHECK_EVERY_MS, (cx) => this.tick(cx));
    cx.timer.every(PRESENCE_EVERY_MS, () => this.presence(true));
    this.presence(true);
    this.tick(cx);
  }

  // Announce what this window shows (on change, and every PRESENCE_EVERY_MS
  // so it doesn't go stale), drop stale entries, and keep the lead alive.
  presence(periodic = false) {
    const terms = [...shownHere()].sort();
    const all = shared(VISIBLE_KEY) ?? {};
    const mine = all[this.id];
    const now = Date.now();
    if (periodic || !mine || mine.terms.join() !== terms.join()) {
      const next = { [this.id]: { at: now, terms } };
      for (const [id, v] of Object.entries(all)) if (id !== this.id && now - (v?.at ?? 0) < LEADER_STALE_MS) next[id] = v;
      setShared(VISIBLE_KEY, next);
    }
    if (periodic && shared(LEADER_KEY)?.id === this.id) setShared(LEADER_KEY, { id: this.id, at: now });
  }

  // Leaving (pane closed, app quit): hand the lead over at once instead of
  // making the next copy wait for it to go stale.
  async close() {
    if (shared(LEADER_KEY)?.id === this.id) setShared(LEADER_KEY, null);
    const now = Date.now();
    const all = {};
    for (const [id, v] of Object.entries(shared(VISIBLE_KEY) ?? {})) {
      if (id !== this.id && now - (v?.at ?? 0) < LEADER_STALE_MS) all[id] = v;
    }
    setShared(VISIBLE_KEY, Object.keys(all).length ? all : null);
  }

  claim(address) {
    if (this.busy.has(address)) return false;
    this.busy.add(address);
    return true;
  }

  // Labelled terminals, whatever their state.
  labelled() {
    return terminals().filter((t) => t.state === "live" && local(t.address) && t.labels?.[L.session]);
  }

  // The list: asleep or waking, with a well-formed session id only.
  sleeping() {
    if (isDemo()) return demoRows(Date.now());
    // Each agent shows in exactly one list. In agents() means awake (a
    // sleeping one, back on its shell, reports no status): a quitting agent
    // joins this list the moment it leaves that one ("falling asleep…"), and
    // a waking one leaves it the moment it's back there.
    const awake = new Set(agents().map((a) => a.address));
    return this.labelled().filter((t) => {
      if (!isSessionId(t.labels[L.session]) || !adapterById(t.labels[L.agent])) return false;
      const state = t.labels[L.state];
      if (state === "quitting") return !awake.has(t.address);
      if (state === "waking" || this.waking.has(t.address)) return !awake.has(t.address);
      return true;
    });
  }

  lead() {
    const l = shared(LEADER_KEY);
    const now = Date.now();
    if (l && l.id !== this.id && now - l.at < LEADER_STALE_MS) return false;
    setShared(LEADER_KEY, { id: this.id, at: now });
    return true;
  }

  // Keep the lead during a long run, so no other copy starts acting too. If
  // another copy took over meanwhile (this run stalled), stop: never take it back.
  heartbeat() {
    const l = shared(LEADER_KEY);
    if (l && l.id !== this.id) throw new LostLead();
    setShared(LEADER_KEY, { id: this.id, at: Date.now() });
  }

  tick(cx) {
    if (this.running || !this.lead()) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        await this.settle(cx);
        if (delay() > 0) await this.sleepIdle(cx);
      } catch (e) {
        if (!(e instanceof LostLead)) console.log(`agent-sleep: ${e?.message ?? e}`);
      } finally {
        this.running = false;
      }
      cx.notify();
    });
  }

  // Bring labelled terminals in line with what they run now. Labels are read
  // fresh from `hc get`, never from the list taken when the loop started.
  async settle(cx) {
    for (const s of this.labelled()) {
      this.heartbeat();
      if (!this.claim(s.address)) continue;
      try {
        const { ok, t } = await getTerminal(s.address);
        if (!ok || !t || t.state !== "live") continue; // gone terminals leave terminals() by themselves
        const labels = t.labels ?? {};
        const sessionId = labels[L.session];
        if (!sessionId) continue;
        if (!isSessionId(sessionId)) {
          await clearLabels(s.address); // not ours, or tampered with
          continue;
        }
        const adapter = adapterById(labels[L.agent]);
        if (!adapter) continue; // an agent this version doesn't know: leave it alone
        const state = labels[L.state];
        // `at` is written with `state` in one label call: missing or garbage
        // means tampered with, so count it as timed out.
        const at = Number(labels[L.at]) > 0 ? Number(labels[L.at]) : 0;
        const age = at ? Date.now() - at : Infinity;

        if (state === "quitting") {
          if (onShell(t)) await this.finishSleep(cx, s.address, at);
          else if (age > STEP_TIMEOUT_MS) {
            // Still the agent: it never quit. Something else: it did, and the
            // person started another program; keep the session.
            if (adapter.isRunning(t)) {
              // The same conversation: it never quit. Another one: it did,
              // then the person started a new agent there.
              const running = await adapter.session(t.foreground.pid);
              if (running?.id !== sessionId) this.replaced(s.address, adapter, sessionId);
              await clearLabels(s.address);
            } else await this.finishSleep(cx, s.address, at);
          }
        } else if (adapter.isRunning(t)) {
          const running = await adapter.session(t.foreground.pid);
          if (!running) {
            // Starting up, or stuck before its session exists (a trust
            // question). Time that from the first time it's seen running.
            if (!at) {
              await setLabels(s.address, { [L.at]: Date.now() });
            } else if (age > STEP_TIMEOUT_MS) {
              if (state !== "waking") this.replaced(s.address, adapter, sessionId);
              await clearLabels(s.address);
            }
            continue;
          }
          if (running.id !== sessionId) this.replaced(s.address, adapter, sessionId); // a new conversation there
          await clearLabels(s.address); // woken, by click or by hand
        } else if (state === "waking" && age > STEP_TIMEOUT_MS) {
          await setLabels(s.address, { [L.state]: "", [L.at]: "", [L.waker]: "" }); // resume failed: asleep again
        } else if (state !== "waking" && labels[L.at]) {
          await setLabels(s.address, { [L.at]: "" }); // was seen running, back on the shell
        } else if (state !== "waking" && !labels[L.prompt] && onShell(t)) {
          // Not settled the first time: retry, but only shortly after the quit.
          await this.recordPrompt(cx, s.address, Number(labels[L.since] ?? 0));
        }
      } finally {
        this.busy.delete(s.address);
      }
    }
  }

  // A session id is about to leave the labels for good: hand it to the person.
  replaced(address, adapter, sessionId) {
    notify({
      title: "Sleeping agent replaced",
      body: `Another agent runs in ${address}. The earlier one: ${adapter.resume(sessionId)}`,
      level: "info",
    });
  }

  async sleepIdle(cx) {
    const wait = delay() * 60_000;
    for (const a of agents()) {
      this.heartbeat();
      if (a.status !== "done" && a.status !== "idle") continue;
      if (a.pinned || !local(a.address) || visibleTerminals().has(a.address)) continue;
      if (!this.claim(a.address)) continue;
      try {
        await this.tryToSleep(cx, a.address, wait);
      } finally {
        this.busy.delete(a.address);
      }
    }
  }

  // Every check is made again right before the quit is typed: the person may
  // have come back while earlier agents were handled.
  async tryToSleep(cx, address, wait) {
    const stillOk = async () => {
      const a = agents().find((x) => x.address === address);
      if (!a || a.pinned || visibleTerminals().has(address)) return null;
      if (a.status !== "done" && a.status !== "idle") return null;
      const { ok, t } = await getTerminal(address);
      if (!ok || !t || t.state !== "live" || t.labels?.[L.session]) return null;
      const st = t.status?.state;
      if (st !== "done" && st !== "idle") return null;
      if (!t.status_ms || Date.now() - t.status_ms < wait) return null;
      if (!underShell(t)) return null;
      const adapter = adapterFor(a, t);
      return adapter ? { a, t, adapter, st } : null;
    };

    const first = await stillOk();
    if (!first) return;
    const { t, adapter } = first;
    const pid = t.foreground.pid;
    const session = await adapter.session(pid);
    if (!session || !isSessionId(session.id)) return;
    if (session.startedAt && Date.now() - session.startedAt < wait) return;
    // The agent's own word, when it gives one: anything but idle means work runs.
    if (session.status && session.status !== "idle") return;

    // The visible screen only (`--lines 0`): reading history can scroll a
    // full-screen program.
    const screen = await hc(["read", address]);
    if (screen.code !== 0 || adapter.hasDraft(screen.stdout)) return;
    if (await adapter.hasBackgroundWork(screen.stdout, pid)) return;
    const last = await stillOk();
    if (!last || last.t.foreground?.pid !== pid) return;

    // Labels first: if the quit is slow or the app reloads, settle() finishes
    // the job and the session id is never lost.
    const title = (last.t.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const written = await setLabels(address, {
      [L.session]: session.id,
      [L.agent]: adapter.id,
      [L.state]: "quitting",
      [L.at]: Date.now(),
      ...(title ? { [L.title]: title } : {}),
      [L.cwd]: last.t.foreground?.cwd ?? "", // empty removes an older one
      // Herdr's "done": finished while nobody was looking. Keep that news.
      ...(last.a.status === "done" ? { [L.unseen]: "1" } : {}),
    });
    if (written.code !== 0) return; // no record of the session: don't quit
    // `--if idle` refuses if the agent started working since the last check.
    // An agent Herdr marks "done" isn't "idle" to herdr-core, so the guard
    // only applies to idle ones; done ones rely on the checks above.
    const send = await hc(["send", ...(last.st === "idle" ? ["--if", "idle"] : []), address, adapter.quit]);
    if (send.code !== 0) {
      // Refused, or failed after typing: keep `quitting` and let settle()
      // decide. Still the same session after 2 min → labels dropped; quit →
      // asleep. The session id is never lost either way.
      return;
    }

    for (let i = 0; i < QUIT_WAIT_S; i++) {
      await cx.sleep(1000);
      const { ok, t: now } = await getTerminal(address);
      if (ok && onShell(now)) {
        await this.finishSleep(cx, address, Date.now());
        return;
      }
    }
    // Still running: settle() retries, or drops the labels after STEP_TIMEOUT_MS.
  }

  // Nothing is typed here: the shell's line is the person's. The resume
  // command is in the row's tooltip and in `hc get` (labels).
  async finishSleep(cx, address, quitAt) {
    await setLabels(address, { [L.state]: "", [L.at]: "", [L.since]: quitAt || Date.now() });
    await this.recordPrompt(cx, address, quitAt);
  }

  // The shell draws its prompt a moment after the agent quits: record the
  // last line only once two reads half a second apart agree.
  // Only within PROMPT_WINDOW_MS of the quit, and never while the terminal is
  // on screen (the person could be typing there).
  async recordPrompt(cx, address, quitAt) {
    const fresh = () => quitAt > 0 && Date.now() - quitAt < PROMPT_WINDOW_MS && !visibleTerminals().has(address);
    if (!fresh()) return;
    let before = await lastLine(address);
    for (let i = 0; i < 6; i++) {
      await cx.sleep(500);
      const now = await lastLine(address);
      if (!fresh()) return;
      if (now !== null && now === before) {
        await setLabels(address, { [L.prompt]: now });
        return;
      }
      before = now;
    }
    // Never settled: no prompt recorded, so a wake points to the command instead.
  }

  wake(s, cx) {
    if (isDemo()) return;
    const sessionId = s.labels[L.session];
    if (!isSessionId(sessionId) || s.labels[L.state] || this.waking.has(s.address)) return; // quitting or waking
    const adapter = adapterById(s.labels[L.agent]);
    if (!adapter) return;
    const cmd = adapter.resume(sessionId);
    // Show it at once: the row says "waking…" and its tab comes up from the
    // click on. Text typed there before the command is caught by the line
    // check right before typing (it falls back to the toast).
    this.waking.add(s.address);
    run("pane.focus", { terminal: s.address });
    cx.notify();
    const byHand = (why) => {
      run("pane.focus", { terminal: s.address });
      notify({ title: "Wake it by hand", body: `${why} Run: ${cmd}`, level: "warning" });
    };
    cx.spawn(async (cx) => {
      // A check may be handling this terminal right now: wait for it (a few
      // seconds at most) rather than drop the click.
      let claimed = false;
      for (let i = 0; i < 50 && !(claimed = this.claim(s.address)); i++) await cx.sleep(200);
      if (!claimed) {
        this.waking.delete(s.address);
        cx.notify();
        return byHand(`${s.address} is busy right now.`);
      }
      let sent = false;
      try {
        const { ok, t } = await getTerminal(s.address);
        if (!ok || !t) return byHand(`Couldn't read ${s.address}.`);
        if (t.labels?.[L.session] !== sessionId) return; // changed since the click: nothing to wake
        if (t.labels?.[L.state]) return; // already waking (a second click)
        const expected = t.labels?.[L.prompt];
        if (!onShell(t)) return byHand(`${s.address} isn't on its shell.`);
        if (!expected) return byHand("Its shell line wasn't recorded.");
        if ((await setLabels(s.address, { [L.state]: "waking", [L.at]: Date.now(), [L.waker]: this.id })).code !== 0) {
          return byHand("Couldn't mark it as waking.");
        }
        // Another window may have clicked too: only the last writer types.
        const again = await getTerminal(s.address);
        if (!again.ok || again.t?.labels?.[L.waker] !== this.id) return;
        // Last look right before typing: the line must be exactly as it was.
        if ((await lastLine(s.address)) !== expected) {
          await setLabels(s.address, { [L.state]: "", [L.at]: "", [L.waker]: "" });
          return byHand("The shell's line has changed: clear it first.");
        }
        if ((await hc(["send", s.address, cmd])).code !== 0) {
          await setLabels(s.address, { [L.state]: "", [L.at]: "", [L.waker]: "" });
          return byHand("Typing the command failed.");
        }
        sent = true;
        await setLabels(s.address, { [L.unseen]: "" });
      } finally {
        this.busy.delete(s.address);
        // Sent: keep "waking…" until the agent runs (no flicker back to "z").
        if (!sent) this.waking.delete(s.address);
        cx.notify();
      }
      // Drop the labels as soon as the agent runs, instead of at the next
      // check: the row leaves Sleeping when the agent shows up again.
      if (sent) {
        try {
          await this.awaitAwake(cx, s.address, adapter, sessionId);
        } finally {
          this.waking.delete(s.address);
          cx.notify();
        }
      }
    });
  }

  async awaitAwake(cx, address, adapter, sessionId) {
    for (let i = 0; i < 120; i++) {
      await cx.sleep(250);
      const { ok, t } = await getTerminal(address);
      if (!ok || !t || t.labels?.[L.session] !== sessionId || t.labels?.[L.state] !== "waking") return;
      if (!adapter.isRunning(t)) continue;
      const running = await adapter.session(t.foreground.pid);
      if (running?.id !== sessionId) continue; // not started yet, or settle() will handle it
      if (!this.claim(address)) return;
      try {
        await clearLabels(address);
      } finally {
        this.busy.delete(address);
      }
      cx.notify();
      return;
    }
  }

  // Showing a sleeping terminal on screen counts as looking at its result.
  markSeen(list, cx) {
    const shown = visibleTerminals();
    const s = list.find((x) => shown.has(x.address) && x.labels[L.unseen] === "1");
    if (!s || this.seeing.has(s.address)) return;
    this.seeing.add(s.address);
    cx.spawn(async () => {
      try {
        await hc(["label", s.address, `${L.unseen}=`]);
      } finally {
        this.seeing.delete(s.address);
      }
    });
  }

  fit(count) {
    if (props()?.fit !== true) return;
    const root = layout();
    const agentsNode = findNode(root, (n) => n.id === AGENTS_BLOCK || n.content?.mod === "agents");
    const selfNode = findNode(root, (n) => n.id === SELF_BLOCK || n.content?.mod === SELF_BLOCK);
    if (!agentsNode?.id || !selfNode?.id) return;
    const want = [
      [agentsNode, Math.min(agentsHeight(), AGENTS_MAX)],
      [selfNode, Math.min(ROW + Math.max(count, 1) * ROW + 12, SELF_MAX)],
    ];
    // Each size is asked for once: a resize re-renders every mod.
    this.fitted ??= {};
    for (const [node, px] of want) {
      if (node.size?.px === px || this.fitted[node.id] === px) continue;
      this.fitted[node.id] = px;
      run("layout.resize", { id: node.id, px });
    }
  }

  cycleDelay() {
    setShared(DELAY_KEY, DELAYS[(DELAYS.indexOf(delay()) + 1) % DELAYS.length]);
  }

  row(t, s, now) {
    const adapter = adapterById(s.labels[L.agent]);
    const space = spaces().find((sp) => sp.tabs.some((x) => x.id === s.labels?.["herdr.tab"]));
    const tab = space?.tabs.find((x) => x.id === s.labels?.["herdr.tab"]);
    const title = s.labels[L.title] || tab?.name || s.address;
    const since = Number(s.labels[L.since]);
    const unseen = s.labels[L.unseen] === "1";
    const waking = s.labels[L.state] === "waking" || this.waking.has(s.address);
    const falling = s.labels[L.state] === "quitting";
    const status = waking ? "waking…" : falling ? "falling asleep…" : null;
    return h_flex()
      .id(`sleep-${s.address}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(waking ? "Waking up…" : falling ? "Falling asleep…" : `${unseen ? "Finished, not seen yet. " : ""}Wake: ${adapter.resume(s.labels[L.session])}`)
      .on_click((_e, cx) => this.wake(s, cx))
      .child(image(adapter.icon).w(16).h(16).flex_none().opacity(0.45))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(120).truncate().text_color(unseen ? t.foreground : t.muted).child(s.labels["demo.space"] ?? space?.name ?? ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${title}`)))
      .when(Boolean(status), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(status)))
      .when(!status && since > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - since))))
      .child(unseen
        ? div().size(7).mx(3).flex_none().rounded(4).bg(t.done)
        : div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("z"));
  }

  render(cx) {
    const t = theme();
    const list = this.sleeping();
    const now = Date.now();
    if (!isDemo()) {
      this.presence();
      this.markSeen(list, cx);
      this.fit(list.length);
    }
    const d = delay();
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        h_flex()
          .id("sleep-header")
          .px(16)
          .h(30)
          .pt(8)
          .flex_none()
          .gap(6)
          .items_center()
          .text_size(11)
          .font_medium()
          .child(div().id("sleep-fold").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.folded = !this.folded; cx.notify(); })
            .child("Sleeping"))
          .child(div().text_color(t.dim).child(String(list.length)))
          .child(div().flex_1())
          .child(div().id("sleep-delay").px(5).rounded(4).cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Sleep idle agents after… (click to change)")
            .on_click(() => this.cycleDelay())
            .child(d > 0 ? `after ${d}m` : "off")),
      )
      .when(!this.folded, (el) => el.child(
        v_flex().id("sleep-list").flex_1().min_h(0).px(8).overflow_y_scrollbar()
          .children(list.map((s) => this.row(t, s, now)))
          .when(list.length === 0, (el) => el.child(div().px(8).text_size(12).text_color(t.dim)
            .child(d > 0 ? `Idle agents sleep after ${d} min.` : "Sleep is off."))),
      ));
  }
}
