// Local-mode output helpers (SPEC §8.5, TRL0038).
//
// In `generatedArtifacts: "local"` mode the generated files live in an ignored
// `.generated/` folder. This module holds everything around writing them that
// needs git or the filesystem: the preflight every writer runs, the rollback
// writer and the ignore-line formatter. It is kept out of the core
// (src/backlog.mjs) so that `check` never depends on git (SPEC §8.3).

import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, normalize, posix as posixPath, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_TASKS_DIR, GENERATED_DIR, artifactSet, isLocalMode, markerLineErrors } from "./backlog.mjs";
import { LedgerError, gitEnv, preview } from "./ledger.mjs";

// A refusal before any write. It is a LedgerError (exit 2, `invalid_request`), so
// the CLI and the MCP adapter already map it as a refused request.
export class OutputRefused extends LedgerError {
  constructor(message) {
    super(message, "invalid_request", 2);
    this.name = "OutputRefused";
  }
}

// Test seams: `beforeWrite` runs before each file is written (path and index);
// `rename` replaces the rename used to install files and back them up; `unlink` replaces
// the removal of a staging file after a failed write.
export const testSeams = { beforeWrite: null, rename: null, unlink: null, copy: null };

const firstLine = (s) => String(s || "").trim().split("\n")[0] || "git error";
const posix = (rel) => rel.split(sep).join("/");

