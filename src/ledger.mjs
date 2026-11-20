// Trellis local id ledger (SPEC §3.1, TRL0037).
//
// Hands out each task id exactly once across every worktree of one clone. The
// ledger is a git ref (default refs/trellis/ids) whose tip tree holds one file,
// claims.tsv. A claim appends a line in a new commit and moves the ref with a
// compare-and-swap, so concurrent claims retry instead of colliding. Only git
// plumbing and Node built-ins are used, and nothing is pushed.
//
// Like src/history.mjs, this is kept out of the core (src/backlog.mjs) so that
// `check` never depends on git or on local state (SPEC §8.3).

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_LEDGER_REF, DEFAULT_TASKS_DIR, PLAIN_PREFIX_RE, branchNameProblem, parseFrontMatter, paths } from "./backlog.mjs";

// A typed failure the CLI maps to an exit code and the MCP adapter maps to a
// TrellisError. Exit 2 is "refused, nothing written"; exit 1 is a real failure
// (retries ran out, git refused the write).
export class LedgerError extends Error {
  constructor(message, code = "git_failed", exitCode = 1) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
const refuse = (message, code) => new LedgerError(message, code, 2);

// A worktree can vanish between listing and resolving, so a filesystem error here is a layout refusal, not a crash.
function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch (e) {
    throw refuse(`cannot resolve ${p}: ${e.message}`, "unsupported_layout");
  }
}

// Test seam: runs for each worktree after git located its checkout and before its path is resolved.
export const testSeams = { beforeResolve: null };

export const MAX_CLAIM_ATTEMPTS = 10;
export const MIN_GIT_VERSION = "2.45.1";
// 2.45.1 is the first release that has `rev-parse --show-ref-format` and honors
// GIT_NO_LAZY_FETCH. 2.45.0 is below the floor, so the exclusion is moot but kept.
const EXCLUDED_GIT_VERSIONS = ["2.45.0"];
// The reader buffers a whole git output; a ledger above this could not be read back.
export const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
const LEDGER_FILE = "claims.tsv";
const HEADER = "id\tdate\tkind\tbranch\ttitle";
const KINDS = new Set(["seed", "claim", "through"]);
const STATUS_FOLDERS = [["active"], ["completed", "tasks"], ["removed"]];
const SEED_HINT = "run `trellis claim --seed` to create it";
const RECOVERY_HINT =
  "If the ledger was deleted, re-seed with `--through <ID>` set to a confirmed upper bound on every id ever allocated, claims and reservations alike";

