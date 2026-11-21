// The viewer's contained, cached file reader (TRL0005).
//
// Every read resolves symlinks first and stays inside one backlog's main worktree. A file is
// opened without blocking and its descriptor must be a regular file, so a FIFO can never hang
// the server. Parsed items are cached by path, size and mtime.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { sep } from "node:path";
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
export function createReader(root, hooks = {}) {
  const cache = new Map(); // task path -> { size, mtimeMs, real, fm, body, syntaxErrors }
  let lastRead = new Map(); // `where` -> { path, fm, body, syntaxErrors }, for the current rebuild
  let listed = new Map(); // dir -> names, for the current rebuild
  let forced = new Map(); // dir -> reason, skipped for the rest of the rebuild
  let targets = new Set(); // resolved symlink targets accepted in the current rebuild
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
    if (within(root, last)) targets.add(last);
  };

  const realOf = (path) => {
    try { const real = realpathSync.native(path); trackTarget(path, real); return { real }; } catch (e) {
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
    const st = fstatSync(fd);
    if (!st.isFile()) { closeSync(fd); return { skip: "not a regular file" }; }
    if (r.real !== path) targets.add(r.real);
    return { fd, real: r.real, st };
  }

  const readFd = (fd) => { try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); } };

  return {
    root,
    // A new rebuild: forget what the last one read and listed.
    begin() {
      lastRead = new Map(); listed = new Map(); forced = new Map(); targets = new Set();
    },
    // For the config and roster: text, `null` when absent, or { skip }.
    readText(path) {
      const o = openRegular(path);
      if (o.absent) return null;
      if (o.skip) return { skip: o.skip };
      return readFd(o.fd);
    },
    readItem(path, where) {
      const o = openRegular(path);
      if (o.absent) return { skip: "file vanished before it was read" };
      if (o.skip) return { skip: o.skip };
      let entry = cache.get(path);
      if (entry && entry.size === o.st.size && entry.mtimeMs === o.st.mtimeMs && entry.real === o.real) {
        closeSync(o.fd);
      } else {
        const text = readFd(o.fd);
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
      try { names = readdirSync(r.real); } catch (e) {
        return { skip: GONE.has(e.code) ? "directory vanished while it was read" : `cannot list (${e.code || e.message})` };
      }
      if (r.real !== dir) targets.add(r.real);
      listed.set(dir, names);
      if (hooks.afterList) hooks.afterList(dir);
      return names;
    },
    // Another pass of the same rebuild: forget the reads, keep forced skips and symlink targets.
    retry() {
      lastRead = new Map(); listed = new Map();
    },
    // True when a directory this rebuild listed has since gone.
    listedDirGone(dir) {
      return listed.has(dir) && realOf(dir).absent === true;
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
      try { return readFileSync(o.fd); } finally { closeSync(o.fd); }
    },
    resolve(path) {
      return realOf(path);
    },
  };
}
