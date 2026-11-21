// Resolves a configured path to its repository's main worktree (TRL0005).
//
// `git worktree list` names the main worktree first. The checks below make sure that entry
// is a real checkout of the same clone, so the viewer never serves the wrong tree.

import { existsSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../ledger.mjs";

export const MIN_WORKTREE_GIT = "2.36";

// One backlog's layout problem; the other backlogs still serve.
export class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutError";
  }
}

function defaultGit(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { status: null, stdout: "", stderr: r.error.code === "ENOENT" ? "git is not available on PATH" : r.error.message };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const firstLine = (s) => String(s || "").trim().split("\n")[0] || "git error";

function canonical(path, what) {
  try { return realpathSync.native(path); } catch (e) { throw new LayoutError(`unsupported layout: cannot resolve ${what} ${path} (${e.code || e.message})`); }
}

// The first entry of `git worktree list --porcelain -z` output: { path, bare }.
export function firstWorktree(stdout) {
  const fields = stdout.split("\0");
  const entry = { path: null, bare: false };
  for (const f of fields) {
    if (f === "") break;
    if (f.startsWith("worktree ")) entry.path = f.slice("worktree ".length);
    else if (f === "bare") entry.bare = true;
  }
  return entry;
}

// Returns { mainWorktree, gitDir } (both canonical) or throws LayoutError.
// `git(cwd, args)` is injectable so a test can stand in for a layout git will not build.
export function resolveMainWorktree(path, { git = defaultGit } = {}) {
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { /* reported below */ }
  if (!isDir) throw new LayoutError(`path does not exist or is not a directory: ${path}`);

  const list = git(path, ["worktree", "list", "--porcelain", "-z"]);
  if (list.status !== 0) {
    const err = String(list.stderr);
    if (/not a git repository/i.test(err)) throw new LayoutError(`not inside a git repository: ${path}`);
    if (/unknown switch|usage:/i.test(err)) throw new LayoutError(`needs git ${MIN_WORKTREE_GIT} or later for \`worktree list --porcelain -z\``);
    throw new LayoutError(`git worktree list failed: ${firstLine(err)}`);
  }
  const first = firstWorktree(list.stdout);
  if (!first.path) throw new LayoutError("unsupported layout: git listed no worktree");
  if (first.bare) throw new LayoutError("unsupported layout: the first worktree is bare");
  const entry = canonical(first.path, "worktree");
  if (!existsSync(entry)) throw new LayoutError(`unsupported layout: ${entry} does not exist`);

  // A clone made with --separate-git-dir lists its metadata directory, which is no checkout.
  const top = git(entry, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || canonical(top.stdout.trim(), "top level") !== entry) {
    throw new LayoutError(`unsupported layout: ${entry} is not the top of a checkout`);
  }
  const gitDirOut = git(entry, ["rev-parse", "--absolute-git-dir"]);
  const commonOut = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDirOut.status !== 0 || commonOut.status !== 0) throw new LayoutError("unsupported layout: git could not name the repository directories");
  const gitDir = canonical(gitDirOut.stdout.trim(), "git directory");
  if (gitDir !== canonical(commonOut.stdout.trim(), "common git directory")) {
    throw new LayoutError(`unsupported layout: ${entry} belongs to a different repository than ${path}`);
  }
  return { mainWorktree: entry, gitDir };
}