// ------------------------------------------------------------ git helper
// Variables that would point git at a different repo, index, object store,
// config or pathspec mode than the `-C` directory we pass.
const CLEARED_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
  "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
];

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (CLEARED_ENV.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  }
  // A replacement object could show a lower high-water mark than the real tree;
  // a missing local object must fail instead of triggering a network fetch.
  return { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

const NO_HOOKS = process.platform === "win32" ? "NUL" : "/dev/null";

function runGit(args, { cwd, input, env, raw = false } = {}) {
  // No fsmonitor (it would run a configured command on index reads) and no hooks
  // (ledger ref updates must not run reference-transaction hooks).
  const full = ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NO_HOOKS}`, ...(cwd ? ["-C", cwd] : []), ...args];
  const r = spawnSync("git", full, {
    encoding: raw ? "buffer" : "utf8",
    input,
    env: gitEnv(env),
    maxBuffer: MAX_LEDGER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) {
    if (r.error.code === "ENOENT") throw refuse("git is not available on PATH", "git_unavailable");
    throw new LedgerError(`git ${args.join(" ")} failed: ${r.error.message}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const firstLine = (s) => String(s || "").trim().split("\n")[0] || "git error";

// Run git and require one of `ok` exit codes; the error names the command.
function git(cwd, args, { ok = [0], input, env, raw } = {}) {
  const r = runGit(args, { cwd, input, env, raw });
  if (!ok.includes(r.status)) {
    throw new LedgerError(`git ${args.join(" ")} failed: ${firstLine(r.stderr)}`);
  }
  return r;
}

// Commits need an identity. A fresh clone or cloud session may have none, so fall
// back to a fixed one only when git cannot resolve its own.
function identityEnv(cwd) {
  const has = (v) => runGit(["var", v], { cwd }).status === 0;
  if (has("GIT_AUTHOR_IDENT") && has("GIT_COMMITTER_IDENT")) return {};
  return {
    GIT_AUTHOR_NAME: "trellis", GIT_AUTHOR_EMAIL: "trellis@localhost",
    GIT_COMMITTER_NAME: "trellis", GIT_COMMITTER_EMAIL: "trellis@localhost",
  };
}

// ----------------------------------------------------------- capability
function parseVersion(text) {
  const m = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// True when `versionText` (the output of `git --version`) is at least `min`.
export function gitVersionSupported(versionText, min = MIN_GIT_VERSION) {
  const have = parseVersion(versionText);
  const need = parseVersion(min);
  if (!have) return false;
  if (EXCLUDED_GIT_VERSIONS.includes(have.join("."))) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

// Refuses (exit 2) when git is missing, too old, the directory is not a work tree,
// or the ref format is not `files` (reftable is out of scope).
export function probeGit(repoRoot) {
  const v = runGit(["--version"]);
  if (v.status !== 0 || !gitVersionSupported(v.stdout)) {
    throw refuse(`the id ledger needs git ${MIN_GIT_VERSION} or later (found: ${firstLine(v.stdout || v.stderr)})`, "unsupported_git");
  }
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw refuse(`not a git work tree: ${repoRoot}`, "not_a_git_repo");
  }
  const fmt = runGit(["rev-parse", "--show-ref-format"], { cwd: repoRoot });
  if (fmt.status !== 0 || fmt.stdout.trim() !== "files") {
    throw refuse("the id ledger needs the `files` ref format (reftable is not supported)", "unsupported_git");
  }
}

// ------------------------------------------------------------- id helpers
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refOf = (cfg) => cfg.idLedgerRef || DEFAULT_LEDGER_REF;
// Split the way paths() joins it, so a backslash stays a filename character on
// POSIX. `.` segments are dropped so "./trellis" matches the paths git reports.
const tasksParts = (cfg) => join(".", cfg.tasksDir || DEFAULT_TASKS_DIR).split(sep).filter((p) => p && p !== ".");
const idNumber = (id, cfg) => Number(id.slice(cfg.idPrefix.length));

// Matches a whole id. The prefix is escaped, so a scan config such as `R+` matches
// `R+0001` and not `RR0001`.
export function ledgerIdMatcher(cfg) {
  return new RegExp(`^${escapeRe(cfg.idPrefix)}\\d{${cfg.idWidth}}$`);
}
const fileMatcher = (cfg, flags = "") => new RegExp(`^(${escapeRe(cfg.idPrefix)}\\d{${cfg.idWidth}})\\.md$`, flags);

// Every operation that writes ledger rows needs a prefix that cannot break a line.
function requirePlainPrefix(cfg) {
  if (typeof cfg.idPrefix !== "string" || !PLAIN_PREFIX_RE.test(cfg.idPrefix)) {
    throw refuse("the id ledger needs an `idPrefix` of letters and digits that starts with a letter", "invalid_request");
  }
  if (!Number.isInteger(cfg.idWidth) || cfg.idWidth < 1 || cfg.idWidth > 9) {
    throw refuse("the id ledger needs an `idWidth` between 1 and 9", "invalid_request");
  }
}

function requireLedgerMode(cfg) {
  if (cfg.idAllocation !== "ledger") {
    throw refuse('`idAllocation` is not "ledger" in backlog.config.json; set it to claim ids from the ledger', "invalid_request");
  }
}

// Control characters plus the Unicode line and paragraph separators (U+2028, U+2029).
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;
export const unsafeText = (value) => UNSAFE_TEXT.test(value);
// Every claim rewrites the whole claims.tsv, so titles are kept short.
export const MAX_TITLE_LENGTH = 200;

// Titles are one line with no tabs or control characters, so they cannot forge a row.
export function ledgerTitle(value) {
  if (typeof value !== "string" || !value.trim()) throw refuse("`title` is required", "invalid_request");
  if (unsafeText(value)) throw refuse("`title` must be a single line with no tabs or control characters", "invalid_request");
  const t = value.trim();
  if (t.length > MAX_TITLE_LENGTH) throw refuse(`\`title\` must be at most ${MAX_TITLE_LENGTH} characters`, "invalid_request");
  return t;
}

// Titles read from item files are cleaned instead of refused.
function cleanTitle(value) {
  const t = String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  return t || "-";
}

function checkThrough(id, cfg) {
  if (typeof id !== "string" || !ledgerIdMatcher(cfg).test(id)) {
    throw refuse(`\`--through\` must be an id like ${cfg.idPrefix}${"0".repeat(Math.max(cfg.idWidth - 1, 0))}1 (${cfg.idPrefix} + ${cfg.idWidth} digits)`, "invalid_request");
  }
  return id;
}

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------ read ledger
// An out-of-range date such as 2026-13-45 is an Invalid Date, which toISOString rejects.
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function parseClaims(text, cfg) {
  if (!text.endsWith("\n")) return { reason: "claims.tsv does not end with a newline" };
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== HEADER) return { reason: "claims.tsv has a wrong header line" };
  const idRe = ledgerIdMatcher(cfg);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("\t");
    const at = `claims.tsv line ${i + 1}`;
    if (f.length !== 5) return { reason: `${at} does not have five fields` };
    const [id, date, kind, branch, title] = f;
    if (!idRe.test(id)) return { reason: `${at} has an id that does not match ${cfg.idPrefix} + ${cfg.idWidth} digits` };
    if (!validDate(date)) {
      return { reason: `${at} has a bad date` };
    }
    if (!KINDS.has(kind)) return { reason: `${at} has an unknown kind` };
    if (!branch || !title || unsafeText(branch) || unsafeText(title)) return { reason: `${at} has an empty or unsafe branch or title` };
    // A real branch name must be one git accepts; `-` stands for no branch.
    if (branch !== "-" && branchNameProblem(branch)) return { reason: `${at} has a branch that is not a valid git branch name` };
    if (kind === "through" && branch !== "-") return { reason: `${at} is a through row with a branch` };
    rows.push({ id, date, kind, branch, title });
  }
  return { rows, text };
}

