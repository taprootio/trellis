// Smoke/behavior tests for the MCP operations (zero-dependency, run via
// `node --test`). Scope is the tool contract in src/mcp.mjs — the transport-free
// core, driven directly; the SDK wiring in scripts/trellis-mcp.mjs is a thin
// adapter. The broader CLI/MCP matrix is TRL0011. Each test scaffolds a throwaway
// Trellis repo with the init scaffolder, then exercises the tools against it.

import { test } from "node:test";
import { ledgerTest, initRefFormat } from "./git-support.mjs";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, symlinkSync, renameSync, lstatSync, writeSync, realpathSync, chmodSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { loadProfile } from "../src/profiles.mjs";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";
import { registerTools } from "../scripts/trellis-mcp.mjs";
import {
  listTasks, getTask, nextIdOp, claimIdOp, createTask, moveTask, validateOp, regenerateOp, importOp, stageFile, TrellisError,
} from "../src/mcp.mjs";
import { seed, claim, through, list as ledgerList } from "../src/ledger.mjs";
import { testSeams as writerSeams } from "../src/local-output.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(sourceRoot, "test", "fixtures");
const yamlSrc = join(fixtures, "yaml-frontmatter");

// A fresh, --check-green Trellis repo to operate on.
function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), "trellis-mcp-"));
  applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
  return root;
}

// Assert every generated artifact on disk matches what the core would regenerate.
function assertCheckClean(root) {
  const { cfg } = loadConfig(root);
  const data = readBacklog(root, cfg);
  assert.deepEqual(data.errors, [], "backlog should read without errors");
  const { files } = generateArtifacts(root, cfg, data);
  const stale = files.filter((f) => (existsSync(f.path) ? readFileSync(f.path, "utf8") : "") !== f.content);
  assert.deepEqual(stale.map((f) => f.path), [], "no generated artifact should be stale");
}

const VALID = { title: "First task", summary: "Do the first thing.", milestone: "Alpha", priority: "High", effort: 3 };

// Seed a roster into a fresh repo so create_task/move_task can assign owners. A fresh
// scaffold has no active items, so adding team.json leaves the backlog --check-green.
function withRoster(root, members) {
  writeFileSync(join(root, "trellis", "team.json"), JSON.stringify({ members }, null, 2) + "\n");
  return root;
}
const TEAM = [{ handle: "alice", name: "Alice", status: "active" }, { handle: "bob", name: "Bob", status: "active" }];

