// Live reload for the viewer (TRL0005).
//
// Non-recursive fs.watch handles only (Linux lacks recursive watching on Node 18). Each
// backlog keeps a set of watched directories derived from its current config. Every event
// invalidates the reader's cache for the paths it names, re-arms missing or replaced
// watchers, and, after a 250 ms debounce, tells the server which backlog changed.

import { readdirSync, statSync, realpathSync, watch as fsWatch } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { DEFAULT_LEDGER_REF, DEFAULT_TASKS_DIR, artifactSet, loadConfig, paths } from "../backlog.mjs";
import { dirIdentity, isInside } from "./reader.mjs";

export const DEBOUNCE_MS = 250;
// fs.watch can drop events under load (seen on macOS): a new or replaced directory goes
// unwatched, or an edit is never reported. A sweep re-arms new or replaced directories and
// compares each watched directory's accepted entries by size and mtime, refreshing once when
// anything changed. It stats entries and reads no file contents.
export const SWEEP_MS = 2000;

// Size, mtime and inode of each entry the native callback would accept, keyed by path. A
// directory that cannot be read is keyed by its own path, so its loss is a change too.
function snapshotOf(s, isGenerated) {
  const out = new Map();
  for (const [dir, handle] of s.handles) {
    let names;
    try { names = readdirSync(dir); } catch { out.set(dir, "-"); continue; }
    for (const name of names) {
      if (handle.accept && !handle.accept.has(name)) continue;
      const path = join(dir, name);
      if (isGenerated(s.generated, path)) continue;
      let st = null;
      try { st = statSync(path); } catch { /* vanished between list and stat */ }
      // A directory's size and mtime move when a file inside it is added; its own handle
      // reports that, so here only its identity counts (a replaced directory has a new inode).
      out.set(path, !st ? "-" : st.isDirectory() ? `d:${dirIdentity(st)}` : `${st.size}:${st.mtimeMs}:${st.ino}`);
    }
  }
  return out;
}

// Paths whose entry differs between two snapshots (added, removed or modified).
function changedPaths(before, after) {
  const out = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
  for (const k of before.keys()) if (!after.has(k)) out.push(k);
  return out;
}

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
  // The worktree root reports the root's top entry (even `trellis`), and each contained
  // ancestor reports the next one down. These also cover a root that resolves outside the
  // worktree and is rejected: swapping it for a real folder must still send an event.
  add(root, [p.tasks.slice(root.length + 1).split(sep)[0]]);
  for (let d = dirname(p.tasks); d !== root && isInside(root, d); d = dirname(d)) add(nearestExisting(d, root));

  if (cfg && cfg.idAllocation === "ledger" && backlog.gitDir) {
    const gitDir = backlog.gitDir;
    const refFile = join(gitDir, cfg.idLedgerRef || DEFAULT_LEDGER_REF);
    const holder = nearestExisting(dirname(refFile), gitDir);
    if (holder) add(holder, [relative(holder, refFile).split(sep)[0]]);
    add(gitDir, ["packed-refs"]);
  }

  // A symlinked task, config or roster: watch the target's directory and every ancestor up
  // to the worktree, so replacing a subtree that holds it is reported. The reader accepted
  // each target earlier; it is resolved again here so one swapped for a link that now
  // points outside is never watched.
  for (const target of backlog.reader.symlinkTargets()) {
    const real = nearestExisting(target, root);
    if (real === target && isDir(real)) add(real);
    for (let d = dirname(target); isInside(root, d); d = dirname(d)) {
      add(nearestExisting(d, root));
      if (d === root) break;
    }
  }
  // Each directory holding a link on the way to a target: retargeting a middle link changes
  // that directory (for those names), which need not be an ancestor of the final target.
  for (const [hop, names] of backlog.reader.symlinkHops()) add(nearestExisting(hop, root), names);
  return { wanted, generated };
}

export const watchPlan = (backlog) => planOf(backlog).wanted;

// `onChange(backlogId)` runs after the debounce. `watch` is injectable for tests.
export function createWatchers(backlogs, onChange, { debounceMs = DEBOUNCE_MS, sweepMs = SWEEP_MS, watch = fsWatch } = {}) {
  const state = new Map(); // id -> { handles: Map(dir -> { watcher, dev, ino }), timer, soon }
  const byId = new Map(backlogs.map((b) => [b.id, b]));
  let closed = false;
  let sweep = null;
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
      if (cur && cur.id === dirIdentity(st)) { cur.accept = accept; continue; }
      disarm(s, dir); // replaced at the same path: the old handle follows the old inode
      try {
        const handle = { id: dirIdentity(st), accept, watcher: null };
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
      // This refresh covers every change so far; the sweep must not report them again. A
      // change another file's native event never named (a same-size, same-mtime replacement
      // whose event was dropped) must be invalidated before the snapshot moves past it.
      const sig = snapshotOf(s, isGenerated);
      if (s.signature) for (const path of changedPaths(s.signature, sig)) backlog.reader.invalidate(path);
      s.signature = sig;
      if (!closed) onChange(backlog.id);
    }, debounceMs);
    s.timer.unref?.();
  }

  return {
    start() {
      for (const b of backlogs) {
        reconcile(b, true);
        // An edit made before the first sweep, with its event dropped, is still a change.
        const s = state.get(b.id);
        if (s) s.signature = snapshotOf(s, isGenerated);
      }
      if (sweepMs > 0 && !sweep) {
        sweep = setInterval(() => {
          for (const b of backlogs) {
            reconcile(b);
            const s = state.get(b.id);
            if (closed || !s) continue;
            const sig = snapshotOf(s, isGenerated);
            const changed = s.signature ? changedPaths(s.signature, sig) : [];
            if (changed.length) {
              // Something changed that no event reported: drop just those entries and refresh.
              for (const path of changed) b.reader.invalidate(path);
              schedule(b, s);
            }
            s.signature = sig;
          }
        }, sweepMs);
        sweep.unref?.();
      }
    },
    reconcile(backlog) { reconcile(typeof backlog === "string" ? byId.get(backlog) : backlog); },
    // The directories currently watched for a backlog, for tests.
    watched(id) { return [...state.get(id).handles.keys()].sort(); },
    close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      for (const [, s] of state) {
        if (s.timer) clearTimeout(s.timer);
        for (const dir of [...s.handles.keys()]) disarm(s, dir);
      }
    },
  };
}

