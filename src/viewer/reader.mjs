// The viewer's contained, cached file reader (TRL0005).
//
// Every read resolves symlinks first and stays inside one backlog's main worktree. A file is
// opened without blocking and its descriptor must be a regular file, so a FIFO can never hang
// the server. Parsed items are cached by path, size and mtime.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { parseFrontMatter, splitFrontMatter } from "../backlog.mjs";

const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0);
const GONE = new Set(["ENOENT", "ENOTDIR"]);
// Fields the reader sets itself; an authored one must not reach the scan.
const INTERNAL_KEYS = ["_file", "_effortLabel", "_effortEmoji", "_effortImage"];
export const OUTSIDE = "resolves outside the main worktree";

const within = (parent, child) => child === parent || child.startsWith(parent + sep);
export const isInside = within;

// `hooks.beforeOpen(path)` runs after the path check and before the open; `hooks.afterList(dir)`
// after a listing. They exist so tests can swap a file or remove a directory at that instant.
// `hooks.fstat` and `hooks.read` stand in for the descriptor calls so a test can fail them.
export function createReader(root, hooks = {}) {
  const fstat = hooks.fstat || fstatSync;
  const read = hooks.read || readFileSync;
  const cache = new Map(); // task path -> { size, mtimeMs, real, fm, body, syntaxErrors }
  let lastRead = new Map(); // `where` -> { path, fm, body, syntaxErrors }, for the current rebuild
  let listed = new Map(); // dir -> { names, real, dev, ino }, for the current rebuild
  let forced = new Map(); // dir -> reason, skipped for the rest of the rebuild
  let targets = new Set(); // resolved symlink targets accepted in the current rebuild
  let hops = new Map(); // directory -> names of the symlinks it holds on the way to an accepted target
  const lastTargets = new Map(); // symlink path -> last accepted target, kept across rebuilds

  // A symlink whose target went missing keeps its last target watched, so restoring the target
  // is noticed. A link that is gone itself, or replaced by a plain file, is forgotten.
  const trackTarget = (path, real) => {
    if (real !== path) lastTargets.set(path, real); else lastTargets.delete(path);
  };
  const keepMissingTarget = (path) => {
    const last = lastTargets.get(path);
    if (!last) return;
    try { lstatSync(path); } catch { lastTargets.delete(path); return; }
    if (within(root, last)) { targets.add(last); noteHops(path); }
  };

  // Walks `path` one component at a time and records the directory holding each symlink it
  // meets, so retargeting a link in the middle of a chain (not only the last one) is noticed.
  const noteHops = (path) => {
    let pending = path;
    for (let guard = 0; guard < 40; guard++) {
      const { root: top } = parse(pending);
      const parts = pending.slice(top.length).split(sep).filter(Boolean);
      let cur = top;
      let again = null;
      for (let i = 0; i < parts.length && !again; i++) {
        const next = join(cur, parts[i]);
        let link = null;
        try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { return; }
        if (link === null) { cur = next; continue; }
        if (within(root, cur)) hops.set(cur, (hops.get(cur) ?? new Set()).add(parts[i]));
        again = resolve(cur, link, ...parts.slice(i + 1));
      }
      if (!again) return;
      pending = again;
    }
  };

  const realOf = (path) => {
    try {
      const real = realpathSync.native(path);
      trackTarget(path, real);
      if (real !== path) noteHops(path);
      return { real };
    } catch (e) {
      if (!GONE.has(e.code)) return { skip: e.code || e.message };
      keepMissingTarget(path);
      return { absent: true };
    }
  };

  // Opens `path` for reading. Returns { fd, real, st } or { absent } or { skip: reason }.
  function openRegular(path) {
    const r = realOf(path);
    if (!r.real) return r;
    if (!within(root, r.real)) return { skip: OUTSIDE };
    if (hooks.beforeOpen) hooks.beforeOpen(path);
    let fd;
    try { fd = openSync(r.real, OPEN_FLAGS); } catch (e) {
      return GONE.has(e.code) ? { absent: true } : { skip: `cannot open (${e.code || e.message})` };
    }
    let st;
    try { st = fstat(fd); } catch (e) {
      closeSync(fd);
      return { skip: `cannot read (${e.code || e.message})` };
    }
    if (!st.isFile()) { closeSync(fd); return { skip: "not a regular file" }; }
    if (r.real !== path) targets.add(r.real);
    return { fd, real: r.real, st };
  }

  // Reads and always closes the descriptor; a failed read is a skip, never a throw.
  const readFd = (fd, encoding) => {
    try { return { data: read(fd, encoding) }; } catch (e) {
      return { skip: `cannot read (${e.code || e.message})` };
    } finally { closeSync(fd); }
  };

  return {
    root,
    // A new rebuild: forget what the last one read and listed.
    begin() {
      lastRead = new Map(); listed = new Map(); forced = new Map(); targets = new Set(); hops = new Map();
    },
    // For the config and roster: text, `null` when absent, or { skip }.
    readText(path) {
      const o = openRegular(path);
      if (o.absent) return null;
      if (o.skip) return { skip: o.skip };
      const r = readFd(o.fd, "utf8");
      return r.skip ? { skip: r.skip } : r.data;
    },
    readItem(path, where) {
      const o = openRegular(path);
      if (o.absent) return { skip: "file vanished before it was read" };
      if (o.skip) return { skip: o.skip };
      let entry = cache.get(path);
      if (entry && entry.size === o.st.size && entry.mtimeMs === o.st.mtimeMs && entry.real === o.real) {
        closeSync(o.fd);
      } else {
        const r = readFd(o.fd, "utf8");
        if (r.skip) return { skip: r.skip };
        const text = r.data;
        const syntaxErrors = [];
        const fm = parseFrontMatter(text, where, syntaxErrors);
        entry = { size: o.st.size, mtimeMs: o.st.mtimeMs, real: o.real, fm, body: splitFrontMatter(text).body, syntaxErrors };
        cache.set(path, entry);
      }
      lastRead.set(where, { path, fm: entry.fm, body: entry.body, syntaxErrors: entry.syntaxErrors });
      let fm = null;
      if (entry.fm) {
        fm = { ...entry.fm };
        for (const k of INTERNAL_KEYS) delete fm[k];
      }
      return { fm, body: entry.body, syntaxErrors: [...entry.syntaxErrors] };
    },
    // One guarded listing per directory: names, `[]` when absent, or { skip }.
    listDir(dir) {
      if (forced.has(dir)) return { skip: forced.get(dir) };
      const r = realOf(dir);
      if (r.absent) return [];
      if (r.skip) return { skip: r.skip };
      if (!within(root, r.real)) return { skip: OUTSIDE };
      let names;
      let before;
      try { before = statSync(r.real); names = readdirSync(r.real); } catch (e) {
        return { skip: GONE.has(e.code) ? "directory vanished while it was read" : `cannot list (${e.code || e.message})` };
      }
      if (hooks.afterList) hooks.afterList(dir);
      // A swap during the read (a symlink retargeted, a directory replaced) makes the names
      // untrustworthy, so the listing is dropped whole rather than mixed with the new target.
      const again = realOf(dir);
      if (again.absent) return { skip: "directory vanished while it was read" };
      if (again.skip) return { skip: again.skip };
      if (!within(root, again.real)) return { skip: OUTSIDE };
      let after;
      try { after = statSync(again.real); } catch { return { skip: "directory vanished while it was read" }; }
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) return { skip: "directory changed while it was read" };
      if (r.real !== dir) targets.add(r.real);
      listed.set(dir, { names, real: r.real, dev: after.dev, ino: after.ino });
      return names;
    },
    // Another pass of the same rebuild: forget the reads, keep forced skips and symlink targets.
    retry() {
      lastRead = new Map(); listed = new Map();
    },
    // Why a directory listed this rebuild can no longer be trusted, or null. Run after the item
    // reads: a directory swapped for an out-of-worktree symlink in between must not count.
    listedDirProblem(dir) {
      const was = listed.get(dir);
      if (!was) return null;
      const now = realOf(dir);
      if (now.absent) return "directory vanished during the rebuild";
      if (now.skip) return now.skip;
      let st;
      try { st = statSync(now.real); } catch { return "directory vanished during the rebuild"; }
      if (now.real !== was.real || st.dev !== was.dev || st.ino !== was.ino) return "directory changed during the rebuild";
      return null;
    },
    forceSkip(dir, reason) {
      forced.set(dir, reason);
    },
    // What the current rebuild read: `where` -> { path, fm, body, syntaxErrors }.
    reads() {
      return lastRead;
    },
    // Symlink targets inside the worktree that this rebuild accepted.
    symlinkTargets() {
      return [...targets];
    },
    // [directory, link names] pairs inside the worktree for each symlink on the way to an accepted target.
    symlinkHops() {
      return [...hops].map(([dir, names]) => [dir, [...names]]);
    },
    // Drops every cached item whose own path or resolved target is `path` or beneath it.
    invalidate(path) {
      for (const [key, e] of cache) if (within(path, key) || within(path, e.real)) cache.delete(key);
    },
    invalidateAll() {
      cache.clear();
    },
    // Reads an asset file whose resolved path stays inside both the worktree and `assetRoot`.
    readBinary(path, assetRoot, maxBytes = 10 * 1024 * 1024) {
      const rootReal = realOf(assetRoot);
      if (!rootReal.real || !within(root, rootReal.real)) return null;
      const o = openRegular(path);
      if (!o.fd) return null;
      if (!within(rootReal.real, o.real) || o.st.size > maxBytes) { closeSync(o.fd); return null; }
      return readFd(o.fd).data ?? null;
    },
    resolve(path) {
      return realOf(path);
    },
  };
}
