// Behavior tests for the git-derived history deriver (src/history.mjs), run via
// `node --test`. Each test builds a throwaway git repo with controlled commit
// dates/authors, then drives the deriver directly. git is a hard dependency of the
// feature, so these tests assume it is on PATH (it is in CI). Commit dates are
// pinned via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE so date assertions are stable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/backlog.mjs";
import {
  resolveTaskFile,
  taskIds,
  deriveTaskHistory,
  deriveAllHistory,
  buildHistoryJson,
  materializeHistory,
  HistoryError,
} from "../src/history.mjs";
import { historyOp, TrellisError } from "../src/mcp.mjs";

const CFG = { specVersion: "2.2", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3, 5, 8, 13, 21] };

// Isolated git invocation: no global/system config so the host's settings can't
// change behavior; user identity + signing are set locally per repo.
function git(root, args, extraEnv = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  });
}

function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

// Stage everything and commit with a pinned date and author. `messages` is one or
// more paragraphs; a trailing "Trellis-Reason: …" paragraph is picked up by git's
// trailer parser (and thus by the deriver's reason field).
function commit(root, date, author, ...messages) {
  git(root, ["add", "-A"]);
  const ms = messages.flatMap((m) => ["-m", m]);
  git(root, ["commit", "-q", "--author", author, ...ms], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

// A repo with a known shape:
//   DEMO0001 — created (Ada), revised with a Trellis-Reason trailer (Bob), then
//              `git mv`- d active → completed (Ada): 3 commits across the move.
//   DEMO0002 — a single commit in active/ (the squash-merge / import case).
//   DEMO0003 — present on disk in active/ but NEVER committed (→ empty history).
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "trellis-history-"));
  write(root, "trellis/backlog.config.json", JSON.stringify(CFG, null, 2) + "\n");
  mkdirSync(join(root, "trellis/active"), { recursive: true });
  mkdirSync(join(root, "trellis/completed/tasks"), { recursive: true });
  mkdirSync(join(root, "trellis/removed"), { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Committer"]);
  git(root, ["config", "user.email", "committer@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  // Initial commit that does NOT touch any task file, so --follow over a task file
  // never picks it up.
  write(root, "trellis/README.md", "# Backlog\n");
  commit(root, "2026-01-01T09:00:00-08:00", "Setup <setup@example.com>", "Bootstrap the backlog");

  write(root, "trellis/active/DEMO0001.md", "---\nid: DEMO0001\n---\n\nbody v1\n");
  commit(root, "2026-01-02T10:00:00-08:00", "Ada Lovelace <ada@example.com>", "DEMO0001: create the thing (#1)");

  write(root, "trellis/active/DEMO0001.md", "---\nid: DEMO0001\n---\n\nbody v2\n");
  commit(root, "2026-01-03T10:00:00-08:00", "Bob Stevens <bob@example.com>", "DEMO0001: revise scope", "Trellis-Reason: narrowed to the MVP per review");

  git(root, ["mv", "trellis/active/DEMO0001.md", "trellis/completed/tasks/DEMO0001.md"]);
  commit(root, "2026-01-04T10:00:00-08:00", "Ada Lovelace <ada@example.com>", "DEMO0001: ship it (#2)");

  write(root, "trellis/active/DEMO0002.md", "---\nid: DEMO0002\n---\n\nbody\n");
  commit(root, "2026-01-05T10:00:00-08:00", "Ada Lovelace <ada@example.com>", "DEMO0002: a single-commit task (#3)");

  // On disk, uncommitted.
  write(root, "trellis/active/DEMO0003.md", "---\nid: DEMO0003\n---\n\nuncommitted\n");
  return root;
}

function withRepo(fn) {
  const root = makeRepo();
  try {
    const { cfg } = loadConfig(root);
    return fn(root, cfg);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deriveTaskHistory follows a task across the active→completed move, newest-first", () => {
  withRepo((root, cfg) => {
    const { id, entries } = deriveTaskHistory(root, cfg, "DEMO0001");
    assert.equal(id, "DEMO0001");
    assert.equal(entries.length, 3, "--follow stitches the 3 commits across the git mv");
    assert.deepEqual(entries.map((e) => e.subject), [
      "DEMO0001: ship it (#2)",
      "DEMO0001: revise scope",
      "DEMO0001: create the thing (#1)",
    ]);
    // Newest-first by author date.
    assert.deepEqual(entries.map((e) => e.date.slice(0, 10)), ["2026-01-04", "2026-01-03", "2026-01-02"]);
    assert.deepEqual(entries.map((e) => e.author), ["Ada Lovelace", "Bob Stevens", "Ada Lovelace"]);
    for (const e of entries) {
      assert.equal(e.id, "DEMO0001");
      assert.match(e.commit, /^[0-9a-f]{40}$/, "commit is the full 40-char SHA");
      assert.match(e.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "date is full ISO 8601");
    }
  });
});

test("reason is the Trellis-Reason trailer when present, else the subject", () => {
  withRepo((root, cfg) => {
    const { entries } = deriveTaskHistory(root, cfg, "DEMO0001");
    const bySubject = Object.fromEntries(entries.map((e) => [e.subject, e.reason]));
    assert.equal(bySubject["DEMO0001: revise scope"], "narrowed to the MVP per review", "trailer wins");
    assert.equal(bySubject["DEMO0001: ship it (#2)"], "DEMO0001: ship it (#2)", "falls back to subject");
    assert.equal(bySubject["DEMO0001: create the thing (#1)"], "DEMO0001: create the thing (#1)");
  });
});

test("a single-commit task yields one entry (the squash-merge / import case)", () => {
  withRepo((root, cfg) => {
    const { entries } = deriveTaskHistory(root, cfg, "DEMO0002");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].subject, "DEMO0002: a single-commit task (#3)");
  });
});

test("an uncommitted task file has empty history, not an error", () => {
  withRepo((root, cfg) => {
    assert.deepEqual(deriveTaskHistory(root, cfg, "DEMO0003").entries, []);
  });
});

test("resolveTaskFile probes the three status dirs and validates the id", () => {
  withRepo((root, cfg) => {
    assert.equal(resolveTaskFile(root, cfg, "DEMO0001").status, "completed");
    assert.equal(resolveTaskFile(root, cfg, "DEMO0002").status, "active");
    assert.equal(resolveTaskFile(root, cfg, "DEMO9999"), null, "unknown id → null");
    assert.throws(() => resolveTaskFile(root, cfg, "../active/DEMO0001"), HistoryError, "a non-id is rejected before pathing");
  });
});

test("taskIds scans every status dir, sorted by id", () => {
  withRepo((root, cfg) => {
    assert.deepEqual(taskIds(root, cfg).map((t) => t.id), ["DEMO0001", "DEMO0002", "DEMO0003"]);
  });
});

test("deriveAllHistory / buildHistoryJson keys by id and marks the file generated", () => {
  withRepo((root, cfg) => {
    const all = deriveAllHistory(root, cfg);
    assert.equal(all.generated, true);
    assert.deepEqual(Object.keys(all.tasks), ["DEMO0001", "DEMO0002", "DEMO0003"], "all ids present, sorted");
    assert.equal(all.tasks.DEMO0001.length, 3);
    assert.equal(all.tasks.DEMO0002.length, 1);
    assert.deepEqual(all.tasks.DEMO0003, [], "uncommitted → empty array");

    const json = buildHistoryJson(root, cfg);
    assert.ok(json.endsWith("\n"), "trailing newline like backlog.json");
    assert.deepEqual(JSON.parse(json), all, "round-trips");
  });
});

test("materializeHistory writes history.json to the backlog root by default", () => {
  withRepo((root, cfg) => {
    const res = materializeHistory(root, cfg);
    assert.equal(res.path, join("trellis", "history.json"));
    assert.equal(res.taskCount, 3);
    assert.equal(res.entryCount, 4, "3 + 1 + 0");
    const onDisk = JSON.parse(readFileSync(join(root, "trellis", "history.json"), "utf8"));
    assert.equal(onDisk.tasks.DEMO0001[0].subject, "DEMO0001: ship it (#2)");
  });
});

test("materializeHistory honours an explicit --out path", () => {
  withRepo((root, cfg) => {
    const res = materializeHistory(root, cfg, { out: "build/history.json" });
    assert.equal(res.path, join("build", "history.json"));
    assert.ok(existsSync(join(root, "build", "history.json")));
  });
});

test("a regex-metacharacter id prefix (e.g. T+) is matched literally, not as a pattern", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-prefix-"));
  try {
    const cfg = { specVersion: "2.2", idPrefix: "T+", idWidth: 3, milestones: ["Alpha"], priorities: ["High"], effort: [1] };
    write(root, "trellis/backlog.config.json", JSON.stringify(cfg, null, 2) + "\n");
    mkdirSync(join(root, "trellis/active"), { recursive: true });
    mkdirSync(join(root, "trellis/completed/tasks"), { recursive: true });
    mkdirSync(join(root, "trellis/removed"), { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Committer"]);
    git(root, ["config", "user.email", "c@example.com"]);
    write(root, "trellis/active/T+001.md", "---\nid: T+001\n---\n\nbody\n");
    // A decoy the UNescaped regex (`T+` = "one or more T") would wrongly accept.
    write(root, "trellis/active/T001.md", "---\nid: T001\n---\n\ndecoy\n");
    commit(root, "2026-02-01T10:00:00-08:00", "Ada <ada@example.com>", "T+001: create");

    const loaded = loadConfig(root).cfg;
    assert.deepEqual(taskIds(root, loaded).map((t) => t.id), ["T+001"], "only the literal-prefix file is a task; the decoy is ignored");
    assert.equal(resolveTaskFile(root, loaded, "T+001").status, "active");
    assert.throws(() => resolveTaskFile(root, loaded, "T001"), HistoryError, "an id that only the unescaped pattern would accept is rejected");
    assert.equal(deriveTaskHistory(root, loaded, "T+001").entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-git directory throws a typed HistoryError", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-nogit-"));
  try {
    write(root, "trellis/backlog.config.json", JSON.stringify(CFG, null, 2) + "\n");
    const { cfg } = loadConfig(root);
    assert.throws(() => deriveAllHistory(root, cfg), (e) => e instanceof HistoryError && e.code === "not_a_git_repo");
    assert.throws(() => deriveTaskHistory(root, cfg, "DEMO0001"), (e) => e instanceof HistoryError && e.code === "not_a_git_repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- CLI
// End-to-end smoke tests of the script wrapper, matching the precedent in
// import.test.mjs / init.test.mjs (spawn the script, assert stdout + exit code).
const historyScript = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "trellis-history.mjs");
function runCli(...args) {
  try {
    const stdout = execFileSync(process.execPath, [historyScript, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("CLI: <id> --json emits the structured entries", () => {
  withRepo((root) => {
    const { status, stdout } = runCli("DEMO0001", "--repo", root, "--json");
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.id, "DEMO0001");
    assert.equal(parsed.entries.length, 3);
  });
});

test("CLI: whole-repo human summary lists every task", () => {
  withRepo((root) => {
    const { status, stdout } = runCli("--repo", root);
    assert.equal(status, 0);
    assert.match(stdout, /3 tasks, 4 entries/);
    assert.match(stdout, /DEMO0003\s+\(no recorded history\)/);
  });
});

test("CLI: --write materializes history.json and reports it", () => {
  withRepo((root) => {
    const { status, stdout } = runCli("--repo", root, "--write");
    assert.equal(status, 0);
    assert.match(stdout, /Wrote .*history\.json/);
    assert.ok(existsSync(join(root, "trellis", "history.json")));
  });
});

test("CLI: --write with an id is refused (exit 2)", () => {
  withRepo((root) => {
    const { status, stderr } = runCli("DEMO0001", "--repo", root, "--write");
    assert.equal(status, 2);
    assert.match(stderr, /--write materializes the whole repo/);
  });
});

test("CLI: --write --json emits a structured result", () => {
  withRepo((root) => {
    const { status, stdout } = runCli("--repo", root, "--write", "--json");
    assert.equal(status, 0);
    const res = JSON.parse(stdout);
    assert.match(res.path, /history\.json$/);
    assert.equal(res.taskCount, 3);
    assert.equal(res.entryCount, 4);
  });
});

test("CLI: a value-taking flag with no value exits 2 instead of swallowing the next flag", () => {
  withRepo((root) => {
    // --out would otherwise consume --json as its path, silently disabling JSON.
    const swallowed = runCli("--repo", root, "--write", "--out", "--json");
    assert.equal(swallowed.status, 2);
    assert.match(swallowed.stderr, /--out requires a value/);
    // --repo at the end of argv has no value.
    const bareRepo = runCli("--repo");
    assert.equal(bareRepo.status, 2);
    assert.match(bareRepo.stderr, /--repo requires a value/);
    // The `=` form is the escape hatch for an unusual value.
    const ok = runCli(`--repo=${root}`, "DEMO0002", "--json");
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).entries.length, 1);
  });
});

test("CLI: an unknown id exits 1 with a clear error", () => {
  withRepo((root) => {
    const { status, stderr } = runCli("DEMO9999", "--repo", root);
    assert.equal(status, 1);
    assert.match(stderr, /no task file for id DEMO9999/);
  });
});

test("CLI: a non-git repo exits 1, not a stack trace", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-nogit-cli-"));
  try {
    write(root, "trellis/backlog.config.json", JSON.stringify(CFG, null, 2) + "\n");
    const { status, stderr } = runCli("--repo", root);
    assert.equal(status, 1);
    assert.match(stderr, /not a git work tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- MCP op
// The MCP `history` adapter (src/mcp.mjs) is exercised here, alongside the git
// fixture it needs (mcp.test.mjs scaffolds non-git repos).
test("MCP history: by id returns { id, entries }", () => {
  withRepo((root) => {
    const res = historyOp(root, { id: "DEMO0001" });
    assert.equal(res.id, "DEMO0001");
    assert.equal(res.entries.length, 3);
  });
});

test("MCP history: omitting id (or empty) returns the whole-repo shape", () => {
  withRepo((root) => {
    const all = historyOp(root, {});
    assert.equal(all.generated, true);
    assert.deepEqual(Object.keys(all.tasks), ["DEMO0001", "DEMO0002", "DEMO0003"]);
    // An empty-string id is treated as omitted, not as an invalid id.
    assert.deepEqual(historyOp(root, { id: "  " }), all);
  });
});

test("MCP history: an unknown id surfaces as a TrellisError (not_found)", () => {
  withRepo((root) => {
    assert.throws(() => historyOp(root, { id: "DEMO9999" }), (e) => e instanceof TrellisError && e.code === "not_found");
  });
});

test("MCP history: a non-git repo surfaces as a TrellisError", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-nogit-mcp-"));
  try {
    write(root, "trellis/backlog.config.json", JSON.stringify(CFG, null, 2) + "\n");
    assert.throws(() => historyOp(root, {}), (e) => e instanceof TrellisError && e.code === "not_a_git_repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