// ------------------------------------------------------------ git probes
// Read-only probes. They run with the shared environment cleanup (so an
// inherited GIT_DIR, GIT_INDEX_FILE or ceiling cannot change what they see),
// no fsmonitor command, no optional index refresh, and an English locale so the
// "not a git repository" text can be recognized. Literal pathspecs apply only
// where git supports them (`ls-files`, `status`); `check-ignore` exits 128 on them.
// `literal: false` leaves pathspec magic to the caller, who then writes `:(literal,icase)`.
export function probe(repoRoot, args, { literal = false } = {}) {
  const full = [...(literal ? ["--literal-pathspecs"] : []), "-c", "core.fsmonitor=false", "-C", repoRoot, ...args];
  return spawnSync("git", full, {
    encoding: "utf8",
    env: gitEnv({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const OUTSIDE_REPO = "fatal: not a git repository (or any of the parent directories): .git";

// "inside" a work tree, or "skip": git is absent or the directory is confirmed to
// be outside any work tree. That is only a successful answer of `false`, or exit 128
// with stderr exactly git's outside-repository message. `fatal: not a git repository: <path>`
// is a broken worktree pointer, so it refuses like any other failure or odd answer
// (ownership, permission), since the writer cannot tell whether an output is ignored.
export function discoverGit(repoRoot) {
  const r = probe(repoRoot, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  if (r.error) {
    if (r.error.code === "ENOENT") return "skip";
    throw new OutputRefused(`cannot run git to inspect ${repoRoot}: ${r.error.message}`);
  }
  if (r.status === 0) {
    const answer = r.stdout.split("\n")[0].trim();
    if (answer === "true") return "inside";
    if (answer === "false") return "skip";
    throw new OutputRefused(`git gave an unexpected answer when inspecting ${repoRoot}: ${JSON.stringify(answer)}`);
  }
  if (r.status === 128 && r.stderr.replace(/\n$/, "") === OUTSIDE_REPO) return "skip";
  throw new OutputRefused(`git could not inspect ${repoRoot}: ${firstLine(r.stderr)}`);
}

// The target's path from the git root ("" at the root, else "sub/dir/"), so the
// printed ignore line is right for the root `.gitignore`. "" when git cannot say.
export function gitPrefix(repoRoot) {
  const r = probe(repoRoot, ["rev-parse", "--show-prefix"]);
  return r.status === 0 ? r.stdout.replace(/\n$/, "").split("\n")[0] : "";
}

// The line a user adds to the repository root `.gitignore` so the generated folder
// is ignored: the git-root prefix plus the backlog root as a normalized literal
// path, every gitignore metacharacter escaped.
export function ignoreLineFor(tasksDir, prefix = "") {
  const own = normalize(String(tasksDir || DEFAULT_TASKS_DIR)).split(sep).join("/");
  const dir = posixPath.normalize(prefix + own).split("/").filter((p) => p && p !== ".").join("/");
  const escaped = dir.replace(/[*?[\]!#\\]/g, "\\$&").replace(/^ /, "\\ ").replace(/ $/, "\\ ");
  return `${escaped}/${GENERATED_DIR}/`;
}

// True when git found a case-insensitive filesystem (`git init` probes it into
// `core.ignorecase`). Read-only, so nothing is written into the repository.
export function foldsCase(repoRoot) {
  const r = probe(repoRoot, ["config", "--type=bool", "core.ignorecase"]);
  return r.status === 0 && r.stdout.trim() === "true";
}

// A literal pathspec for `rel`, case-insensitive when asked. Callers that pass these must
// run the probe without the global `--literal-pathspecs` flag, which would read the magic as text.
export function pathspec(rel, icase) {
  return icase ? `:(literal,icase)./${rel}` : `./${rel}`;
}

// The shared output-path verifier: `check-ignore -q --no-index` per output (0 is
// ignored, 1 is not, 128 is a git error to report) and literal `ls-files` for
// tracked outputs. Returns `{ inside: false }` when git does not apply.
export function verifyOutputPaths(repoRoot, cfg) {
  const outputs = artifactSet(repoRoot, cfg).generated;
  if (discoverGit(repoRoot) !== "inside") {
    // A non-git target can still hold a nested checkout at an output folder; its own
    // repository would track or ignore the files, so refuse that too.
    for (const e of outputs) {
      let dir = dirname(e.path);
      while (!existsSync(dir)) dir = dirname(dir);
      // Classify like the target: only a confirmed outside answer skips; any other failure
      // (ownership, permission, an odd answer) refuses.
      if (discoverGit(dir) === "inside") {
        const t = probe(dir, ["rev-parse", "--show-toplevel"]);
        throw new OutputRefused(`${posix(relative(repoRoot, dir)) || "."} is inside a git work tree (${t.stdout.replace(/\n$/, "")}) although the target is not one, so git cannot say whether ${posix(e.rel)} is ignored. Remove the nested checkout or move the backlog root out of it`);
      }
    }
    return { inside: false, unignored: [], tracked: [] };
  }
  // A nested checkout between the target and an output would answer the ignore and
  // tracked questions for its own repository, not the target's.
  const topOf = (dir) => {
    const t = probe(dir, ["rev-parse", "--show-toplevel"]);
    if (t.status === 0) return realpathSync(t.stdout.replace(/\n$/, ""));
    if (t.status === 128 && t.stderr.replace(/\n$/, "") === OUTSIDE_REPO) return null;
    throw new OutputRefused(`git could not inspect ${dir}: ${t.error ? t.error.message : firstLine(t.stderr)}`);
  };
  const targetTop = topOf(repoRoot);
  for (const e of outputs) {
    let dir = dirname(e.path);
    while (!existsSync(dir)) dir = dirname(dir);
    const top = topOf(dir);
    if (top !== null && top !== targetTop) {
      throw new OutputRefused(`${posix(relative(repoRoot, dir)) || "."} belongs to a separate git work tree (${top}), so git cannot say whether ${posix(e.rel)} is ignored here. Remove the nested checkout or move the backlog root out of it`);
    }
  }
  const unignored = [];
  for (const e of outputs) {
    const r = probe(repoRoot, ["check-ignore", "-q", "--no-index", "--", `./${posix(e.rel)}`]);
    if (r.status === 1) unignored.push(e.rel);
    else if (r.status !== 0) throw new OutputRefused(`git check-ignore failed for ${e.rel}: ${r.error ? r.error.message : firstLine(r.stderr)}`);
  }
  // Match the expected paths with `:(literal,icase)` where the filesystem folds case, so git
  // itself finds a tracked `.generated/INDEX.md` as the output it aliases.
  const icase = foldsCase(repoRoot);
  const specs = outputs.map((e) => pathspec(posix(e.rel), icase));
  const ls = probe(repoRoot, ["ls-files", "-z", "--", ...specs], { literal: !icase });
  if (ls.status !== 0) throw new OutputRefused(`git ls-files failed: ${ls.error ? ls.error.message : firstLine(ls.stderr)}`);
  const tracked = ls.stdout.split("\0").filter(Boolean);
  return { inside: true, unignored, tracked };
}

// ---------------------------------------------------------- filesystem checks
// `.generated` must be a real directory and every existing output a regular file,
// in scan and ledger mode, with or without git. A symlink could carry a write out
// of the checkout, and a directory or FIFO cannot be replaced or read.
export function checkOutputFiles(repoRoot, cfg) {
  const set = artifactSet(repoRoot, cfg);
  const inspect = (path) => {
    try {
      return lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new OutputRefused(`cannot inspect ${path}: ${e.message}`);
    }
  };
  const dirRel = posix(relative(repoRoot, set.dir));
  // Every folder from the target root down to `.generated` (the backlog root included)
  // must be a real directory, or a write could leave the checkout through a link.
  let at = repoRoot;
  for (const part of relative(repoRoot, dirname(set.dir)).split(sep).filter(Boolean)) {
    at = join(at, part);
    const st = inspect(at);
    if (!st) break;
    if (st.isSymbolicLink()) throw new OutputRefused(`${posix(relative(repoRoot, at))} is a symlink; local mode writes only through real directories. Replace it with a directory`);
    if (!st.isDirectory()) throw new OutputRefused(`${posix(relative(repoRoot, at))} is not a directory; local mode generates into a folder below it`);
  }
  const dir = inspect(set.dir);
  if (!dir) return;
  if (dir.isSymbolicLink()) throw new OutputRefused(`${dirRel} is a symlink; local mode writes only into a real directory. Replace it with a directory`);
  if (!dir.isDirectory()) throw new OutputRefused(`${dirRel} is not a directory; local mode generates into a folder there. Move the file away`);
  for (const e of set.generated) {
    const st = inspect(e.path);
    if (!st) continue;
    if (st.isSymbolicLink()) throw new OutputRefused(`${posix(e.rel)} is a symlink; local mode does not write through symlinked generated files. Replace it with a regular file`);
    if (!st.isFile()) throw new OutputRefused(`${posix(e.rel)} is not a regular file; local mode only writes regular generated files`);
  }
}

// The preflight every local-mode writer runs before it writes or claims anything:
// no leftover marker, sound output paths, and (inside a git work tree) every output
// ignored and untracked. Does nothing in committed mode. `check` never calls it.
export function outputPreflight(repoRoot, cfg) {
  if (!isLocalMode(cfg)) return;
  const markers = markerLineErrors(repoRoot, cfg);
  if (markers.length) throw new OutputRefused(markers.join("\n"));
  checkOutputFiles(repoRoot, cfg);
  const { unignored, tracked } = verifyOutputPaths(repoRoot, cfg);
  if (unignored.length) {
    throw new OutputRefused(`${unignored.map(posix).join(", ")} ${unignored.length > 1 ? "are" : "is"} not ignored by git. Add this line to the .gitignore at the repository root and run again:\n  ${ignoreLineFor(cfg.tasksDir, gitPrefix(repoRoot))}`);
  }
  if (tracked.length) {
    throw new OutputRefused(`${tracked.join(", ")} ${tracked.length > 1 ? "are" : "is"} tracked by git, but local mode keeps generated files out of git. Untrack ${tracked.length > 1 ? "them" : "it"} (git rm --cached) and run again`);
  }
}

// The `nextId` a local-mode writer publishes in `.generated/backlog.json`: the
// ledger preview in local ledger mode (`null` when the ref is missing or unusable),
// otherwise `undefined`, which keeps the scan value.
export function previewNextId(repoRoot, cfg) {
  if (!isLocalMode(cfg) || cfg.idAllocation !== "ledger") return undefined;
  return preview(repoRoot, cfg).nextId;
}

// ------------------------------------------------------------- writing
// Creates `dir` and any missing parents, recording each directory it makes so a
// rollback removes only what this call created.
export function makeDirs(dir, created) {
  const missing = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.push(d);
    if (dirname(d) === d) break;
  }
  for (const d of missing.reverse()) {
    mkdirSync(d);
    created.push(d);
  }
}

// Removes the recorded directories, deepest first, keeping any that are not empty.
export function removeCreatedDirs(created) {
  for (const d of [...created].reverse()) {
    try { rmdirSync(d); } catch { /* not empty, or already gone */ }
  }
}

// Creates a staging or backup file that did not exist, so a path an attacker or an
// earlier run left behind (even a symlink) is never written through.
function reserveStage(dest, ext) {
  for (let i = 0; i < 20; i++) {
    const name = join(dirname(dest), `.${basename(dest)}.${process.pid}-${randomBytes(6).toString("hex")}.${ext}`);
    try {
      return { name, fd: openSync(name, "wx", 0o600) };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new LedgerError(`could not reserve a staging file beside ${dest}`, "generate_failed");
}

export function stageFile(dest, ext, content, mode) {
  const { name, fd } = reserveStage(dest, ext);
  try {
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    closeSync(fd);
  } catch (e) {
    // The path was reserved by this call, so a failed write must not leave it behind.
    try { closeSync(fd); } catch { /* already closed */ }
    try {
      (testSeams.unlink || unlinkSync)(name);
    } catch (ue) {
      // Name the file that is still there, so the user can remove it.
      const err = new LedgerError(`${e.message}; could not remove the staging file ${name}: ${ue.message}`, "generate_failed");
      err.stagePath = name;
      throw err;
    }
    throw e;
  }
  return name;
}

const move = (from, to) => (testSeams.rename || renameSync)(from, to);

// Installs files through staged copies and backups. Each replacement is staged beside its
// destination, the original is copied to a unique backup, and the stage is renamed over
// the destination, so the destination is never absent. A failure renames every backup back over the destination and removes files that had no original. A
// backup is recorded only after its rename succeeds. One that cannot go back is kept and
// named in the thrown error. `entries` are `{ path, content, skip? }`; `hooks.before(path, i)`
// runs ahead of each entry and `hooks.after()` once all are in. Returns the installed paths
// and the backups it could not remove (`leftover`, with its reason).
export function installStaged(entries, hooks = {}, failureText = "could not restore every file") {
  const plan = entries.map((entry) => ({ entry, temp: null, backup: null, done: false }));
  const installed = [];
  try {
    for (const p of plan) {
      if (p.entry.skip) continue;
      const mode = existsSync(p.entry.path) ? statSync(p.entry.path).mode & 0o7777 : 0o666 & ~process.umask();
      p.temp = stageFile(p.entry.path, "tmp", p.entry.content, mode);
    }
    plan.forEach((p, i) => {
      if (hooks.before) hooks.before(p.entry.path, i);
      if (p.entry.skip) return;
      if (existsSync(p.entry.path)) {
        // Copy, never move: the destination stays in place so a reader never sees it absent.
        const backup = join(dirname(p.entry.path), `.${basename(p.entry.path)}.${process.pid}-${randomBytes(6).toString("hex")}.bak`);
        try {
          (testSeams.copy || copyFileSync)(p.entry.path, backup, constants.COPYFILE_EXCL);
          chmodSync(backup, statSync(p.entry.path).mode & 0o7777);
        } catch (ce) {
          try { rmSync(backup, { force: true }); } catch { /* the copy error is the one to report */ }
          throw ce;
        }
        p.backup = backup;
        installed.push(p);
      }
      move(p.temp, p.entry.path);
      p.temp = null;
      if (!installed.includes(p)) installed.push(p);
    });
    if (hooks.after) hooks.after();
  } catch (e) {
    const kept = [];
    const failed = [];
    if (e.stagePath) failed.push(`the staging file ${e.stagePath} is still there`);
    for (const p of installed.reverse()) {
      try {
        if (p.backup) move(p.backup, p.entry.path); else rmSync(p.entry.path, { force: true });
        p.backup = null;
      } catch (re) {
        if (p.backup) kept.push(`${p.backup} (original of ${p.entry.path})`);
        else failed.push(`could not remove ${p.entry.path}: ${re.message}`);
        p.backup = null;
      }
    }
    for (const p of plan) {
      if (p.temp) {
        try { rmSync(p.temp, { force: true }); } catch (re) { failed.push(`could not remove the staging file ${p.temp}: ${re.message}`); }
      }
    }
    if (kept.length || failed.length) {
      const parts = [e.message, failureText];
      if (kept.length) parts.push(`originals kept at: ${kept.join(", ")}`);
      if (failed.length) parts.push(failed.join("; "));
      const err = new LedgerError(parts.join("; "), "generate_failed");
      err.kept = kept;
      err.failed = failed;
      err.original = e.message;
      throw err;
    }
    throw e;
  }
  const leftover = [];
  for (const p of plan) {
    if (!p.backup) continue;
    try { rmSync(p.backup, { force: true }); } catch (e) { leftover.push(`could not remove the backup ${p.backup}: ${e.message}`); }
  }
  return { installed: plan.filter((p) => !p.entry.skip).map((p) => p.entry.path), leftover };
}

// Writes each changed file, making its folder first, through `installStaged`. A failure
// restores changed files, removes new ones, then removes the folders this call created
// when they are empty, so a failed run leaves the tree as it was. Returns the absolute
// paths it changed and any backup it could not remove, as `{ changed, warnings }`.
export function writeArtifactFiles(files) {
  const created = [];
  try {
    for (const dir of new Set(files.map((f) => dirname(f.path)))) makeDirs(dir, created);
    const entries = files.map((f) => ({ path: f.path, content: f.content, skip: existsSync(f.path) && readFileSync(f.path, "utf8") === f.content }));
    const out = installStaged(entries, { before: (path, i) => { if (testSeams.beforeWrite) testSeams.beforeWrite(path, i); } });
    return { changed: out.installed, warnings: out.leftover };
  } catch (e) {
    removeCreatedDirs(created);
    throw e;
  }
}
