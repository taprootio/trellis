// Local-mode output helpers (SPEC §8.5, TRL0038).
//
// In `generatedArtifacts: "local"` mode the generated files live in an ignored
// `.generated/` folder. This module holds everything around writing them that
// needs git or the filesystem: the preflight every writer runs, the rollback
// writer and the ignore-line formatter. It is kept out of the core
// (src/backlog.mjs) so that `check` never depends on git (SPEC §8.3).

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, posix as posixPath, relative, sep } from "node:path";
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

// Test seam: runs before each file is written, with the path and its index.
export const testSeams = { beforeWrite: null };

const firstLine = (s) => String(s || "").trim().split("\n")[0] || "git error";
const posix = (rel) => rel.split(sep).join("/");

// ------------------------------------------------------------ git probes
// Read-only probes. They run with the shared environment cleanup (so an
// inherited GIT_DIR, GIT_INDEX_FILE or ceiling cannot change what they see),
// no fsmonitor command, no optional index refresh, and an English locale so the
// "not a git repository" text can be recognized. Literal pathspecs apply only
// where git supports them (`ls-files`, `status`); `check-ignore` exits 128 on them.
export function probe(repoRoot, args, { literal = false } = {}) {
  const full = [...(literal ? ["--literal-pathspecs"] : []), "-c", "core.fsmonitor=false", "-C", repoRoot, ...args];
  return spawnSync("git", full, {
    encoding: "utf8",
    env: gitEnv({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// "inside" a work tree, or "skip": git is absent or the directory is confirmed to
// be outside any work tree. That is only a successful answer of `false`, or git's own
// not-a-repository exit (128) with its standard message at the start of stderr. Any
// other failure or answer (ownership, permission, an odd reply) refuses, since the
// writer cannot tell whether an output is ignored.
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
  if (r.status === 128 && r.stderr.startsWith("fatal: not a git repository")) return "skip";
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

// The shared output-path verifier: `check-ignore -q --no-index` per output (0 is
// ignored, 1 is not, 128 is a git error to report) and literal `ls-files` for
// tracked outputs. Returns `{ inside: false }` when git does not apply.
export function verifyOutputPaths(repoRoot, cfg) {
  if (discoverGit(repoRoot) !== "inside") return { inside: false, unignored: [], tracked: [] };
  const outputs = artifactSet(repoRoot, cfg).generated;
  const unignored = [];
  for (const e of outputs) {
    const r = probe(repoRoot, ["check-ignore", "-q", "--no-index", "--", `./${posix(e.rel)}`]);
    if (r.status === 1) unignored.push(e.rel);
    else if (r.status !== 0) throw new OutputRefused(`git check-ignore failed for ${e.rel}: ${r.error ? r.error.message : firstLine(r.stderr)}`);
  }
  // List each output's folder, then match the expected paths case-insensitively where the
  // filesystem is, so a tracked `.generated/INDEX.md` counts as the output it aliases.
  const fold = foldsCase(repoRoot) ? (p) => p.toLowerCase() : (p) => p;
  const folders = [...new Set(outputs.map((e) => `./${posix(dirname(e.rel))}`))];
  const ls = probe(repoRoot, ["ls-files", "-z", "--", ...folders], { literal: true });
  if (ls.status !== 0) throw new OutputRefused(`git ls-files failed: ${ls.error ? ls.error.message : firstLine(ls.stderr)}`);
  const expected = new Set(outputs.map((e) => fold(posix(e.rel))));
  const tracked = ls.stdout.split("\0").filter(Boolean).filter((p) => expected.has(fold(p)));
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

// Writes each changed file, making its folder first. A failure restores changed
// files, removes new or partly written ones, then removes the folders this call
// created when they are empty, so a failed run leaves the tree as it was.
// Returns the absolute paths it changed.
export function writeArtifactFiles(files) {
  const prior = files.map((f) => (existsSync(f.path) ? readFileSync(f.path, "utf8") : null));
  const created = [];
  const started = [];
  try {
    for (const dir of new Set(files.map((f) => dirname(f.path)))) makeDirs(dir, created);
    files.forEach((f, i) => {
      if (testSeams.beforeWrite) testSeams.beforeWrite(f.path, i);
      if (prior[i] === f.content) return;
      started.push(i);
      writeFileSync(f.path, f.content);
    });
    return started.map((i) => files[i].path);
  } catch (e) {
    for (const i of started.reverse()) {
      try { prior[i] === null ? rmSync(files[i].path, { force: true }) : writeFileSync(files[i].path, prior[i]); } catch { /* best-effort restore */ }
    }
    removeCreatedDirs(created);
    throw e;
  }
}