// Reads the ledger tip once and validates all of it. Returns one of
// `{missing: true}`, `{unusable: <reason>}` or `{tip, rows, text}`. It throws only
// when git itself cannot be used (missing, too old, not a repo).
// The layout refusals are NOT applied here, so a viewer can still list claims.
export function readLedger(repoRoot, cfg) {
  probeGit(repoRoot);
  const ref = refOf(cfg);
  if (runGit(["symbolic-ref", "-q", ref], { cwd: repoRoot }).status === 0) {
    return { unusable: `${ref} is a symbolic ref` };
  }
  // Confirm absence before the exact lookup, so a ref published in between reads
  // as present and never as broken.
  const exists = runGit(["show-ref", "--exists", ref], { cwd: repoRoot });
  if (exists.status === 2) return { missing: true };
  // Exit 1 means git rejects the ref itself (malformed), which is a broken ledger.
  if (exists.status === 1) return { unusable: `${ref} is not a valid ref: ${firstLine(exists.stderr)}` };
  if (exists.status !== 0) throw new LedgerError(`git show-ref --exists ${ref} failed: ${firstLine(exists.stderr)}`);
  const sha = runGit(["show-ref", "--verify", "--hash", ref], { cwd: repoRoot });
  const tip = sha.stdout.trim();
  if (sha.status !== 0 || !tip) return { unusable: `${ref} cannot be read` };
  const type = runGit(["cat-file", "-t", tip], { cwd: repoRoot });
  if (type.status !== 0) return { unusable: `${ref} points at a missing local object` };
  if (type.stdout.trim() !== "commit") return { unusable: `${ref} does not point at a commit` };
  const tree = runGit(["ls-tree", "--full-tree", "-z", tip], { cwd: repoRoot });
  if (tree.status !== 0) return { unusable: `the tree of ${ref} cannot be read` };
  const entries = tree.stdout.split("\0").filter(Boolean);
  const m = entries.length === 1 && entries[0].match(/^100644 blob ([0-9a-f]+)\t(.+)$/);
  if (!m || m[2] !== LEDGER_FILE) return { unusable: `the tip of ${ref} does not hold exactly one ${LEDGER_FILE}` };
  const size = runGit(["cat-file", "-s", m[1]], { cwd: repoRoot });
  if (size.status !== 0) return { unusable: `${LEDGER_FILE} cannot be read` };
  if (Number(size.stdout) >= MAX_LEDGER_BYTES) return { unusable: `${LEDGER_FILE} is too large to read` };
  const blob = runGit(["cat-file", "blob", m[1]], { cwd: repoRoot, raw: true });
  if (blob.status !== 0) return { unusable: `${LEDGER_FILE} cannot be read` };
  let text;
  try {
    text = strictUtf8.decode(blob.stdout);
  } catch {
    return { unusable: `${LEDGER_FILE} is not valid UTF-8` };
  }
  const parsed = parseClaims(text, cfg);
  if (parsed.reason) return { unusable: parsed.reason };
  return { tip, rows: parsed.rows, text: parsed.text };
}

// Same as readLedger, but turns the two bad outcomes into refusals.
function requireLedger(repoRoot, cfg) {
  const ledger = readLedger(repoRoot, cfg);
  if (ledger.missing) {
    throw refuse(`no id ledger at ${refOf(cfg)}; ${SEED_HINT}. ${RECOVERY_HINT}.`, "missing_ledger");
  }
  if (ledger.unusable) throw refuse(`the id ledger at ${refOf(cfg)} is not usable: ${ledger.unusable}`, "invalid_ledger");
  return ledger;
}

