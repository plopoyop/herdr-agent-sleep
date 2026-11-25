// Which folder of the space-folders mod a space shows in, read from its shared
// state (`space-folders`: per machine, "" for this computer, `{ list, of }`).
// Mirrors that mod's own rules (its `folderOf`, `machineFolder` and the order
// of `grouped`): keep both in step. Without that mod, nothing here finds a folder.

import { layout, shared } from "herdr";

// One strong color per stored avatar color, as space-folders draws them.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function usesMod(node) {
  if (node?.content?.mod === "space-folders") return true;
  return (node?.children ?? []).some(usesMod);
}

// Its shared state outlives the mod (shared.json): only while the shown
// layout runs it, and it has folders.
export const hasFolders = () =>
  usesMod(layout()) && Object.values(shared("space-folders") ?? {}).some((f) => (f?.list ?? []).length > 0);

const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);

// Where a space works: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A rule takes a folder and everything in it: "~" is any home, "*" any one
// folder name, and a rule starting with neither "/" nor "~" is a folder name at
// any depth.
const rules = new Map();
function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  if (!rules.has(p)) {
    const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
      .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
    rules.set(p, new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`));
  }
  return rules.get(p);
}

const collects = (f, path) => Boolean(path) && (f.match ?? "").split(",").some((p) => rule(p)?.test(path));

// How deep into the path a folder's rules reach: 0 when none match.
const reach = (f, path) => !path ? 0 : Math.max(0, ...(f.match ?? "").split(",").map((p) => {
  const m = rule(p)?.exec(path);
  return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
}));

function deepest(list, path) {
  let best = null, most = 0;
  for (const f of list) {
    const n = reach(f, path);
    if (n > most) { best = f; most = n; }
  }
  return best;
}

// The folders as the spaces list draws them, for the spaces `wanted` (ids):
// `placed` gives each its group (space id → { key, machine, folder }; key ""
// is no folder), `order` the group keys top to bottom. A machine taken in by a
// folder on this computer (rules matching its name or one of its spaces'
// folders) shows inside that folder: its spaces in none of its own folders
// join it, and its own folders follow it.
export function placeSpaces(sp, ps, wanted) {
  const state = shared("space-folders") ?? {};
  const folders = (m) => state[m ?? ""] ?? { list: [], of: {} };
  const local = folders(null).list;
  const remote = [...new Set([...Object.keys(state).filter(Boolean), ...sp.map((s) => s.machine).filter(Boolean)])].sort();
  const host = {};
  for (const m of remote) {
    const mine = sp.filter((s) => s.machine === m);
    host[m] = local.find((f) => collects(f, m) || mine.some((s) => collects(f, place(s, ps)))) ?? null;
  }
  const placed = {};
  for (const s of sp) {
    if (!wanted.has(s.id)) continue;
    const machine = s.machine ?? null, { list, of } = folders(machine);
    const id = of[localId(s)];
    let folder = id !== undefined ? list.find((f) => f.id === id) ?? null : deepest(list, place(s, ps));
    let at = machine;
    if (!folder && machine && host[machine]) { folder = host[machine]; at = null; }
    placed[s.id] = { key: folder ? `${at ?? ""}:${folder.id}` : "", machine: at, folder };
  }
  const order = [];
  const own = (m) => folders(m).list.map((f) => `${m}:${f.id}`);
  for (const f of local) {
    order.push(`:${f.id}`);
    for (const m of remote) if (host[m]?.id === f.id) order.push(...own(m));
  }
  for (const m of remote) if (!host[m]) order.push(...own(m));
  return { placed, order };
}
