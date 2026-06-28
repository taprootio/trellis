// Trellis git-derived task history (SPEC §8.4 — a derived, NON-gated report).
//
// A lightweight per-task change log — who changed an item, when, and why —
// reconstructed from git, plus a materialized `history.json` a static viewer can
// read without a git runtime. This is deliberately a SEPARATE module from the
// generator core (src/backlog.mjs): keeping every `git` invocation out of the core
// structurally guarantees that `backlog:check` (the deterministic gate, SPEC §8.3)
// never depends on git history. History is volatile by nature (commit times,
// authors), so it is never part of `--check` and never written by the generator.
//
// git is the authoritative deep record; this module only reads it. Imported items
// (TRL0021/22) carry history from the import commit forward — a single-commit or
// unborn-HEAD history yields `[]`, never a crash. Per-task derivation uses
// `git log --follow` so history survives the active→completed move (and, as it
// happens, the `PL→TRL` prefix migration and the `docs/tasks → trellis/`
// relocation, which `--follow` also tracks through the renames).

import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "./backlog.mjs";

// A typed failure the callers classify: the CLI prints it and exits non-zero; the
// MCP adapter maps it to a TrellisError (an isError result), so neither surfaces a
// raw stack trace. `code` is a short slug for programmatic handling.
export class HistoryError extends Error {
  constructor(message, code = "history_failed") {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

// Field/record delimiters for the `git log` custom format. ASCII unit/record
// separators (0x1F/0x1E) cannot appear in commit subjects, author names, dates, or
// single-line trailer values, so the output parses unambiguously without quoting.
const FIELD = "\x1f";
const RECORD = "\x1e";

// commit (full SHA) · author date (strict ISO 8601) · author name · subject ·
// the Trellis-Reason trailer value (empty when absent → reason falls back to the
// subject). Multiple Trellis-Reason trailers are joined with a comma.
const FORMAT =
  "%H%x1f%aI%x1f%an%x1f%s%x1f%(trailers:key=Trellis-Reason,valueonly,separator=%x2c)%x1e";

// Run git with an arg array (NO shell) rooted at repoRoot. Errors propagate to the
// caller, which classifies them (missing git, not a repo, unborn HEAD, real failure).
function git(repoRoot, args) {
  // Capture stderr (don't inherit it — the *Sync exec default): it feeds gitMsg() on
  // failure, and the MCP server reserves its own stderr for diagnostics.
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// First line of the most useful diagnostic from a failed git call.
function gitMsg(e) {
  const s = (e && e.stderr ? String(e.stderr) : e && e.message ? e.message : String(e)).trim();
  return s.split("\n")[0] || "git error";
}

// Assert repoRoot is inside a git work tree, distinguishing "git not installed"
// (ENOENT) from "not a git repo" so the message is actionable.
export function assertGitRepo(repoRoot) {
  let out;
  try {
    out = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).trim();
  } catch (e) {
    if (e && e.code === "ENOENT") throw new HistoryError("git is not available on PATH", "git_unavailable");
    throw new HistoryError(`not a git work tree: ${repoRoot}`, "not_a_git_repo");
  }
  if (out !== "true") throw new HistoryError(`not a git work tree: ${repoRoot}`, "not_a_git_repo");
}

// True when HEAD resolves to a commit. A freshly `git init`-ed repo (unborn HEAD)
// has no history yet, so `git log` would error rather than return empty; callers
// short-circuit to `[]` instead.
function hasHead(repoRoot) {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function idRegex(cfg) {
  return new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);
}

// Resolve an id to its current file by probing the three status dirs, newest status
// last (active wins a hypothetical duplicate, which the generator flags separately).
// Validates the id format BEFORE building any path, so a crafted id (e.g.
// "../../etc/passwd") cannot escape the task tree. Returns { id, status, file } or null.
export function resolveTaskFile(repoRoot, cfg, id) {
  if (typeof id !== "string" || !idRegex(cfg).test(id.trim())) {
    throw new HistoryError(`invalid task id: ${id} (expected ${cfg.idPrefix} + ${cfg.idWidth} digits)`, "invalid_request");
  }
  const tid = id.trim();
  const p = paths(repoRoot, cfg);
  for (const [status, dir] of [["active", p.active], ["completed", p.completedTasks], ["removed", p.removed]]) {
    const file = join(dir, `${tid}.md`);
    if (existsSync(file)) return { id: tid, status, file };
  }
  return null;
}

// Every task id currently on disk, scanned straight from the three status dirs
// (not readBacklog) so history works as a forensic tool even on a backlog that
// doesn't fully validate. Sorted by id for a stable key order in history.json.
export function taskIds(repoRoot, cfg) {
  const p = paths(repoRoot, cfg);
  const fileRe = new RegExp(`^(${cfg.idPrefix}\\d{${cfg.idWidth}})\\.md$`);
  const out = [];
  for (const [status, dir] of [["active", p.active], ["completed", p.completedTasks], ["removed", p.removed]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(fileRe);
      if (m) out.push({ id: m[1], status, file: join(dir, f) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Parse the delimited `git log` output into entries. `reason` is the Trellis-Reason
// trailer when present, else the subject — so it is ALWAYS populated and a consumer
// reads one field. Each entry carries its own id, matching the structured-entry
// contract shared by the CLI and the MCP tool.
function parseLog(out, id) {
  return out
    .split(RECORD)
    .map((r) => r.trim()) // strip the inter-record newline git inserts between entries
    .filter(Boolean)
    .map((rec) => {
      const [commit = "", date = "", author = "", subject = "", reasonTrailer = ""] = rec.split(FIELD);
      const reason = reasonTrailer.trim() || subject.trim();
      return { id, commit: commit.trim(), date: date.trim(), author: author.trim(), subject: subject.trim(), reason };
    });
}

// `git log --follow` over one task file → entries newest-first. A path that was
// never committed (e.g. a brand-new, unstaged item) yields no output → `[]`.
function logFollow(repoRoot, id, relPath) {
  let out;
  try {
    out = git(repoRoot, ["log", "--follow", `--format=${FORMAT}`, "--", relPath]);
  } catch (e) {
    throw new HistoryError(`git log failed for ${relPath}: ${gitMsg(e)}`, "git_failed");
  }
  return parseLog(out, id);
}

// One task's history → { id, entries }, newest-first. Throws HistoryError for a
// non-git repo, an invalid id, or an unknown id.
export function deriveTaskHistory(repoRoot, cfg, id) {
  assertGitRepo(repoRoot);
  const resolved = resolveTaskFile(repoRoot, cfg, id);
  if (!resolved) throw new HistoryError(`no task file for id ${id}`, "not_found");
  const entries = hasHead(repoRoot) ? logFollow(repoRoot, resolved.id, relative(repoRoot, resolved.file)) : [];
  return { id: resolved.id, entries };
}

// Whole-repo history → { generated: true, tasks: { <id>: [entries…] } }, keyed by
// task id (every id on disk, `[]` if uncommitted). `generated: true` marks the file
// as a regenerable cache if it is ever committed despite being gitignored. One
// `git log --follow` per task file — `--follow` permits a single pathspec, so this
// cannot be one batched call; fine at backlog scale.
export function deriveAllHistory(repoRoot, cfg) {
  assertGitRepo(repoRoot);
  const head = hasHead(repoRoot);
  const tasks = {};
  for (const { id, file } of taskIds(repoRoot, cfg)) {
    tasks[id] = head ? logFollow(repoRoot, id, relative(repoRoot, file)) : [];
  }
  return { generated: true, tasks };
}

// The history.json bytes — pretty-printed with a trailing newline, matching the
// backlog.json serializer's style.
export function buildHistoryJson(repoRoot, cfg) {
  return JSON.stringify(deriveAllHistory(repoRoot, cfg), null, 2) + "\n";
}

// Materialize history.json to disk (the build-time / CI use). Writes to
// `<tasksDir>/history.json` by default, or `out` (repo-relative or absolute).
// Returns a small summary for the CLI to report.
export function materializeHistory(repoRoot, cfg, { out } = {}) {
  const content = buildHistoryJson(repoRoot, cfg);
  const target = out ? (isAbsolute(out) ? out : join(repoRoot, out)) : paths(repoRoot, cfg).historyJson;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  const parsed = JSON.parse(content);
  const taskCount = Object.keys(parsed.tasks).length;
  const entryCount = Object.values(parsed.tasks).reduce((n, e) => n + e.length, 0);
  return { path: relative(repoRoot, target), taskCount, entryCount, bytes: Buffer.byteLength(content) };
}