// ------------------------------------------------------------- worktrees
// Git paths and ref names are bytes. A name that is not valid UTF-8 cannot be
// carried through a JavaScript string and back to git, so allocation refuses it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeGit(buf, what) {
  try {
    return strictUtf8.decode(buf);
  } catch {
    throw refuse(`${what} is not valid UTF-8; the id ledger does not support it`, "unsupported_layout");
  }
}

const HEADS = "refs/heads/";
const stripHeads = (ref) => (ref.startsWith(HEADS) ? ref.slice(HEADS.length) : "-");

// `git worktree list` silently drops a registration it cannot read, which could hide
// a reserved id. So the registry and each gitdir file must be readable first.
function checkWorktreeRegistry(repoRoot) {
  const r = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot });
  if (r.status !== 0) return;
  const dir = join(r.stdout.replace(/\n$/, ""), "worktrees");
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
    throw refuse(`cannot read ${dir}: ${e.message}; the id ledger cannot list every worktree`, "unsupported_layout");
  }
  for (const name of names) {
    const file = join(dir, name, "gitdir");
    // Only registration directories count; a stray file is not one.
    try {
      if (!lstatSync(join(dir, name)).isDirectory()) continue;
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw refuse(`cannot read ${join(dir, name)}: ${e.message}; the id ledger cannot list every worktree`, "unsupported_layout");
    }
    // A registration that exists needs a non-empty gitdir file, or `git worktree
    // list` would drop it and could hide a reserved id.
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw refuse(`cannot read ${file}: ${e.message}; the id ledger cannot list every worktree`, "unsupported_layout");
    }
    if (!text.trim()) throw refuse(`${file} is empty; the id ledger cannot list every worktree`, "unsupported_layout");
  }
}

// Every worktree of the clone that can be read. Prunable and missing ones are
// skipped so a stale lane cannot block a claim; one that cannot be inspected
// (permissions) refuses, since dropping it could hide a reserved id.
function listWorktrees(repoRoot) {
  checkWorktreeRegistry(repoRoot);
  const out = git(repoRoot, ["worktree", "list", "--porcelain", "-z"], { raw: true }).stdout;
  const list = [];
  let cur = null;
  let start = 0;
  const fields = [];
  for (let i = 0; i <= out.length; i++) {
    if (i === out.length || out[i] === 0) { fields.push(decodeGit(out.subarray(start, i), "a worktree path or branch name")); start = i + 1; }
  }
  for (const field of fields) {
    if (field === "") { cur = null; continue; }
    if (field.startsWith("worktree ")) {
      cur = { path: field.slice("worktree ".length), branch: "-", bare: false, prunable: false };
      list.push(cur);
    } else if (cur) {
      if (field.startsWith("branch ")) cur.branch = stripHeads(field.slice("branch ".length));
      else if (field === "bare") cur.bare = true;
      else if (field === "prunable" || field.startsWith("prunable ")) cur.prunable = true;
    }
  }
  const kept = [];
  for (const w of list) {
    if (w.bare) continue;
    // Git also marks a worktree prunable when it cannot reach it, so a listed path
    // is skipped only when lstat says it is gone; a prunable one that still exists
    // is kept, and the later checks refuse it if it cannot be read.
    try {
      lstatSync(w.path);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw refuse(`cannot inspect the worktree ${w.path}: ${e.message}`, "unsupported_layout");
    }
    kept.push(w);
  }
  return kept;
}

// Every listed checkout must be its own work tree root, and the served root must be
// one of them. With a separate git dir, git can list the metadata directory as the
// primary worktree, and then the real checkout would never be scanned.
function verifyWorktrees(repoRoot, worktrees) {
  const real = new Set();
  const common = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot });
  const commonDir = common.status === 0 ? realPath(common.stdout.replace(/\n$/, "")) : "";
  const regs = registrations(commonDir);
  const taken = new Set();
  for (const w of worktrees) {
    const top = runGit(["rev-parse", "--show-toplevel"], { cwd: w.path });
    const topPath = top.stdout.replace(/\n$/, "");
    if (testSeams.beforeResolve) testSeams.beforeResolve(w);
    if (top.status !== 0 || !topPath || realPath(topPath) !== realPath(w.path)) {
      throw refuse(`cannot locate the checkout of the listed worktree ${w.path}; the id ledger does not support this layout (a separate git dir, for one)`, "unsupported_layout");
    }
    // A checkout moved by hand leaves its registration pointing at the old path, where
    // another clone may now sit. The checkout must resolve to the git dir registered for it.
    const actual = runGit(["rev-parse", "--absolute-git-dir"], { cwd: w.path });
    const actualDir = actual.status === 0 ? realPath(actual.stdout.replace(/\n$/, "")) : "";
    // One-to-one: a checkout matches exactly one registration (the main one has none,
    // so it maps to the common dir), and no registration serves two checkouts.
    const want = realPath(w.path);
    const hits = regs.filter((r) => r.checkout === want);
    const expected = hits.length === 0 ? commonDir : hits.length === 1 ? hits[0].gitDir : "";
    if (!commonDir || !actualDir || !expected || taken.has(expected) || actualDir !== expected) {
      throw refuse(`the checkout at ${w.path} is not the one git registered for it (moved by hand?); the id ledger does not support this layout`, "unsupported_layout");
    }
    taken.add(expected);
    real.add(want);
  }
  if (!real.has(realPath(repoRoot))) {
    throw refuse(`${repoRoot} is not in the worktree list of its clone; the id ledger does not support this layout`, "unsupported_layout");
  }
}

