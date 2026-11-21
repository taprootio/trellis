// Live reload for the viewer (TRL0005).
//
// Non-recursive fs.watch handles only (Linux lacks recursive watching on Node 18). Each
// backlog keeps a set of watched directories derived from its current config. Every event
// invalidates the reader's cache for the paths it names, re-arms missing or replaced
// watchers, and, after a 250 ms debounce, tells the server which backlog changed.

import { statSync, realpathSync, watch as fsWatch } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { DEFAULT_LEDGER_REF, DEFAULT_TASKS_DIR, artifactSet, loadConfig, paths } from "../backlog.mjs";
import { isInside } from "./reader.mjs";

export const DEBOUNCE_MS = 250;

const realpath = (p) => { try { return realpathSync.native(p); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The nearest existing directory at or above `dir` whose resolved path stays inside
// `boundary` (the worktree or the git directory), or null.
function nearestExisting(dir, boundary) {
  let d = dir;
  for (;;) {
    const real = realpath(d);
    if (real && isDir(real)) return isInside(boundary, real) ? real : null;
    const up = dirname(d);
    if (up === d || !isInside(boundary, up)) return null;
    d = up;
  }
}

const safeTasksDir = (v) => typeof v === "string" && v.trim() && !isAbsolute(v) && !v.split(/[/\\]/).includes("..");

// A path with its parent resolved, so it compares with the resolved directories that are watched.
function resolved(path) {
  const parent = realpath(dirname(path));
  return parent ? join(parent, basename(path)) : path;
}

// What one backlog needs watched: `wanted` is Map(resolved dir -> Set of accepted names | null)
// and `generated` lists the files a regenerate writes (not tasks, so they must not refresh).
// Only the backlog's own artifact paths count, so a task folder, a ledger ref or a symlink
// target that happens to be named README.md still refreshes.
function planOf(backlog) {
  const wanted = new Map();
  const generated = [];
  const root = backlog.mainWorktree;
  if (!root) return { wanted, generated };
  const add = (dir, accept = null) => {
    if (!dir) return;
    if (!wanted.has(dir)) { wanted.set(dir, accept ? new Set(accept) : null); return; }
    const cur = wanted.get(dir);
    if (cur === null) return;
    if (accept === null) wanted.set(dir, null); else for (const n of accept) cur.add(n);
  };

  // A config with errors is shown as an error; its keys are not trusted for paths. The config
  // directory stays watched, so the backlog recovers once the config is fixed.
  const loaded = loadConfig(root, { readText: backlog.reader.readText });
  const cfg = loaded.errors.length ? null : loaded.cfg;
  const tasksDir = cfg && safeTasksDir(cfg.tasksDir) ? cfg.tasksDir.replace(/[/\\]+$/, "") : DEFAULT_TASKS_DIR;
  const p = paths(root, { tasksDir });
  const set = artifactSet(root, cfg || { tasksDir });
  for (const g of [...set.generated.map((e) => e.path), p.historyJson]) generated.push({ path: resolved(g), dir: false });
  if (set.dir) generated.push({ path: resolved(set.dir), dir: true });
  for (const d of [p.tasks, p.active, join(p.tasks, "completed"), p.completedTasks, p.removed, join(root, "trellis")]) add(nearestExisting(d, root));
  // A replaced tasks root is reported by its parent, which a handle on the old inode may miss.
  if (dirname(p.tasks) !== root) add(nearestExisting(dirname(p.tasks), root));

  if (cfg && cfg.idAllocation === "ledger" && backlog.gitDir) {
    const gitDir = backlog.gitDir;
    const refFile = join(gitDir, cfg.idLedgerRef || DEFAULT_LEDGER_REF);
    const holder = nearestExisting(dirname(refFile), gitDir);
    if (holder) add(holder, [relative(holder, refFile).split(sep)[0]]);
    add(gitDir, ["packed-refs"]);
  }

  // A symlinked task, config or roster: watch the target's directory and every ancestor up
  // to the worktree, so replacing a subtree that holds it is reported.
  for (const target of backlog.reader.symlinkTargets()) {
    if (isDir(target)) add(target);
    for (let d = dirname(target); isInside(root, d); d = dirname(d)) {
      add(d);
      if (d === root) break;
    }
  }
  return { wanted, generated };
}

export const watchPlan = (backlog) => planOf(backlog).wanted;

// `onChange(backlogId)` runs after the debounce. `watch` is injectable for tests.
export function createWatchers(backlogs, onChange, { debounceMs = DEBOUNCE_MS, watch = fsWatch } = {}) {
  const state = new Map(); // id -> { handles: Map(dir -> { watcher, dev, ino }), timer, soon }
  const byId = new Map(backlogs.map((b) => [b.id, b]));
  let closed = false;
  for (const b of backlogs) state.set(b.id, { handles: new Map(), timer: null, soon: false, generated: [] });

  function disarm(s, dir) {
    const h = s.handles.get(dir);
    if (!h) return;
    s.handles.delete(dir);
    try { h.watcher.close(); } catch { /* already closed */ }
  }

  function reconcile(backlog, initial = false) {
    const s = state.get(backlog.id);
    if (closed || !s || !backlog.mainWorktree) return;
    let armedLate = false;
    const { wanted, generated } = planOf(backlog);
    s.generated = generated;
    for (const dir of [...s.handles.keys()]) if (!wanted.has(dir)) disarm(s, dir);
    for (const [dir, accept] of wanted) {
      let st;
      try { st = statSync(dir); } catch { disarm(s, dir); continue; }
      const cur = s.handles.get(dir);
      if (cur && cur.dev === st.dev && cur.ino === st.ino) { cur.accept = accept; continue; }
      disarm(s, dir); // replaced at the same path: the old handle follows the old inode
      try {
        const handle = { dev: st.dev, ino: st.ino, accept, watcher: null };
        handle.watcher = watch(dir, { persistent: false }, (_type, filename) => onEvent(backlog, s, dir, handle, filename));
        handle.watcher.on("error", () => { disarm(s, dir); schedule(backlog, s); });
        s.handles.set(dir, handle);
        if (!initial) {
          // Files written between the replacement and this watch raised no event.
          backlog.reader.invalidate(dir);
          armedLate = true;
        }
      } catch { /* retried by the next reconcile */ }
    }
    if (armedLate) schedule(backlog, s);
  }

  const isGenerated = (list, path) => list.some((g) => (g.dir ? isInside(g.path, path) : g.path === path));

  function onEvent(backlog, s, dir, handle, filename) {
    const name = filename === null || filename === undefined ? null : String(filename);
    if (handle.accept && name !== null && !handle.accept.has(name)) return;
    if (name !== null && isGenerated(s.generated, join(dir, name))) return;
    // An event with no name, or one naming a directory, covers everything beneath it.
    backlog.reader.invalidate(name === null ? dir : join(dir, name));
    if (!s.soon) {
      s.soon = true;
      setImmediate(() => { s.soon = false; reconcile(backlog); });
    }
    schedule(backlog, s);
  }

  function schedule(backlog, s) {
    if (closed || s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      reconcile(backlog);
      if (!closed) onChange(backlog.id);
    }, debounceMs);
    s.timer.unref?.();
  }

  return {
    start() { for (const b of backlogs) reconcile(b, true); },
    reconcile(backlog) { reconcile(typeof backlog === "string" ? byId.get(backlog) : backlog); },
    // The directories currently watched for a backlog, for tests.
    watched(id) { return [...state.get(id).handles.keys()].sort(); },
    close() {
      closed = true;
      for (const [, s] of state) {
        if (s.timer) clearTimeout(s.timer);
        for (const dir of [...s.handles.keys()]) disarm(s, dir);
      }
    },
  };
}
