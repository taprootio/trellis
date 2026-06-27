// Smoke/behavior tests for the MCP operations (zero-dependency, run via
// `node --test`). Scope is the tool contract in src/mcp.mjs — the transport-free
// core, driven directly; the SDK wiring in scripts/trellis-mcp.mjs is a thin
// adapter. The broader CLI/MCP matrix is TRL0011. Each test scaffolds a throwaway
// Trellis repo with the init scaffolder, then exercises the tools against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { loadProfile } from "../src/profiles.mjs";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";
import {
  listTasks, getTask, nextIdOp, createTask, moveTask, validateOp, regenerateOp, importOp, TrellisError,
} from "../src/mcp.mjs";

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