// Every linked-worktree registration: its metadata dir and the checkout its `gitdir`
// file names. The target may be relative to the registration dir (`worktree add
// --relative-paths`). An unreadable entry cannot match, so it is left out.
function registrations(commonDir) {
  if (!commonDir) return [];
  const dir = join(commonDir, "worktrees");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch { /* no linked worktrees */ }
  const out = [];
  for (const name of names) {
    try {
      const target = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
      if (!target) continue;
      out.push({ gitDir: realPath(join(dir, name)), checkout: realPath(dirname(resolve(join(dir, name), target))) });
    } catch { /* an unreadable entry cannot be the match */ }
  }
  return out;
}

// Reads the full symbolic ref and strips refs/heads/ itself: `--short` would print
// `heads/main` when a tag shares the branch name.
function branchOf(repoRoot) {
  const r = runGit(["symbolic-ref", "-q", "HEAD"], { cwd: repoRoot, raw: true });
  if (r.status !== 0) return "-";
  const name = stripHeads(decodeGit(r.stdout, "the branch name").replace(/\n$/, ""));
  if (name !== "-" && (unsafeText(name) || branchNameProblem(name))) throw refuse("the current branch name is not one the id ledger can record (control or line-separator character, or not a valid git branch name)", "invalid_request");
  return name || "-";
}

// ------------------------------------------------------------------ scan
// Walks a worktree's path to each status folder. A symlinked component, or one
// whose on-disk case differs from the config, is unsafe: the disk and index paths
// could then name different files. An absent component is fine (a clean clone has
// no completed/tasks yet). Returns the status folders that exist as directories.
function existingStatusDirs(worktree, cfg) {
  try {
    return walkStatusDirs(worktree, cfg);
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError(`cannot read the task folders of ${worktree}: ${e.message}`, "unsupported_layout", 2);
  }
}