test("next_id reports the first id on a fresh scaffold", () => {
  const root = freshRepo();
  try {
    assert.equal(nextIdOp(root).nextId, "DEMO0001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task writes a valid active item and stays --check-green", () => {
  const root = freshRepo();
  try {
    const { created } = createTask(root, VALID);
    assert.equal(created.id, "DEMO0001");
    assert.equal(created.status, "active");
    assert.equal(created.effort, 3);
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "the item file exists");
    assert.equal(nextIdOp(root).nextId, "DEMO0002", "next id advances");
    assert.ok(validateOp(root).ok, "the backlog validates");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered MCP tools honor per-call repoRoot", () => {
  const root = freshRepo();
  const handlers = {};
  const server = { registerTool: (name, _meta, handler) => { handlers[name] = handler; } };
  try {
    registerTools(server, join(tmpdir(), "not-the-target-repo"));
    const res = handlers.next_id({ repoRoot: root });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.nextId, "DEMO0001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Swap a fresh repo onto a custom (fish) effort scale so create_task exercises
// label resolution (SPEC §6.2). A fresh scaffold has no active items, so the
// config swap leaves the backlog --check-green.
function fishRepo() {
  const root = freshRepo();
  const cfgPath = join(root, "trellis", "backlog.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.effort = {
    values: [1, 2, 3, 5, 8, 13, 21],
    scale: "fish",
    scales: { fish: {
      1: { label: "Minnow" }, 2: { label: "Goldfish", emoji: "🐠" }, 3: { label: "Trout" },
      5: { label: "Tuna" }, 8: { label: "Swordfish" }, 13: { label: "Shark" }, 21: { label: "Whale" },
    } },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return root;
}

test("create_task resolves a scale label to its canonical number", () => {
  const root = fishRepo();
  try {
    const { created } = createTask(root, { ...VALID, effort: "trout" }); // case-insensitive
    assert.equal(created.effort, 3);
    assert.equal(created.effortLabel, "Trout");
    assert.match(readFileSync(join(root, "trellis/active/DEMO0001.md"), "utf8"), /^effort: 3$/m);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task still accepts a canonical number under a custom scale", () => {
  const root = fishRepo();
  try {
    assert.equal(createTask(root, { ...VALID, effort: 2 }).created.effortLabel, "Goldfish");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task rejects an effort that is neither a value nor a label", () => {
  const root = fishRepo();
  try {
    assert.throws(() => createTask(root, { ...VALID, effort: "Kraken" }), /effort must be a value/);
    assert.throws(() => createTask(root, { ...VALID, effort: true }), /must be a number or a scale label/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_task returns the entry plus the raw Markdown body", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    const t = getTask(root, { id: "DEMO0001" });
    assert.equal(t.title, "First task");
    assert.equal(t.file, "trellis/active/DEMO0001.md");
    assert.match(t.body, /## Scope/);
    assert.match(t.body, /## Risks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list_tasks filters by status and milestone", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.equal(listTasks(root).tasks.length, 1, "unfiltered lists the task");
    assert.equal(listTasks(root, { status: "active" }).tasks.length, 1);
    assert.equal(listTasks(root, { status: "completed" }).tasks.length, 0);
    assert.equal(listTasks(root, { milestone: "Alpha" }).tasks.length, 1);
    assert.equal(listTasks(root, { milestone: "Beta" }).tasks.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task rolls back when the result would not validate", () => {
  // A depends_on referencing a nonexistent id fails the core's referential check;
  // the half-written file must be removed and the backlog left clean.
  const root = freshRepo();
  try {
    assert.throws(
      () => createTask(root, { ...VALID, depends_on: ["DEMO9999"] }),
      (e) => e instanceof TrellisError && /DEMO9999/.test(e.message),
    );
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "no file is left behind");
    assert.ok(validateOp(root).ok, "the backlog is still valid");
    assert.equal(nextIdOp(root).nextId, "DEMO0001", "next id did not advance");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task completes an item: moves the file, sets completed_on, updates counts", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    const { moved, counts } = moveTask(root, { id: "DEMO0001", to: "completed", date: "2026-06-26" });
    assert.equal(moved.status, "completed");
    assert.equal(moved.completed_on, "2026-06-26");
    assert.equal(counts.active, 0);
    assert.equal(counts.completed, 1);
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "left active/");
    assert.ok(existsSync(join(root, "trellis/completed/tasks/DEMO0001.md")), "now in completed/tasks/");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task to removed without a reason is rejected and changes nothing", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.throws(() => moveTask(root, { id: "DEMO0001", to: "removed", date: "2026-06-26" }), /reason/);
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "the item stays active");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task on an unknown id throws not_found", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => moveTask(root, { id: "DEMO0404", to: "completed", date: "2026-06-26" }),
      (e) => e instanceof TrellisError && e.code === "not_found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task prepends the closeout note after the H1, before the body", () => {
  const root = freshRepo();
  try {
    createTask(root, { ...VALID, body: "# DEMO0001 — First task\n\n## Scope\n\n- ship it\n" });
    moveTask(root, { id: "DEMO0001", to: "completed", date: "2026-06-26", note: "Shipped the first thing." });
    const text = readFileSync(join(root, "trellis/completed/tasks/DEMO0001.md"), "utf8");
    assert.match(text, /## Completed\n\nShipped the first thing\./);
    assert.ok(text.indexOf("# DEMO0001") < text.indexOf("## Completed"), "note follows the H1");
    assert.ok(text.indexOf("## Completed") < text.indexOf("## Scope"), "note precedes the original body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate reports errors on a corrupted item", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.ok(validateOp(root).ok, "valid before tampering");
    writeFileSync(join(root, "trellis/active/DEMO0001.md"), "---\nid: DEMO0001\ntitle: x\nstatus: active\n---\n\nbody\n");
    const v = validateOp(root);
    assert.equal(v.ok, false, "missing required fields are caught");
    assert.ok(v.errors.some((e) => /summary|priority|effort|milestone|depends_on/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regenerate rewrites a stale artifact and reports what changed", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.deepEqual(regenerateOp(root).changed, [], "nothing stale right after create");
    writeFileSync(join(root, "trellis/backlog.json"), "{}\n"); // corrupt an artifact
    const { changed, counts } = regenerateOp(root);
    assert.ok(changed.some((p) => /backlog\.json$/.test(p)), "the stale artifact is rewritten");
    assert.equal(counts.active, 1);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task keeps a numeric-looking title as a string (round-trip)", () => {
  // The front-matter writer must quote an all-digit title so the core parser does
  // not coerce it to a number, which would violate the backlog.json string contract.
  const root = freshRepo();
  try {
    const { created } = createTask(root, { ...VALID, title: "2024" });
    assert.equal(typeof created.title, "string", "title stays a string in the result");
    assert.equal(created.title, "2024");
    const onDisk = JSON.parse(readFileSync(join(root, "trellis/backlog.json"), "utf8"));
    assert.strictEqual(onDisk.tasks[0].title, "2024", "backlog.json carries the string, not 2024");
    assert.equal(getTask(root, { id: "DEMO0001" }).title, "2024");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task dedupes depends_on", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID); // DEMO0001
    const { created } = createTask(root, { ...VALID, depends_on: ["DEMO0001", "DEMO0001"] });
    assert.deepEqual(created.depends_on, ["DEMO0001"], "duplicate dependency ids are collapsed");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task rejects a path-traversal id and changes nothing", () => {
  // A traversal id like ../active/DEMO0001 must never reach a filesystem path —
  // with to:"removed" it could otherwise delete the active task. Reject up front.
  const root = freshRepo();
  try {
    createTask(root, VALID); // DEMO0001 active
    for (const id of ["../active/DEMO0001", "DEMO0001/../DEMO0001", "../../etc/passwd"]) {
      assert.throws(
        () => moveTask(root, { id, to: "removed", reason: "x", date: "2026-06-26" }),
        (e) => e instanceof TrellisError && e.code === "invalid_request",
        `id ${id} should be rejected`,
      );
    }
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "the active task is untouched");
    assert.ok(validateOp(root).ok, "the backlog is still valid");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task rejects a malformed dependency id and writes nothing", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => createTask(root, { ...VALID, depends_on: ["../active/DEMO0001"] }),
      (e) => e instanceof TrellisError && e.code === "invalid_request",
    );
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "nothing is written");
    assert.equal(nextIdOp(root).nextId, "DEMO0001", "next id did not advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_task rejects a malformed id", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.throws(
      () => getTask(root, { id: "../../etc/passwd" }),
      (e) => e instanceof TrellisError && e.code === "invalid_request",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_task normalizes a surrounding-whitespace id instead of 404ing", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    assert.equal(getTask(root, { id: "  DEMO0001  " }).id, "DEMO0001", "the trimmed id resolves");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task defaults the close date to a valid local ISO date", () => {
  const root = freshRepo();
  try {
    createTask(root, VALID);
    const { moved } = moveTask(root, { id: "DEMO0001", to: "completed" }); // no date
    assert.match(moved.completed_on, /^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date is recorded");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task accepts owner/collaborators, normalizes case, dedupes, stays --check-green", () => {
  const root = withRoster(freshRepo(), TEAM);
  try {
    const { created } = createTask(root, { ...VALID, owner: "ALICE", collaborators: ["bob", "bob"] });
    assert.equal(created.owner, "alice", "owner normalized to the canonical handle");
    assert.deepEqual(created.collaborators, ["bob"], "collaborators deduped");
    assert.match(readFileSync(join(root, "trellis/active/DEMO0001.md"), "utf8"), /^owner: alice$/m);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create_task rejects an owner/collaborator who is not an active roster member, writing nothing", () => {
  const root = withRoster(freshRepo(), [{ handle: "alice", name: "Alice", status: "inactive" }]);
  try {
    assert.throws(() => createTask(root, { ...VALID, owner: "alice" }), (e) => e instanceof TrellisError && /not an active roster member/.test(e.message));
    assert.throws(() => createTask(root, { ...VALID, owner: "ghost" }), /not an active roster member/);
    assert.throws(() => createTask(root, { ...VALID, collaborators: ["ghost"] }), /not an active roster member/);
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "nothing written");
    assert.equal(nextIdOp(root).nextId, "DEMO0001", "next id did not advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_task and list_tasks surface owner/collaborators", () => {
  const root = withRoster(freshRepo(), TEAM);
  try {
    createTask(root, { ...VALID, owner: "alice", collaborators: ["bob"] });
    const t = getTask(root, { id: "DEMO0001" });
    assert.equal(t.owner, "alice");
    assert.deepEqual(t.collaborators, ["bob"]);
    assert.equal(listTasks(root).tasks[0].owner, "alice");
    assert.deepEqual(listTasks(root).tasks[0].collaborators, ["bob"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task carries the owner over on close, and an override records a historical assignee", () => {
  const root = withRoster(freshRepo(), [{ handle: "alice", name: "Alice", status: "active" }]);
  try {
    createTask(root, { ...VALID, owner: "alice" });
    const { moved } = moveTask(root, { id: "DEMO0001", to: "completed", date: "2026-06-27" });
    assert.equal(moved.owner, "alice", "owner carries over to the completed item");
    assertCheckClean(root);

    // A second task whose owner is reassigned at close to a non-roster handle — allowed
    // because closed items are historical and not re-validated (SPEC §8.3).
    createTask(root, { ...VALID, owner: "alice" }); // DEMO0002
    const { moved: m2 } = moveTask(root, { id: "DEMO0002", to: "completed", date: "2026-06-27", collaborators: ["pastIntern"] });
    assert.deepEqual(m2.collaborators, ["pastIntern"]);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("move_task rejects a historical assignee that is not a valid handle (would corrupt serialization)", () => {
  const root = withRoster(freshRepo(), [{ handle: "alice", name: "Alice", status: "active" }]);
  try {
    createTask(root, { ...VALID, owner: "alice" });
    // A comma in a collaborator would split through the inline-array serializer; a space
    // in an owner is not a handle. Both must be rejected even on the historical path.
    assert.throws(() => moveTask(root, { id: "DEMO0001", to: "completed", date: "2026-06-27", collaborators: ["a,b"] }), /invalid handle/);
    assert.throws(() => moveTask(root, { id: "DEMO0001", to: "completed", date: "2026-06-27", owner: "John Smith" }), /invalid handle/);
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "the task stays active after a rejected move");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool: dry-run by default writes nothing; apply writes + stays --check-green", () => {
  const root = freshRepo();
  try {
    const dry = importOp(root, { source: yamlSrc, profile: "yaml-frontmatter" }); // no apply
    assert.equal(dry.dryRun, true);
    assert.equal(dry.counts.total, 4);
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "dry-run writes no items");

    const applied = importOp(root, { source: yamlSrc, profile: "yaml-frontmatter", apply: true });
    assert.equal(applied.dryRun, false);
    assert.deepEqual(applied.counts, { active: 2, completed: 1, removed: 1, total: 4 });
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "apply writes the items");
    assert.ok(validateOp(root).ok);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool accepts an inline mapping object as an alternative to a profile", () => {
  const root = freshRepo();
  const mapping = loadProfile("yaml-frontmatter").mapping;
  try {
    const res = importOp(root, { source: yamlSrc, mapping, apply: true });
    assert.deepEqual(res.counts, { active: 2, completed: 1, removed: 1, total: 4 });
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool resolves a relative source against the target repo", () => {
  const root = freshRepo();
  try {
    mkdirSync(join(root, "src-backlog/active"), { recursive: true });
    writeFileSync(
      join(root, "src-backlog/active/x.md"),
      "---\nid: A1\ntitle: Imported\npriority: High\nmilestone: Alpha\neffort: 1\nsummary: An imported item.\ndepends_on: []\n---\n\n# Imported\n\nProse.\n",
    );
    const res = importOp(root, { source: "src-backlog", profile: "yaml-frontmatter", apply: true });
    assert.equal(res.counts.active, 1);
    assert.ok(existsSync(join(root, "trellis/active/DEMO0001.md")), "the relative source was found and imported");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool requires exactly one of profile or mapping, plus a source", () => {
  const root = freshRepo();
  const mapping = loadProfile("yaml-frontmatter").mapping;
  try {
    assert.throws(() => importOp(root, { source: yamlSrc }), /exactly one of/); // neither
    assert.throws(() => importOp(root, { source: yamlSrc, profile: "yaml-frontmatter", mapping }), /exactly one of/); // both
    assert.throws(() => importOp(root, { profile: "yaml-frontmatter" }), /source. is required/); // no source
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool throws not_found on an unknown profile", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => importOp(root, { source: yamlSrc, profile: "does-not-exist" }),
      (e) => e instanceof TrellisError && e.code === "not_found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import tool surfaces a refused import as an error and writes nothing", () => {
  // Drop the milestone remap so the legacy fixture's active milestones no longer
  // resolve — the engine refuses the whole import; the tool maps that to an error.
  const root = freshRepo();
  const mapping = loadProfile("taproot-ai-backlog").mapping;
  delete mapping.remap.milestone;
  try {
    assert.throws(
      () => importOp(root, { source: join(fixtures, "legacy-backlog"), mapping, apply: true }),
      (e) => e instanceof TrellisError && e.code === "import_failed",
    );
    assert.equal(existsSync(join(root, "trellis/active/DEMO0001.md")), false, "nothing written on refusal");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- id ledger
// A ledger-mode repo: a git work tree with the scaffold and, unless `seeded` is
// false, a seeded ledger. Nothing is committed (HEAD stays unborn).
const REF = "refs/trellis/ids";
function ledgerRepo({ seeded = true, cfg: over = {} } = {}) {
  const root = realpathSync(freshRepo());
  execFileSync("git", ["-C", root, "init", "-q", ...initRefFormat, "-b", "main"]);
  const cfgPath = join(root, "trellis", "backlog.config.json");
  const cfg = { ...JSON.parse(readFileSync(cfgPath, "utf8")), idAllocation: "ledger", ...over };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  if (seeded) seed(root, cfg);
  return { root, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const refTip = (root) => { try { return execFileSync("git", ["-C", root, "rev-parse", "--verify", "-q", REF], { encoding: "utf8" }).trim(); } catch { return null; } };
const ARTIFACTS = ["README.md", "completed/index.md", "removed/index.md", "backlog.json"];
const artifactBytes = (root) => Object.fromEntries(ARTIFACTS.map((a) => {
  const f = join(root, "trellis", a);
  return [a, existsSync(f) ? readFileSync(f, "utf8") : null];
}));
const leftovers = (root) => ARTIFACTS.flatMap((a) => readdirSync(dirname(join(root, "trellis", a))).filter((n) => /\.(tmp|bak)$/.test(n)));
const throwsTrellis = (fn, code) => assert.throws(fn, (e) => e instanceof TrellisError && (code === undefined || e.code === code), `expected TrellisError ${code ?? ""}`);

ledgerTest("claim_id claims through the ledger, and create_task uses the claimed id", () => {
  const c = ledgerRepo();
  try {
    assert.equal(claimIdOp(c.root, { title: "Reserved" }).id, "DEMO0001");
    const out = createTask(c.root, VALID);
    assert.equal(out.created.id, "DEMO0002");
    assert.deepEqual(ledgerList(c.root, c.cfg).rows.map((r) => `${r.id} ${r.kind}`), ["DEMO0001 claim", "DEMO0002 claim"]);
    assertCheckClean(c.root);
    // The registered tool returns the same structured result.
    const handlers = {};
    registerTools({ registerTool: (name, _m, h) => { handlers[name] = h; } }, c.root);
    const res = handlers.claim_id({ title: "Via tool" });
    assert.equal(res.structuredContent.id, "DEMO0003");
  } finally { c.cleanup(); }
});

ledgerTest("claim_id refuses in scan mode and with a tab in the title", () => {
  const c = ledgerRepo({ cfg: { idAllocation: "scan" } });
  try {
    throwsTrellis(() => claimIdOp(c.root, { title: "x" }), "invalid_request");
  } finally { c.cleanup(); }
  const d = ledgerRepo();
  try {
    const t = refTip(d.root);
    throwsTrellis(() => claimIdOp(d.root, { title: "a\tb" }), "invalid_request");
    assert.equal(refTip(d.root), t);
  } finally { d.cleanup(); }
});

ledgerTest("create_task in ledger mode checks milestone and priority before claiming", () => {
  const c = ledgerRepo();
  try {
    const t = refTip(c.root);
    throwsTrellis(() => createTask(c.root, { ...VALID, milestone: "Nope" }), "invalid_request");
    throwsTrellis(() => createTask(c.root, { ...VALID, priority: "Urgent" }), "invalid_request");
    assert.equal(refTip(c.root), t, "no id was claimed");
  } finally { c.cleanup(); }
});

ledgerTest("create_task in ledger mode fails with the seed message when the ref is absent, and never scans", () => {
  const c = ledgerRepo({ seeded: false });
  try {
    const before = artifactBytes(c.root);
    assert.throws(() => createTask(c.root, VALID), (e) => e instanceof TrellisError && /claim --seed/.test(e.message));
    assert.equal(refTip(c.root), null);
    assert.equal(existsSync(join(c.root, "trellis", "active", "DEMO0001.md")), false);
    assert.deepEqual(artifactBytes(c.root), before);
  } finally { c.cleanup(); }
});

ledgerTest("a failure after the first artifact replacement restores every artifact and keeps the claim", () => {
  const c = ledgerRepo();
  try {
    const before = artifactBytes(c.root);
    assert.throws(() => createTask(c.root, VALID, { afterArtifactRename: (_p, n) => { if (n === 0) throw new Error("boom"); } }), /boom/);
    assert.deepEqual(artifactBytes(c.root), before);
    assert.equal(existsSync(join(c.root, "trellis", "active", "DEMO0001.md")), false, "the new item is removed");
    assert.deepEqual(leftovers(c.root), []);
    assert.deepEqual(ledgerList(c.root, c.cfg).rows.map((r) => r.id), ["DEMO0001"], "the claim stays");
    // The next create moves on to a fresh id.
    assert.equal(createTask(c.root, VALID).created.id, "DEMO0002");
  } finally { c.cleanup(); }
});

ledgerTest("a rollback removes an artifact that was newly installed and had no original", () => {
  const c = ledgerRepo();
  try {
    rmSync(join(c.root, "trellis", "backlog.json"));
    const before = artifactBytes(c.root);
    assert.throws(() => createTask(c.root, VALID, { afterArtifactRename: (p) => { if (p.endsWith("backlog.json")) throw new Error("boom"); } }), /boom/);
    assert.equal(existsSync(join(c.root, "trellis", "backlog.json")), false);
    assert.deepEqual(artifactBytes(c.root), before);
    assert.deepEqual(leftovers(c.root), []);
  } finally { c.cleanup(); }
});

ledgerTest("a backup cleanup failure after the commit point is a warning, not a failure", () => {
  const c = ledgerRepo();
  try {
    const out = createTask(c.root, VALID, { removeBackup: () => { throw new Error("cannot remove"); } });
    assert.equal(out.created.id, "DEMO0001");
    assert.ok(out.warnings.length >= 1);
    assert.match(out.warnings[0], /cannot remove/);
    assertCheckClean(c.root);
  } finally { c.cleanup(); }
});

ledgerTest("a backup cleanup failure after a move is a warning, as in create_task", () => {
  const c = ledgerRepo();
  try {
    createTask(c.root, VALID);
    const out = moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" }, { removeBackup: () => { throw new Error("cannot remove"); } });
    assert.equal(out.moved.id, "DEMO0001");
    assert.ok(out.warnings.length >= 1);
    assert.match(out.warnings[0], /cannot remove/);
    assertCheckClean(c.root);
  } finally { c.cleanup(); }
});

for (const dangling of [false, true]) {
  ledgerTest(`ledger mode refuses a symlinked backlog.json (${dangling ? "dangling" : "live"}) in create_task, move_task and regenerate, changing nothing`, { skip: process.platform === "win32" }, () => {
    const c = ledgerRepo();
    try {
      createTask(c.root, VALID);
      const link = join(c.root, "trellis", "backlog.json");
      const real = join(c.root, "real.json");
      if (!dangling) renameSync(link, real); else rmSync(link);
      symlinkSync(real, link);
      const before = refTip(c.root);
      const bytes = artifactBytes(c.root);
      throwsTrellis(() => createTask(c.root, VALID), "invalid_request");
      throwsTrellis(() => moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" }), "invalid_request");
      throwsTrellis(() => regenerateOp(c.root), "invalid_request");
      assert.equal(refTip(c.root), before, "no id was claimed");
      assert.ok(lstatSync(link).isSymbolicLink(), "the link is untouched");
      assert.equal(existsSync(join(c.root, "trellis", "active", "DEMO0001.md")), true, "the item did not move");
      assert.deepEqual(artifactBytes(c.root), bytes);
      assert.deepEqual(leftovers(c.root), []);
    } finally { c.cleanup(); }
  });
}

ledgerTest("ledger mode refuses a FIFO artifact without blocking, and unsafe front-matter text before claiming", { skip: process.platform === "win32" }, () => {
  const c = ledgerRepo();
  try {
    const before = refTip(c.root);
    for (const key of ["title", "summary", "milestone", "priority"]) {
      for (const bad of ["a\u2028b", "a\u0001b", "a\u2029b"]) {
        throwsTrellis(() => createTask(c.root, { ...VALID, [key]: bad }), "invalid_request");
      }
    }
    assert.equal(refTip(c.root), before, "no id was claimed");
    const readme = join(c.root, "trellis", "README.md");
    rmSync(readme);
    execFileSync("mkfifo", [readme]);
    throwsTrellis(() => createTask(c.root, VALID), "invalid_request");
    throwsTrellis(() => regenerateOp(c.root), "invalid_request");
    assert.equal(refTip(c.root), before);
  } finally { c.cleanup(); }
});

ledgerTest("ledger mode refuses a symlinked README.md and completed index the same way", { skip: process.platform === "win32" }, () => {
  for (const rel of ["README.md", join("completed", "index.md")]) {
    const c = ledgerRepo();
    try {
      const link = join(c.root, "trellis", rel);
      const real = join(c.root, "real.md");
      renameSync(link, real);
      symlinkSync(real, link);
      const before = refTip(c.root);
      throwsTrellis(() => createTask(c.root, VALID), "invalid_request");
      assert.equal(refTip(c.root), before);
    } finally { c.cleanup(); }
  }
});
ledgerTest("staging never writes through a symlink planted at a staging name", { skip: process.platform === "win32" }, () => {
  const c = ledgerRepo();
  try {
    const victim = join(c.root, "victim.txt");
    writeFileSync(victim, "keep");
    // Plant the name the old counter-based scheme would have picked.
    for (let i = 0; i < 50; i++) {
      for (const ext of ["tmp", "bak"]) {
        for (const a of ["README.md", "backlog.json"]) symlinkSync(victim, join(c.root, "trellis", `.${a}.${process.pid}-${i.toString(36)}.${ext}`));
      }
    }
    createTask(c.root, VALID);
    assert.equal(readFileSync(victim, "utf8"), "keep");
    assertCheckClean(c.root);
  } finally { c.cleanup(); }
});

ledgerTest("a backup that cannot be restored is kept and named in the error", () => {
  const c = ledgerRepo();
  try {
    const hook = {
      afterArtifactRename: (p, n) => {
        if (n !== 0) return;
        // Block the restore: the live path becomes a non-empty directory.
        rmSync(p, { force: true });
        mkdirSync(p);
        writeFileSync(join(p, "x"), "x");
        throw new Error("boom");
      },
    };
    let err;
    try { createTask(c.root, VALID, hook); } catch (e) { err = e; }
    assert.ok(err, "create_task fails");
    const m = /backups kept at: (\S+)/.exec(err.message);
    assert.ok(m, "the error names the backup");
    assert.ok(readFileSync(m[1], "utf8").length > 0, "the kept backup still holds the original bytes");
  } finally { c.cleanup(); }
});

ledgerTest("create_task in ledger mode checks depends_on ids before claiming", () => {
  const c = ledgerRepo();
  try {
    const t = refTip(c.root);
    throwsTrellis(() => createTask(c.root, { ...VALID, depends_on: ["DEMO0099"] }), "invalid_request");
    assert.equal(refTip(c.root), t, "no id was claimed");
  } finally { c.cleanup(); }
});

ledgerTest("a write failure after the item file is opened removes the partial item and keeps the claim", () => {
  const c = ledgerRepo();
  try {
    const before = artifactBytes(c.root);
    assert.throws(() => createTask(c.root, VALID, { afterOpen: ({ fd }) => { writeSync(fd, "---\npartial"); throw new Error("disk full"); } }), /disk full/);
    assert.equal(existsSync(join(c.root, "trellis", "active", "DEMO0001.md")), false);
    assert.deepEqual(artifactBytes(c.root), before);
    assert.equal(ledgerList(c.root, c.cfg).rows.length, 1);
  } finally { c.cleanup(); }
});

ledgerTest("an existing item that a case-insensitive filesystem aliases survives a collision byte for byte", (t) => {
  const c = ledgerRepo();
  try {
    const probe = join(c.root, "probe.x");
    writeFileSync(probe, "x");
    if (existsSync(join(c.root, "PROBE.X"))) {
      const other = join(c.root, "trellis", "active", "DEMO0001.MD");
      writeFileSync(other, "keep me\n");
      assert.throws(() => createTask(c.root, VALID), (e) => e instanceof TrellisError && e.code === "conflict");
      assert.equal(readFileSync(other, "utf8"), "keep me\n");
      assert.equal(ledgerList(c.root, c.cfg).rows.length, 1, "the claim stays");
    } else {
      t.skip("case-sensitive filesystem");
    }
  } finally { c.cleanup(); }
});

ledgerTest("a title holding replacement patterns is inserted as text and check passes", () => {
  const c = ledgerRepo();
  try {
    createTask(c.root, { ...VALID, title: "Fix $& and $1 and $$ now" });
    assert.match(readFileSync(join(c.root, "trellis", "README.md"), "utf8"), /Fix \$& and \$1 and \$\$ now/);
    assertCheckClean(c.root);
    const { cfg } = loadConfig(c.root);
    const data = readBacklog(c.root, cfg);
    assert.deepEqual(data.errors, []);
  } finally { c.cleanup(); }
});

ledgerTest("ledger-mode generated bytes match scan mode for an ordinary title", () => {
  const scan = freshRepo();
  const c = ledgerRepo();
  try {
    createTask(scan, VALID);
    createTask(c.root, VALID);
    for (const a of ARTIFACTS) {
      assert.equal(readFileSync(join(c.root, "trellis", a), "utf8"), readFileSync(join(scan, "trellis", a), "utf8"), a);
    }
  } finally { c.cleanup(); rmSync(scan, { recursive: true, force: true }); }
});

ledgerTest("the layout guard runs before the task tree is read", { skip: process.platform === "win32" }, () => {
  const c = ledgerRepo();
  try {
    const elsewhere = join(c.root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "DEMO0001.md"), "not front-matter\n");
    rmSync(join(c.root, "trellis", "active"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(c.root, "trellis", "active"));
    const t = refTip(c.root);
    const before = artifactBytes(c.root);
    throwsTrellis(() => createTask(c.root, VALID), "invalid_request");
    assert.equal(refTip(c.root), t);
    assert.deepEqual(artifactBytes(c.root), before);
    assert.equal(readFileSync(join(elsewhere, "DEMO0001.md"), "utf8"), "not front-matter\n");
  } finally { c.cleanup(); }
});

ledgerTest("next_id in ledger mode is a preview that leaves the ref alone", () => {
  const c = ledgerRepo();
  try {
    const t = refTip(c.root);
    const out = nextIdOp(c.root);
    assert.equal(out.nextId, "DEMO0001");
    assert.equal(out.preview, true);
    assert.equal(refTip(c.root), t);
    assert.equal(nextIdOp(c.root).nextId, "DEMO0001", "asking twice does not consume the id");
  } finally { c.cleanup(); }
  const gone = ledgerRepo({ seeded: false });
  try {
    const out = nextIdOp(gone.root);
    assert.equal(out.nextId, null);
    assert.match(out.note, /claim --seed/);
  } finally { gone.cleanup(); }
  const full = ledgerRepo({ cfg: { idWidth: 1 } });
  try {
    through(full.root, full.cfg, "DEMO9");
    const out = nextIdOp(full.root);
    assert.equal(out.nextId, null);
    assert.match(out.note, /exhausted/);
  } finally { full.cleanup(); }
});

ledgerTest("list_tasks and regenerate return the ledger preview, and the files keep the scan nextId", () => {
  const c = ledgerRepo();
  try {
    claim(c.root, c.cfg, { title: "Open claim" });
    assert.equal(listTasks(c.root).nextId, "DEMO0002");
    const out = regenerateOp(c.root);
    assert.equal(out.nextId, "DEMO0002");
    const gen = () => spawnSync(process.execPath, [join(sourceRoot, "scripts", "backlog-readme.mjs"), "--target", c.root], { encoding: "utf8" });
    assert.equal(gen().status, 0);
    assert.equal(JSON.parse(readFileSync(join(c.root, "trellis", "backlog.json"), "utf8")).nextId, "DEMO0001");
  } finally { c.cleanup(); }
  const gone = ledgerRepo({ seeded: false });
  try {
    const listed = listTasks(gone.root);
    assert.equal(listed.nextId, null);
    assert.match(listed.nextIdNote, /claim --seed/);
    const out = regenerateOp(gone.root);
    assert.equal(out.nextId, null);
    assert.match(out.note, /claim --seed/);
    const r = spawnSync(process.execPath, [join(sourceRoot, "scripts", "backlog-readme.mjs"), "--target", gone.root], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(readFileSync(join(gone.root, "trellis", "backlog.json"), "utf8")).nextId, "DEMO0001");
  } finally { gone.cleanup(); }
});

ledgerTest("committed backlog.json is identical with and without the ledger ref", () => {
  const c = ledgerRepo({ seeded: false });
  try {
    const gen = () => spawnSync(process.execPath, [join(sourceRoot, "scripts", "backlog-readme.mjs"), "--target", c.root], { encoding: "utf8" });
    gen();
    const without = readFileSync(join(c.root, "trellis", "backlog.json"), "utf8");
    seed(c.root, c.cfg);
    claim(c.root, c.cfg, { title: "x" });
    gen();
    assert.equal(readFileSync(join(c.root, "trellis", "backlog.json"), "utf8"), without);
  } finally { c.cleanup(); }
});

ledgerTest("import in ledger mode throws invalid_request, and the registered tool returns the guidance", () => {
  const c = ledgerRepo();
  try {
    const before = artifactBytes(c.root);
    const args = { source: join(fixtures, "legacy-backlog"), profile: "taproot-ai-backlog" };
    for (const apply of [false, true]) {
      throwsTrellis(() => importOp(c.root, { ...args, apply }), "invalid_request");
    }
    const handlers = {};
    registerTools({ registerTool: (name, _m, h) => { handlers[name] = h; } }, c.root);
    const res = handlers.import({ ...args, apply: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ledger/);
    assert.match(res.content[0].text, /Import before switching/);
    assert.deepEqual(artifactBytes(c.root), before);
    assert.equal(existsSync(join(c.root, "trellis", "active", "DEMO0001.md")), false);
  } finally { c.cleanup(); }
});

// ------------------------------------------------- external review round 2

ledgerTest("stageFile removes its reserved file when the write fails", () => {
  const c = ledgerRepo();
  try {
    const dest = join(c.root, "trellis", "x.json");
    assert.throws(() => stageFile(dest, "tmp", 42, 0o644));
    assert.deepEqual(readdirSync(join(c.root, "trellis")).filter((n) => /\.tmp$/.test(n)), []);
  } finally { c.cleanup(); }
});


ledgerTest("ledger mode: a title holding the end marker as text cannot end a generated block", () => {
  const c = ledgerRepo();
  try {
    const title = "Fix <!-- END GENERATED:MILESTONES --> handling";
    assert.equal(createTask(c.root, { ...VALID, title }).created.id, "DEMO0001");
    assertCheckClean(c.root);
    assert.equal(createTask(c.root, VALID).created.id, "DEMO0002");
    assertCheckClean(c.root);
  } finally { c.cleanup(); }
});

ledgerTest("ledger mode: a config with a fractional effort is a config error, so no id is claimed", () => {
  const c = ledgerRepo({ cfg: { effort: { values: [0.5, 1, 3] } } });
  try {
    const t = refTip(c.root);
    const before = artifactBytes(c.root);
    assert.throws(() => createTask(c.root, { ...VALID, effort: 3 }), /integers/);
    assert.equal(refTip(c.root), t, "no id was claimed");
    assert.deepEqual(artifactBytes(c.root), before);
  } finally { c.cleanup(); }
});

// ------------------------------------------ local generated artifacts (TRL0038)
const GEN_FILES = ["index.md", "completed.md", "removed.md", "backlog.json"];

// A local-mode repo: the scaffold with a marker-free README and index files, no
// committed backlog.json, a git work tree and the ignore rule. `ledger` adds a
// seeded ledger. `inGit: false` leaves it outside any work tree.
function localMcpRepo({ ledger = false, seeded = true, inGit = true, ignore = true } = {}) {
  const root = realpathSync(freshRepo());
  const t = join(root, "trellis");
  const cfgPath = join(t, "backlog.config.json");
  const raw = { ...JSON.parse(readFileSync(cfgPath, "utf8")), generatedArtifacts: "local", ...(ledger ? { idAllocation: "ledger" } : {}) };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  writeFileSync(join(t, "README.md"), "# Backlog\n\nAuthored prose.\n");
  writeFileSync(join(t, "completed", "index.md"), "# Completed\n");
  writeFileSync(join(t, "removed", "index.md"), "# Removed\n");
  rmSync(join(t, "backlog.json"), { force: true });
  if (inGit) execFileSync("git", ["-C", root, "init", "-q", ...initRefFormat, "-b", "main"]);
  if (ignore) writeFileSync(join(root, ".gitignore"), "trellis/.generated/\n");
  const cfg = loadConfig(root).cfg;
  if (ledger && seeded) seed(root, cfg);
  return { root, cfg, gen: join(t, ".generated"), readme: join(t, "README.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
// The whole tree (path and bytes), minus .git, so "wrote nothing" is checked in full.
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { out[p.slice(root.length)] = "<dir>"; walk(p); }
      else out[p.slice(root.length)] = lstatSync(p).isSymbolicLink() ? "<link>" : readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}
const hasItem = (root, id = "DEMO0001") => existsSync(join(root, "trellis", "active", `${id}.md`));
// Runs `fn` with a `git` first on PATH that fails any command containing `when`.
function withGitShim(when, fn) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "trellis-mcp-shim-")));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${when}" ]; then\n    echo "fatal: detected dubious ownership in repository" >&2\n    exit 128\n  fi\ndone\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try { return fn(); } finally { process.env.PATH = old; rmSync(bin, { recursive: true, force: true }); }
}
const MARKER = "<!-- BEGIN GENERATED:MILESTONES -->";
const MODE_CASES = [["scan", false], ["ledger", true]];

test("local regenerate writes only .generated/, create_task and move_task keep it current", () => {
  const c = localMcpRepo();
  try {
    const readme = readFileSync(c.readme, "utf8");
    const out = regenerateOp(c.root);
    assert.deepEqual(out.changed.map((p) => p.replace(/\\/g, "/")).sort(), GEN_FILES.map((n) => `trellis/.generated/${n}`).sort());
    assert.equal(out.nextId, "DEMO0001");
    assert.equal(createTask(c.root, VALID).created.id, "DEMO0001");
    assert.match(readFileSync(join(c.gen, "index.md"), "utf8"), /\[DEMO0001\]\(\.\.\/active\/DEMO0001\.md\)/);
    assert.equal(moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" }).moved.status, "completed");
    assert.match(readFileSync(join(c.gen, "completed.md"), "utf8"), /\[DEMO0001\]\(\.\.\/completed\/tasks\/DEMO0001\.md\)/);
    assert.equal(readFileSync(c.readme, "utf8"), readme, "README is never written");
    assert.equal(existsSync(join(c.root, "trellis", "backlog.json")), false);
    assert.equal(validateOp(c.root).ok, true);
  } finally { c.cleanup(); }
});

ledgerTest("local ledger regenerate writes the ledger preview into .generated/backlog.json", () => {
  const c = localMcpRepo({ ledger: true });
  try {
    claim(c.root, c.cfg, { title: "Open claim" });
    const out = regenerateOp(c.root);
    assert.equal(out.nextId, "DEMO0002");
    assert.equal(JSON.parse(readFileSync(join(c.gen, "backlog.json"), "utf8")).nextId, "DEMO0002");
    assert.equal(createTask(c.root, VALID).created.id, "DEMO0002");
    assert.equal(JSON.parse(readFileSync(join(c.gen, "backlog.json"), "utf8")).nextId, "DEMO0003", "the preview follows the claim");
  } finally { c.cleanup(); }
  const gone = localMcpRepo({ ledger: true, seeded: false });
  try {
    regenerateOp(gone.root);
    assert.equal(JSON.parse(readFileSync(join(gone.gen, "backlog.json"), "utf8")).nextId, null);
  } finally { gone.cleanup(); }
});

test("validate reports the same ordered errors as check in local mode, including a stray marker", () => {
  const c = localMcpRepo();
  try {
    assert.deepEqual(validateOp(c.root), { ok: true, errors: [], warnings: [] });
    writeFileSync(join(c.root, "trellis", "active", "DEMO0001.md"), "---\nid: DEMO0001\ntitle: T\nstatus: active\nmilestone: Nope\npriority: High\neffort: 3\ndepends_on: []\nsummary: S.\n---\n");
    writeFileSync(c.readme, `# Backlog\n${MARKER}\n`);
    const out = validateOp(c.root);
    assert.equal(out.ok, false);
    assert.equal(out.errors.length, 2);
    assert.match(out.errors[0], /^active\/DEMO0001\.md: milestone must be one of/);
    assert.match(out.errors[1], /^trellis\/README\.md: holds the generated marker line <!-- BEGIN GENERATED:MILESTONES -->/);
    // The CLI check prints the same errors in the same order.
    const r = spawnSync(process.execPath, [join(sourceRoot, "scripts", "trellis.mjs"), "check"], { cwd: c.root, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.deepEqual(r.stderr.trim().split("\n").slice(1).map((l) => l.replace(/^ {2}- /, "")), out.errors);
  } finally { c.cleanup(); }
});

for (const [mode, ledger] of MODE_CASES) {
  ledgerTest(`regenerate, create_task and move_task refuse a bad .generated or output before any write or claim (${mode})`, { skip: process.platform === "win32" }, () => {
    const c = localMcpRepo({ ledger });
    try {
      createTask(c.root, VALID); // DEMO0001, so move_task has something to move
      const elsewhere = join(c.root, "elsewhere");
      mkdirSync(elsewhere);
      const cases = [
        ["symlinked .generated", () => { rmSync(c.gen, { recursive: true }); symlinkSync(elsewhere, c.gen); }],
        ["file at .generated", () => { rmSync(c.gen, { recursive: true }); writeFileSync(c.gen, "x\n"); }],
        ["symlinked output", () => { rmSync(join(c.gen, "backlog.json")); symlinkSync(join(c.root, "nowhere"), join(c.gen, "backlog.json")); }],
        ["directory output", () => { rmSync(join(c.gen, "completed.md")); mkdirSync(join(c.gen, "completed.md")); }],
      ];
      for (const [name, setup] of cases) {
        setup();
        const tip = ledger ? refTip(c.root) : null;
        const before = snapshotTree(c.root);
        throwsTrellis(() => regenerateOp(c.root), "invalid_request");
        throwsTrellis(() => createTask(c.root, VALID), "invalid_request");
        throwsTrellis(() => moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" }), "invalid_request");
        assert.deepEqual(snapshotTree(c.root), before, name);
        if (ledger) assert.equal(refTip(c.root), tip, `${name}: no id was claimed`);
        // Put the folder back for the next case.
        rmSync(c.gen, { recursive: true, force: true });
        regenerateOp(c.root);
      }
      assert.deepEqual(readdirSync(elsewhere), []);
    } finally { c.cleanup(); }
  });
}

for (const [mode, ledger] of MODE_CASES) {
  ledgerTest(`create_task refuses a leftover marker, an unignored output and a tracked output with no claim and no item (${mode})`, () => {
    const marker = localMcpRepo({ ledger });
    try {
      writeFileSync(marker.readme, `# Backlog\n${MARKER}\n`);
      const tip = ledger ? refTip(marker.root) : null;
      const before = snapshotTree(marker.root);
      throwsTrellis(() => createTask(marker.root, VALID), "invalid_request");
      assert.equal(hasItem(marker.root), false);
      assert.deepEqual(snapshotTree(marker.root), before);
      if (ledger) assert.equal(refTip(marker.root), tip);
      // regenerate refuses on the stray marker too.
      throwsTrellis(() => regenerateOp(marker.root), "invalid_request");
      assert.deepEqual(snapshotTree(marker.root), before);
    } finally { marker.cleanup(); }

    const open = localMcpRepo({ ledger, ignore: false });
    try {
      const tip = ledger ? refTip(open.root) : null;
      const before = snapshotTree(open.root);
      assert.throws(() => createTask(open.root, VALID), (e) => e instanceof TrellisError && e.code === "invalid_request" && /not ignored by git[^]*trellis\/\.generated\//.test(e.message));
      throwsTrellis(() => regenerateOp(open.root), "invalid_request");
      assert.equal(hasItem(open.root), false);
      assert.deepEqual(snapshotTree(open.root), before);
      if (ledger) assert.equal(refTip(open.root), tip);
    } finally { open.cleanup(); }
  });

  ledgerTest(`move_task refuses an unignored output, and all three writers refuse a tracked output (${mode})`, () => {
    const c = localMcpRepo({ ledger });
    try {
      createTask(c.root, VALID);
      // Tracked: force-add one output.
      execFileSync("git", ["-C", c.root, "add", "-f", "trellis/.generated/index.md"]);
      const tip = ledger ? refTip(c.root) : null;
      const before = snapshotTree(c.root);
      for (const call of [() => regenerateOp(c.root), () => createTask(c.root, VALID), () => moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" })]) {
        assert.throws(call, (e) => e instanceof TrellisError && e.code === "invalid_request" && /index\.md is tracked/.test(e.message));
      }
      assert.deepEqual(snapshotTree(c.root), before);
      if (ledger) assert.equal(refTip(c.root), tip);
      execFileSync("git", ["-C", c.root, "rm", "-q", "--cached", "trellis/.generated/index.md"]);
      // Unignored: drop the rule.
      rmSync(join(c.root, ".gitignore"));
      assert.throws(() => moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" }), (e) => e instanceof TrellisError && /not ignored by git/.test(e.message));
      assert.equal(hasItem(c.root), true, "the item did not move");
    } finally { c.cleanup(); }
  });
}

test("regenerate, create_task and move_task succeed outside a git work tree", () => {
  const c = localMcpRepo({ inGit: false, ignore: false });
  try {
    assert.equal(regenerateOp(c.root).changed.length, 4);
    assert.equal(createTask(c.root, VALID).created.id, "DEMO0001");
    assert.equal(moveTask(c.root, { id: "DEMO0001", to: "removed", reason: "Not needed.", date: "2026-06-26" }).moved.status, "removed");
    assert.equal(validateOp(c.root).ok, true);
  } finally { c.cleanup(); }
});

for (const [mode, ledger] of MODE_CASES) {
  ledgerTest(`a forced git discovery error makes all three writers refuse with files and the ledger tip unchanged (${mode})`, { skip: process.platform === "win32" }, () => {
    const c = localMcpRepo({ ledger });
    try {
      createTask(c.root, VALID);
      const tip = ledger ? refTip(c.root) : null;
      const before = snapshotTree(c.root);
      withGitShim("--show-prefix", () => {
        // Only the new preflight's discovery fails, so the earlier ledger layout guard cannot satisfy this.
        for (const call of [() => regenerateOp(c.root), () => createTask(c.root, VALID), () => moveTask(c.root, { id: "DEMO0001", to: "completed", date: "2026-06-26" })]) {
          assert.throws(call, (e) => e instanceof TrellisError && e.code === "invalid_request" && /git could not inspect[^]*dubious ownership/.test(e.message));
        }
      });
      assert.deepEqual(snapshotTree(c.root), before);
      if (ledger) assert.equal(refTip(c.root), tip);
    } finally { c.cleanup(); }
  });
}

ledgerTest("a forced mid-write failure in ledger mode leaves no new artifact and no new .generated/", () => {
  for (const n of [0, 2, 3]) {
    const c = localMcpRepo({ ledger: true });
    try {
      assert.equal(existsSync(c.gen), false);
      assert.throws(() => createTask(c.root, VALID, { afterArtifactRename: (_p, i) => { if (i === n) throw new Error("boom"); } }), /boom/);
      assert.equal(existsSync(c.gen), false, `a rollback after artifact ${n} removes the empty .generated/`);
      assert.equal(hasItem(c.root), false);
      assert.deepEqual(ledgerList(c.root, c.cfg).rows.map((r) => r.id), ["DEMO0001"], "the claim stays");
    } finally { c.cleanup(); }
  }
  // An existing folder is kept, with its outputs restored.
  const c = localMcpRepo({ ledger: true });
  try {
    regenerateOp(c.root);
    const before = GEN_FILES.map((n) => readFileSync(join(c.gen, n), "utf8"));
    assert.throws(() => createTask(c.root, VALID, { afterArtifactRename: (_p, i) => { if (i === 1) throw new Error("boom"); } }), /boom/);
    assert.deepEqual(GEN_FILES.map((n) => readFileSync(join(c.gen, n), "utf8")), before);
    assert.deepEqual(readdirSync(c.gen).sort(), [...GEN_FILES].sort(), "no staging leftovers");
  } finally { c.cleanup(); }
});

test("a forced mid-write failure in scan mode restores outputs and removes new ones and the new .generated/", () => {
  const c = localMcpRepo();
  try {
    for (const n of [0, 2, 3]) {
      writerSeams.beforeWrite = (_p, i) => { if (i === n) throw new Error("boom"); };
      const before = snapshotTree(c.root);
      assert.throws(() => regenerateOp(c.root), /boom/);
      assert.deepEqual(snapshotTree(c.root), before, `failure at write ${n}`);
      assert.equal(existsSync(c.gen), false);
    }
    writerSeams.beforeWrite = null;
    createTask(c.root, VALID);
    writeFileSync(join(c.root, "trellis", "active", "DEMO0002.md"), readFileSync(join(c.root, "trellis", "active", "DEMO0001.md"), "utf8").replace(/DEMO0001/g, "DEMO0002"));
    const before = snapshotTree(c.root);
    writerSeams.beforeWrite = (_p, i) => { if (i === 3) throw new Error("boom"); };
    assert.throws(() => regenerateOp(c.root), /boom/);
    assert.deepEqual(snapshotTree(c.root), before, "changed outputs are restored");
  } finally { writerSeams.beforeWrite = null; c.cleanup(); }
});