function walkStatusDirs(worktree, cfg) {
  const base = realPath(worktree);
  const dirs = [];
  for (const status of STATUS_FOLDERS) {
    let cur = worktree;
    let want = base;
    let present = true;
    for (const part of [...tasksParts(cfg), ...status]) {
      cur = join(cur, part);
      want = join(want, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch (e) {
        if (e.code === "ENOENT") { present = false; break; }
        throw new LedgerError(`cannot read ${cur}: ${e.message}`, "unsupported_layout", 2);
      }
      if (st.isSymbolicLink()) throw refuse(`${cur} is a symlink; the id ledger does not support symlinked task folders`, "unsupported_layout");
      if (realPath(cur) !== want) throw refuse(`${cur} differs from its on-disk path (case or symlink); the id ledger does not support it`, "unsupported_layout");
    }
    if (present && lstatSync(cur).isDirectory()) dirs.push({ dir: cur, status });
  }
  return dirs;
}

// Splits repo-relative paths into exact status-folder ids and case aliases.
function pickIds(paths, cfg) {
  const ids = new Set();
  const aliases = [];
  const exactRe = fileMatcher(cfg);
  const looseRe = fileMatcher(cfg, "i");
  const prefixes = STATUS_FOLDERS.map((s) => [...tasksParts(cfg), ...s].join("/"));
  for (const p of paths) {
    const lower = p.toLowerCase();
    for (const prefix of prefixes) {
      if (!lower.startsWith(prefix.toLowerCase() + "/")) continue;
      const name = p.slice(prefix.length + 1);
      if (name.includes("/")) continue;
      if (p.startsWith(prefix + "/")) {
        const m = name.match(exactRe);
        if (m) ids.add(m[1]);
      } else if (looseRe.test(name)) {
        aliases.push(p);
      }
    }
  }
  return { ids, aliases };
}

// The commit HEAD resolves to, or null when the branch is unborn. HEAD is resolved
// exactly: revision lookup by the name HEAD could pick up a tag called HEAD.
function headCommit(worktree) {
  const sym = runGit(["symbolic-ref", "-q", "HEAD"], { cwd: worktree, raw: true });
  let ref = "HEAD";
  if (sym.status === 0) {
    ref = decodeGit(sym.stdout, "the branch name").replace(/\n$/, "");
    if (git(worktree, ["show-ref", "--exists", ref], { ok: [0, 2] }).status === 2) return null;
  } else if (sym.status !== 1) {
    throw new LedgerError(`git symbolic-ref -q HEAD failed: ${firstLine(String(sym.stderr))}`);
  }
  return git(worktree, ["show-ref", "--verify", "--hash", ref]).stdout.trim();
}

// Every id a worktree holds, from the disk, the index and the checked-out HEAD,
// unfiltered (no pathspec) so a case alias is seen. Does not validate items.
// `skipWorktree` is the index subset marked skip-worktree. `aliases` lists paths
// that sit under a status folder only when case is ignored; the allocator refuses.
export function scanIds(worktree, cfg) {
  const disk = new Set();
  const fileRe = fileMatcher(cfg);
  for (const { dir } of existingStatusDirs(worktree, cfg)) {
    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      throw new LedgerError(`cannot read ${dir}: ${e.message}`, "unsupported_layout", 2);
    }
    for (const name of names) {
      const m = name.match(fileRe);
      if (m) disk.add(m[1]);
    }
  }

  const listing = git(worktree, ["ls-files", "-t", "-z"]).stdout.split("\0").filter(Boolean);
  const indexPaths = listing.map((e) => e.slice(2));
  const skipPaths = listing.filter((e) => e[0] === "S").map((e) => e.slice(2));
  const index = pickIds(indexPaths, cfg);
  const skip = pickIds(skipPaths, cfg);

  const oid = headCommit(worktree);
  const headPaths = oid ? git(worktree, ["ls-tree", "--full-tree", "-r", "--name-only", "-z", oid]).stdout.split("\0").filter(Boolean) : [];
  const head = pickIds(headPaths, cfg);

  return {
    disk,
    index: index.ids,
    skipWorktree: skip.ids,
    head: head.ids,
    aliases: [...new Set([...index.aliases, ...head.aliases])],
  };
}

function sparseCheckoutOn(worktree) {
  const r = runGit(["config", "--type=bool", "--get", "core.sparseCheckout"], { cwd: worktree });
  return r.status === 0 && r.stdout.trim() === "true";
}

// The refusals for layouts the scan cannot read faithfully. Applied by every
// operation that allocates, and by preview. Returns each worktree with its scan.
function scanClone(repoRoot, cfg) {
  const top = runGit(["rev-parse", "--show-toplevel"], { cwd: repoRoot }).stdout.replace(/\n$/, "");
  if (!top || realPath(repoRoot) !== realPath(top)) {
    throw refuse(`${repoRoot} is not the root of its worktree (${top || "unknown"}); serve the worktree root`, "unsupported_layout");
  }
  const worktrees = listWorktrees(repoRoot);
  verifyWorktrees(repoRoot, worktrees);
  const result = [];
  for (const wt of worktrees) {
    if (sparseCheckoutOn(wt.path)) {
      throw refuse(`the worktree ${wt.path} uses sparse checkout; the id ledger does not support it`, "unsupported_layout");
    }
    const scan = scanIds(wt.path, cfg);
    if (scan.aliases.length) {
      throw refuse(`${scan.aliases[0]} matches a task folder only when case is ignored; the id ledger does not support it`, "unsupported_layout");
    }
    result.push({ ...wt, scan });
  }
  return result;
}

const allIds = (scan) => [...scan.disk, ...scan.index, ...scan.skipWorktree, ...scan.head];

// ------------------------------------------------------------------ next id
// max(highest id in the ledger or any worktree + 1, nextIdFloor), as SPEC §7's
// nextId rule. Refuses before the id would not fit idWidth.
function computeNext(cfg, ledgerRows, clone) {
  let max = 0;
  for (const r of ledgerRows) max = Math.max(max, idNumber(r.id, cfg));
  for (const wt of clone) for (const id of allIds(wt.scan)) max = Math.max(max, idNumber(id, cfg));
  const floor = Number.isInteger(cfg.nextIdFloor) && cfg.nextIdFloor > 0 ? cfg.nextIdFloor : 0;
  const n = Math.max(max + 1, floor);
  if (n > 10 ** cfg.idWidth - 1) {
    throw refuse(`id space exhausted: the next id would need more than ${cfg.idWidth} digits`, "exhausted");
  }
  return cfg.idPrefix + String(n).padStart(cfg.idWidth, "0");
}

// Ledger mode writes generated artifacts only as regular files. A symlink there,
// even a dangling one, could carry a write outside the checkout (into the ledger
// ref, for one), so every ledger-mode writer refuses before it claims or writes.
export function refuseSymlinkedArtifacts(artifactPaths) {
  for (const path of artifactPaths) {
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw refuse(`cannot inspect ${path}: ${e.message}`, "unsupported_layout");
    }
    if (st.isSymbolicLink()) {
      throw refuse(`${path} is a symlink; ledger mode does not write through symlinked generated files. Replace it with a regular file`, "invalid_request");
    }
    // A FIFO would block the read, and a directory cannot be replaced.
    if (!st.isFile()) throw refuse(`${path} is not a regular file; ledger mode only writes regular generated files`, "invalid_request");
  }
}

// The four generated artifacts of a config, per `paths()`.
export function artifactPaths(repoRoot, cfg) {
  const p = paths(repoRoot, cfg);
  return [p.readme, p.completedIndex, p.removedIndex, p.backlogJson];
}

// Throws the layout refusals without allocating, so a caller can fail before it
// reads the task tree or writes anything (MCP `create_task`).
export function checkLayout(repoRoot, cfg) {
  requireLedgerMode(cfg);
  requirePlainPrefix(cfg);
  probeGit(repoRoot);
  scanClone(repoRoot, cfg);
}

// A read-only look at the next id, for `next_id`, `list_tasks`, `regenerate` and
// the `generate` note. Never throws for ledger problems: `nextId` is null and the
// note says why.
export function preview(repoRoot, cfg) {
  try {
    requirePlainPrefix(cfg);
    // A claim would refuse this branch, so the preview must not promise an id.
    branchOf(repoRoot);
    const ledger = readLedger(repoRoot, cfg);
    if (ledger.missing) {
      return { nextId: null, reason: "missing_ledger", note: `no id ledger at ${refOf(cfg)}; ${SEED_HINT}. ${RECOVERY_HINT}.` };
    }
    if (ledger.unusable) {
      return { nextId: null, reason: "invalid_ledger", note: `the id ledger at ${refOf(cfg)} is not usable: ${ledger.unusable}` };
    }
    const id = computeNext(cfg, ledger.rows, scanClone(repoRoot, cfg));
    return { nextId: id, reason: null, note: `claim ids with \`trellis claim\` (preview only: ${id})` };
  } catch (e) {
    if (e instanceof LedgerError) return { nextId: null, reason: e.code, note: e.message };
    throw e;
  }
}

// ----------------------------------------------------------------- writing
// Writes claims.tsv as a commit whose parent is `parent` (or none for a seed).
function commitLedger(repoRoot, text, parent, message, maxBytes = MAX_LEDGER_BYTES) {
  if (Buffer.byteLength(text) >= maxBytes) {
    throw refuse(`the id ledger would grow past ${maxBytes} bytes, which the reader cannot load; nothing was written`, "ledger_too_large");
  }
  const blob = git(repoRoot, ["hash-object", "-w", "--stdin"], { input: text }).stdout.trim();
  const tree = git(repoRoot, ["mktree"], { input: `100644 blob ${blob}\t${LEDGER_FILE}\n` }).stdout.trim();
  const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message];
  return git(repoRoot, args, { env: identityEnv(repoRoot) }).stdout.trim();
}

// Moves the ref from `old` to `next` in one compare-and-swap. `--no-deref` so a
// symbolic ref is never followed; reflogs are off by default outside refs/heads/.
function moveRef(repoRoot, ref, next, old, message) {
  return runGit(["update-ref", "--no-deref", "--create-reflog", "-m", message, ref, next, old], { cwd: repoRoot });
}

const rowText = (r) => `${r.id}\t${r.date}\t${r.kind}\t${r.branch}\t${r.title}\n`;

// Append one row with compare-and-swap and retry. `makeRow(ledger)` runs on every
// attempt, against the freshly read tip. `beforeUpdate` is a test seam that runs
// just before the swap, so a test can make a competing writer win.
function appendRow(repoRoot, cfg, makeRow, { beforeUpdate, message, maxBytes }) {
  const ref = refOf(cfg);
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
    const ledger = requireLedger(repoRoot, cfg);
    const row = makeRow(ledger);
    const next = commitLedger(repoRoot, ledger.text + rowText(row), ledger.tip, `${message} ${row.id}`, maxBytes);
    if (beforeUpdate) beforeUpdate({ attempt, ref });
    const r = moveRef(repoRoot, ref, next, ledger.tip, `${message} ${row.id}`);
    if (r.status === 0) return { row, tip: next, attempts: attempt };
    // A competing writer may have moved the tip, or may still hold <ref>.lock with the
    // tip unchanged; both are retried. Only a ledger that vanished or broke stops now.
    lastError = firstLine(r.stderr);
    const again = readLedger(repoRoot, cfg);
    if (!again.tip) throw new LedgerError(`git update-ref ${ref} failed: ${lastError}`);
  }
  throw new LedgerError(`could not update ${ref} after ${MAX_CLAIM_ATTEMPTS} attempts; other writers kept winning (last error: ${lastError})`, "conflict");
}

// Claims the next id. Returns `{id, tip, attempts}`.
export function claim(repoRoot, cfg, { title, beforeUpdate, maxBytes } = {}) {
  requireLedgerMode(cfg);
  requirePlainPrefix(cfg);
  const clean = ledgerTitle(title);
  const out = appendRow(repoRoot, cfg, (ledger) => ({
    id: computeNext(cfg, ledger.rows, scanClone(repoRoot, cfg)),
    date: today(),
    kind: "claim",
    branch: branchOf(repoRoot),
    title: clean,
  }), { beforeUpdate, message: "claim", maxBytes });
  return { id: out.row.id, tip: out.tip, attempts: out.attempts };
}

// Appends a high-water mark: every id up to and including `id` counts as taken.
export function through(repoRoot, cfg, id, { beforeUpdate, maxBytes } = {}) {
  requirePlainPrefix(cfg);
  checkThrough(id, cfg);
  const out = appendRow(repoRoot, cfg, () => {
    scanClone(repoRoot, cfg);
    return { id, date: today(), kind: "through", branch: "-", title: "-" };
  }, { beforeUpdate, message: "through", maxBytes });
  return { id, tip: out.tip, attempts: out.attempts };
}

// The title of an item file on a worktree's disk, or `-`. Only a regular,
// contained file is read: a FIFO would block and a symlink could leave the tree.
function seedTitle(worktree, cfg, id) {
  for (const { dir } of existingStatusDirs(worktree, cfg)) {
    const file = join(dir, `${id}.md`);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const fm = parseFrontMatter(readFileSync(file, "utf8"), file, []);
      return fm && typeof fm.title === "string" ? cleanTitle(fm.title) : "-";
    } catch {
      continue;
    }
  }
  return "-";
}

// Creates the ledger when it is absent: one `seed` row per id in any worktree, plus
// a `through` row when given. An existing ledger is left alone (`created: false`).
// Returns `{created, tip, through?, ignoredThrough?}`.
export function seed(repoRoot, cfg, { through: through_ } = {}) {
  requirePlainPrefix(cfg);
  if (through_ != null) checkThrough(through_, cfg);
  const ref = refOf(cfg);
  const existing = readLedger(repoRoot, cfg);
  if (existing.unusable) throw refuse(`the id ledger at ${ref} is not usable: ${existing.unusable}`, "invalid_ledger");
  if (existing.tip) return { created: false, tip: existing.tip, ignoredThrough: through_ != null };

  const clone = scanClone(repoRoot, cfg);
  const found = new Map();
  for (const wt of clone) {
    for (const id of new Set(allIds(wt.scan))) {
      if (!found.has(id)) found.set(id, wt);
    }
  }
  const date = today();
  const rows = [...found.keys()].sort().map((id) => {
    const wt = found.get(id);
    return { id, date, kind: "seed", branch: wt.branch !== "-" && (unsafeText(wt.branch) || branchNameProblem(wt.branch)) ? "-" : wt.branch, title: seedTitle(wt.path, cfg, id) };
  });
  if (through_ != null) rows.push({ id: through_, date, kind: "through", branch: "-", title: "-" });

  const commit = commitLedger(repoRoot, HEADER + "\n" + rows.map(rowText).join(""), null, "seed");
  // An all-zero old value means "must not exist yet", so two seeds cannot overwrite.
  const r = moveRef(repoRoot, ref, commit, "0".repeat(commit.length), "seed");
  if (r.status === 0) return { created: true, tip: commit, through: through_ ?? null, rows: rows.length };
  const again = readLedger(repoRoot, cfg);
  if (again.tip) return { created: false, tip: again.tip, ignoredThrough: through_ != null, raced: true };
  throw new LedgerError(`git update-ref ${ref} failed: ${firstLine(r.stderr)}`);
}

// The tip and every row, for `trellis claim --list`. Never allocates, so no layout
// refusals apply.
export function list(repoRoot, cfg) {
  const ledger = requireLedger(repoRoot, cfg);
  return { tip: ledger.tip, rows: ledger.rows };
}
