// Behavior tests for the generator core's effort-scale support (SPEC §6),
// run via `node --test`. Each test builds a throwaway temp repo with a chosen
// config + item files, then exercises loadConfig / resolveEffort / readBacklog /
// generateArtifacts / buildBacklogJson directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, cpSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  loadRoster,
  findActiveMember,
  readBacklog,
  resolveEffort,
  generateArtifacts,
  buildBacklogJson,
  composeFile,
  parseFrontMatter,
  splitFrontMatter,
  validateConfig,
  paths,
  branchNameProblem,
  artifactSet,
  checkGenerated,
  validateLocal,
  markerLineErrors,
} from "../src/backlog.mjs";

const FISH = {
  specVersion: "1.0",
  idPrefix: "DEMO",
  idWidth: 4,
  milestones: ["Alpha"],
  priorities: ["High", "Low"],
  effort: {
    values: [1, 2, 3, 5, 8, 13, 21],
    scale: "fish",
    scales: {
      fish: {
        1: { label: "Minnow", emoji: "🐟" },
        2: { label: "Goldfish", emoji: "🐠" },
        3: { label: "Trout", emoji: "🐡" },
        5: { label: "Tuna", image: "assets/effort/tuna.svg" },
        8: { label: "Swordfish" },
        13: { label: "Shark", emoji: "🦈" },
        21: { label: "Whale", emoji: "🐋" },
      },
    },
  },
};

const ARRAY_CFG = { specVersion: "1.0", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High", "Low"], effort: [1, 2, 3, 5, 8, 13, 21] };

function fm(fields) {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
    return `${k}: ${v}`;
  });
  return `---\n${lines.join("\n")}\n---\n\nBody.\n`;
}

// Build a minimal --check-able repo: config + the three marker files + items.
function makeRepo(config, { active = [], completed = [], removed = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trellis-backlog-"));
  const tasks = join(root, "trellis");
  for (const d of ["active", "completed/tasks", "removed"]) mkdirSync(join(tasks, d), { recursive: true });
  writeFileSync(join(tasks, "backlog.config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(tasks, "README.md"), "# Backlog\n\n<!-- BEGIN GENERATED:MILESTONES -->\n<!-- END GENERATED:MILESTONES -->\n");
  writeFileSync(join(tasks, "completed", "index.md"), "# Completed\n\n<!-- BEGIN GENERATED:COMPLETED -->\n<!-- END GENERATED:COMPLETED -->\n");
  writeFileSync(join(tasks, "removed", "index.md"), "# Removed\n\n<!-- BEGIN GENERATED:REMOVED -->\n<!-- END GENERATED:REMOVED -->\n");
  for (const it of active) writeFileSync(join(tasks, "active", `${it.id}.md`), fm({ status: "active", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", ...it }));
  for (const it of completed) writeFileSync(join(tasks, "completed", "tasks", `${it.id}.md`), fm({ status: "completed", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", effort: 3, completed_on: "2026-01-01", ...it }));
  for (const it of removed) writeFileSync(join(tasks, "removed", `${it.id}.md`), fm({ status: "removed", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", effort: 3, removed_on: "2026-01-01", removed_reason: "R.", ...it }));
  return root;
}

const withRepo = (config, items, fn) => {
  const root = makeRepo(config, items);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// ------------------------------------------------------------- config

test("array-form effort loads as the identity scale", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.equal(cfg.effortScale.isIdentity, true);
    assert.equal(cfg.effortScale.name, "fibonacci");
    assert.equal(cfg.effortScale.byLabel.size, 0);
  });
});

test("scale: fibonacci (or absent) is the identity scale even in object form", () => {
  withRepo({ ...ARRAY_CFG, effort: { values: [1, 2, 3] } }, {}, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.equal(cfg.effortScale.isIdentity, true);
  });
});

test("a custom scale loads with its label/emoji/image map", () => {
  withRepo(FISH, {}, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.equal(cfg.effortScale.isIdentity, false);
    assert.equal(cfg.effortScale.name, "fish");
    assert.deepEqual(cfg.effortScale.byNumber.get(2), { label: "Goldfish", emoji: "🐠" });
    assert.deepEqual(cfg.effortScale.byNumber.get(5), { label: "Tuna", image: "assets/effort/tuna.svg" });
    assert.deepEqual(cfg.effortScale.byNumber.get(8), { label: "Swordfish" });
    assert.equal(cfg.effortScale.byLabel.get("goldfish"), 2);
  });
});

test("config errors: missing mapping, duplicate label, bad types, unknown active scale", () => {
  const cases = [
    [{ values: [1, 2], scale: "x", scales: { x: { 1: { label: "A" } } } }, /missing a mapping for value 2/],
    [{ values: [1, 2], scale: "x", scales: { x: { 1: { label: "Dup" }, 2: { label: "dup" } } } }, /duplicate label/],
    [{ values: [1], scale: "x", scales: { x: { 1: { label: "" } } } }, /`label` must be a non-empty string/],
    [{ values: [1], scale: "x", scales: { x: { 1: { label: "A", emoji: 5 } } } }, /`emoji` must be a string/],
    [{ values: [1], scale: "missing", scales: { x: { 1: { label: "A" } } } }, /not defined in `scales`/],
    [{ values: [1], scale: "x" }, /`scales` must be an object/],
  ];
  for (const [effort, re] of cases) {
    withRepo({ ...ARRAY_CFG, effort }, {}, (root) => {
      const { errors } = loadConfig(root);
      assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);
    });
  }
});

test("a non-string specVersion is a config error, never a throw", () => {
  const hostile = JSON.stringify({ ...ARRAY_CFG, specVersion: { toString: 1 } });
  for (const [json, re] of [[hostile, /`specVersion` must be a string/], [JSON.stringify({ ...ARRAY_CFG, specVersion: 1 }), /`specVersion` must be a string/]]) {
    withRepo({ ...ARRAY_CFG }, {}, (root) => {
      writeFileSync(join(root, "trellis/backlog.config.json"), json);
      const { errors } = loadConfig(root);
      assert.ok(errors.some((e) => re.test(e)), JSON.stringify(errors));
    });
  }
});

test("config accepts a valid nextIdFloor and rejects invalid ones (TRL0032)", () => {
  withRepo({ ...ARRAY_CFG, nextIdFloor: 100 }, {}, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.equal(cfg.nextIdFloor, 100);
  });
  const bad = [
    [-1, /nextIdFloor.*non-negative integer/],
    [3.5, /nextIdFloor.*non-negative integer/],
    [10000, /nextIdFloor.*10\^idWidth/], // idWidth 4 ⇒ must be < 10000
  ];
  for (const [nextIdFloor, re] of bad) {
    withRepo({ ...ARRAY_CFG, nextIdFloor }, {}, (root) => {
      const { errors } = loadConfig(root);
      assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);
    });
  }
});

// ----------------------------------------------------------- resolution

test("resolveEffort accepts a number or a case-insensitive label", () => {
  withRepo(FISH, {}, (root) => {
    const { cfg } = loadConfig(root);
    assert.deepEqual(resolveEffort(cfg, 2), { value: 2, label: "Goldfish", emoji: "🐠" });
    assert.deepEqual(resolveEffort(cfg, "goldfish"), { value: 2, label: "Goldfish", emoji: "🐠" });
    assert.deepEqual(resolveEffort(cfg, "TUNA"), { value: 5, label: "Tuna", image: "assets/effort/tuna.svg" });
    assert.deepEqual(resolveEffort(cfg, 8), { value: 8, label: "Swordfish" });
  });
});

test("resolveEffort rejects unknown labels and out-of-set numbers", () => {
  withRepo(FISH, {}, (root) => {
    const { cfg } = loadConfig(root);
    assert.ok(resolveEffort(cfg, "Kraken").error);
    assert.ok(resolveEffort(cfg, 4).error);
    assert.ok(resolveEffort(cfg, undefined).error);
  });
});

test("the identity scale rejects label aliases", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const { cfg } = loadConfig(root);
    assert.deepEqual(resolveEffort(cfg, 3), { value: 3, label: "3" });
    assert.ok(resolveEffort(cfg, "Trout").error);
  });
});

// ----------------------------------------------------------- readBacklog

test("an active item may carry a label alias; it resolves to the number", () => {
  withRepo(FISH, { active: [{ id: "DEMO0001", title: "T", effort: "Goldfish" }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, []);
    assert.equal(data.active[0].effort, 2);
    assert.equal(data.active[0]._effortLabel, "Goldfish");
  });
});

test("an unresolvable effort on an active item is a validation error", () => {
  withRepo(FISH, { active: [{ id: "DEMO0001", title: "T", effort: "Kraken" }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.ok(data.errors.some((e) => /effort must be a value/.test(e)));
  });
});

// ----------------------------------------------------------- rendering

test("README shows `[emoji ]label · N` under a custom scale, bare N under identity", () => {
  withRepo(FISH, { active: [{ id: "DEMO0001", title: "T", effort: 2 }, { id: "DEMO0002", title: "U", effort: 5 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const { files } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    const readme = files.find((f) => f.path.endsWith("README.md")).content;
    assert.match(readme, /🐠 Goldfish · 2/);
    assert.match(readme, /Tuna · 5/); // image entry: label + number, no image in README
  });
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 2 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const { files } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    const readme = files.find((f) => f.path.endsWith("README.md")).content;
    assert.match(readme, /\| High \| 2 \|/);
    assert.doesNotMatch(readme, /Goldfish/);
  });
});

test("README publishes the milestone tables only — no `Next task ID` section (SPEC §8.1)", () => {
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 2 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    const readme = generateArtifacts(root, cfg, data).files.find((f) => f.path.endsWith("README.md")).content;
    assert.doesNotMatch(readme, /Next task ID/, "the next id is no longer published in the README");
    // It stays canonical in backlog.json (SPEC §8.2) — one active item ⇒ next is DEMO0002.
    assert.equal(JSON.parse(buildBacklogJson(cfg, data)).nextId, "DEMO0002");
  });
});

test("nextIdFloor floors the next organically-assigned id (SPEC §7)", () => {
  // Floor above the current max: the next id jumps to the floor.
  withRepo({ ...ARRAY_CFG, nextIdFloor: 1000 }, { active: [{ id: "DEMO0001", title: "T", effort: 2 }] }, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    const data = readBacklog(root, cfg);
    assert.equal(JSON.parse(buildBacklogJson(cfg, data)).nextId, "DEMO1000", "next id is max(floor, max+1)");
  });
  // Floor below the current max: it never lowers the next id.
  withRepo({ ...ARRAY_CFG, nextIdFloor: 5 }, { active: [{ id: "DEMO0009", title: "T", effort: 2 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.equal(JSON.parse(buildBacklogJson(cfg, data)).nextId, "DEMO0010");
  });
});

test("backlog.json carries effortLabel/emoji/image under a custom scale, nothing under identity", () => {
  withRepo(FISH, { active: [{ id: "DEMO0001", title: "T", effort: 5 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const json = JSON.parse(buildBacklogJson(cfg, readBacklog(root, cfg)));
    assert.equal(json.tasks[0].effort, 5);
    assert.equal(json.tasks[0].effortLabel, "Tuna");
    assert.equal(json.tasks[0].effortImage, "assets/effort/tuna.svg");
    assert.equal("effortEmoji" in json.tasks[0], false);
  });
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 5 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const json = JSON.parse(buildBacklogJson(cfg, readBacklog(root, cfg)));
    assert.equal(json.tasks[0].effort, 5);
    assert.equal("effortLabel" in json.tasks[0], false);
  });
});

test("a closed item resolves best-effort and never fails validation on a stale label", () => {
  withRepo(FISH, {
    completed: [{ id: "DEMO0001", title: "T", effort: 3 }],
    removed: [{ id: "DEMO0002", title: "U", effort: "Kraken" }],
  }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, []); // historical values are not re-validated
    const json = JSON.parse(buildBacklogJson(cfg, data));
    const done = json.tasks.find((t) => t.id === "DEMO0001");
    const gone = json.tasks.find((t) => t.id === "DEMO0002");
    assert.equal(done.effortLabel, "Trout"); // resolves under the current scale
    assert.equal(gone.effort, "Kraken");      // stale label passes through as-is
    assert.equal("effortLabel" in gone, false);
  });
});

test("closed items still require the descriptive metadata (presence, not enum membership)", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    // A completed item that omits the required historical snapshot fields (SPEC §5.1).
    writeFileSync(
      join(root, "trellis", "completed", "tasks", "DEMO0001.md"),
      "---\nid: DEMO0001\ntitle: T\nstatus: completed\ndepends_on: []\ncompleted_on: 2026-01-01\n---\n\nBody.\n",
    );
    const { cfg } = loadConfig(root);
    const errors = readBacklog(root, cfg).errors.join("; ");
    for (const field of ["summary", "milestone", "priority", "effort"]) {
      assert.ok(errors.includes("missing `" + field + "`"), `expected a missing-${field} error in ${errors}`);
    }
  });
});

// ------------------------------------------------------- tasksDir (SPEC §2/§7)

test("a custom tasksDir relocates the task tree while the config home stays fixed", () => {
  // The bootstrap-free decoupling: config is always found at trellis/, then
  // tasksDir (read from it) points the task tree + artifacts elsewhere. Without
  // this test the suite would pass even if paths() ignored cfg.tasksDir.
  const root = mkdtempSync(join(tmpdir(), "trellis-tasksdir-"));
  try {
    // config lives at the FIXED home, NOT under tasksDir
    mkdirSync(join(root, "trellis"), { recursive: true });
    writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify({ ...ARRAY_CFG, tasksDir: "docs/backlog" }, null, 2));
    // task tree + skeletons live under the custom tasksDir
    const tasks = join(root, "docs", "backlog");
    for (const d of ["active", "completed/tasks", "removed"]) mkdirSync(join(tasks, d), { recursive: true });
    writeFileSync(join(tasks, "README.md"), "# Backlog\n\n<!-- BEGIN GENERATED:MILESTONES -->\n<!-- END GENERATED:MILESTONES -->\n");
    writeFileSync(join(tasks, "completed", "index.md"), "# Completed\n\n<!-- BEGIN GENERATED:COMPLETED -->\n<!-- END GENERATED:COMPLETED -->\n");
    writeFileSync(join(tasks, "removed", "index.md"), "# Removed\n\n<!-- BEGIN GENERATED:REMOVED -->\n<!-- END GENERATED:REMOVED -->\n");
    writeFileSync(join(tasks, "active", "DEMO0001.md"), fm({ id: "DEMO0001", title: "T", status: "active", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", effort: 3 }));

    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, [], "config is found at the fixed home and validates");
    assert.equal(cfg.tasksDir, "docs/backlog");

    const p = paths(root, cfg);
    assert.equal(p.config, join(root, "trellis", "backlog.config.json"), "config path is NOT derived from tasksDir");
    assert.equal(p.active, join(root, "docs", "backlog", "active"), "task tree derives from tasksDir");

    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, []);
    assert.equal(data.active.length, 1, "the item under the custom tree is read");
    const { files, errors: gerr } = generateArtifacts(root, cfg, data);
    assert.deepEqual(gerr, []);
    assert.ok(files.every((f) => f.path.startsWith(join(root, "docs", "backlog"))), "every artifact lands under the custom tasksDir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig canonicalizes a tasksDir trailing slash", () => {
  const root = makeRepo({ ...ARRAY_CFG, tasksDir: "docs/backlog/" }, {});
  try {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.equal(cfg.tasksDir, "docs/backlog", "the trailing slash is stripped at the source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tasksDir that escapes the repo (absolute or `..`) is a config error", () => {
  for (const bad of ["/etc/trellis", "../outside", "a/../../b"]) {
    const root = makeRepo({ ...ARRAY_CFG, tasksDir: bad }, {});
    try {
      const { errors } = loadConfig(root);
      assert.ok(errors.some((e) => /tasksDir/.test(e)), `expected ${bad} to be rejected`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// --------------------------------------------- team roster (SPEC §7.2) + ownership

const writeTeam = (root, team) => writeFileSync(join(root, "trellis", "team.json"), JSON.stringify(team, null, 2));

test("loadRoster reads members with a case-insensitive index; absent is an empty roster", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const empty = loadRoster(root);
    assert.deepEqual(empty.errors, []);
    assert.equal(empty.roster.members.length, 0, "absent team.json → empty roster, no error");
  });
  const root = makeRepo(ARRAY_CFG, {});
  try {
    writeTeam(root, { members: [
      { handle: "Alice", name: "Alice A", email: "a@x.io", status: "active" },
      { handle: "bob", name: "Bob B" }, // status omitted → defaults to active
    ] });
    const { roster, errors } = loadRoster(root);
    assert.deepEqual(errors, []);
    assert.equal(roster.members.length, 2);
    assert.equal(roster.byHandle.get("alice").name, "Alice A");
    assert.equal(roster.byHandle.get("alice").email, "a@x.io");
    assert.equal(roster.byHandle.get("bob").status, "active", "status defaults to active");
    assert.equal(findActiveMember(roster, "ALICE").handle, "Alice", "handle match is case-insensitive, returns the canonical handle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadRoster reports duplicate handles, bad status/handle, unknown keys, missing name, wrong shape", () => {
  const cases = [
    [{ members: [{ handle: "a", name: "A" }, { handle: "A", name: "A2" }] }, /duplicate handle/],
    [{ members: [{ handle: "a", name: "A", status: "retired" }] }, /`status` must be "active" or "inactive"/],
    [{ members: [{ handle: "a b", name: "A" }] }, /letters, digits/],
    [{ members: [{ handle: "a", name: "A", role: "lead" }] }, /unknown key `role`/],
    [{ members: [{ handle: "a" }] }, /`name` must be a non-empty string/],
    [{ members: "nope" }, /`members` must be an array/],
    [["a"], /must be an object with a `members` array/],
  ];
  for (const [team, re] of cases) {
    const root = makeRepo(ARRAY_CFG, {});
    try {
      writeTeam(root, team);
      const { errors } = loadRoster(root);
      assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("loadRoster reports malformed JSON, and readBacklog surfaces it (config-class)", () => {
  const root = makeRepo(ARRAY_CFG, {});
  try {
    writeFileSync(join(root, "trellis", "team.json"), "{ not json");
    assert.ok(loadRoster(root).errors.some((e) => /not valid JSON/.test(e)));
    const { cfg } = loadConfig(root);
    assert.ok(readBacklog(root, cfg).errors.some((e) => /not valid JSON/.test(e)), "a broken roster fails the backlog read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const ROSTER = { members: [
  { handle: "alice", name: "Alice", status: "active" },
  { handle: "bob", name: "Bob", status: "active" },
  { handle: "carol", name: "Carol", status: "inactive" },
] };

test("active items validate owner/collaborators against the active roster", () => {
  const ok = makeRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 3, owner: "alice", collaborators: ["bob"] }] });
  try {
    writeTeam(ok, ROSTER);
    const { cfg } = loadConfig(ok);
    assert.deepEqual(readBacklog(ok, cfg).errors, [], "an active owner + collaborator validate");
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }

  const bad = [
    [{ owner: "carol" }, /owner "carol" is not an active roster member/],   // inactive
    [{ owner: "dave" }, /owner "dave" is not an active roster member/],      // unknown
    [{ owner: "alice", collaborators: ["dave"] }, /collaborator "dave" is not an active roster member/],
    [{ owner: "alice", collaborators: ["carol"] }, /collaborator "carol" is not an active roster member/],
  ];
  for (const [extra, re] of bad) {
    const root = makeRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 3, ...extra }] });
    try {
      writeTeam(root, ROSTER);
      const { cfg } = loadConfig(root);
      const errs = readBacklog(root, cfg).errors;
      assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an active owner with no roster at all is an error (can't resolve to an active member)", () => {
  const root = makeRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 3, owner: "alice" }] });
  try {
    const { cfg } = loadConfig(root); // no team.json written
    assert.ok(readBacklog(root, cfg).errors.some((e) => /owner "alice" is not an active roster member/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed items keep historical owner/collaborators without re-validation", () => {
  const root = makeRepo(ARRAY_CFG, {
    completed: [{ id: "DEMO0001", title: "T", owner: "ghost", collaborators: ["alsoGone"] }],
    removed: [{ id: "DEMO0002", title: "U", owner: "carol" }],
  });
  try {
    writeTeam(root, ROSTER);
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, [], "historical owners (gone or inactive) are not re-validated");
    const json = JSON.parse(buildBacklogJson(cfg, data));
    const done = json.tasks.find((t) => t.id === "DEMO0001");
    assert.equal(done.owner, "ghost");
    assert.deepEqual(done.collaborators, ["alsoGone"]);
    assert.equal(json.tasks.find((t) => t.id === "DEMO0002").owner, "carol");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed items reject a non-handle owner/collaborator but allow a valid historical (non-member) handle", () => {
  // Historical values skip roster *membership* (SPEC §8.3) but must still be valid
  // handles (§7.2) — else a hand-authored `owner: Jane Doe` would pass --check.
  const bad = makeRepo(ARRAY_CFG, {
    completed: [{ id: "DEMO0001", title: "T", owner: "Jane Doe" }],
    removed: [{ id: "DEMO0002", title: "U", collaborators: ["Not A Handle"] }],
  });
  try {
    writeTeam(bad, ROSTER);
    const errs = readBacklog(bad, loadConfig(bad).cfg).errors.join("; ");
    assert.ok(/owner "Jane Doe" is not a valid handle/.test(errs), `expected an owner handle error in ${errs}`);
    assert.ok(/collaborator "Not A Handle" is not a valid handle/.test(errs), `expected a collaborator handle error in ${errs}`);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }

  // A valid handle that is not (or no longer) a roster member still validates on a closed item.
  const ok = makeRepo(ARRAY_CFG, { completed: [{ id: "DEMO0001", title: "T", owner: "formerEmployee", collaborators: ["alsoGone"] }] });
  try {
    writeTeam(ok, ROSTER);
    assert.deepEqual(readBacklog(ok, loadConfig(ok).cfg).errors, [], "valid historical handles pass without membership");
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
});

test("backlog.json carries owner/collaborators; README shows an Owner column", () => {
  const root = makeRepo(ARRAY_CFG, {
    active: [
      { id: "DEMO0001", title: "Owned", effort: 3, owner: "alice", collaborators: ["bob"] },
      { id: "DEMO0002", title: "Unowned", effort: 2 },
    ],
  });
  try {
    writeTeam(root, ROSTER);
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, []);
    const json = JSON.parse(buildBacklogJson(cfg, data));
    const owned = json.tasks.find((t) => t.id === "DEMO0001");
    assert.equal(owned.owner, "alice");
    assert.deepEqual(owned.collaborators, ["bob"]);
    const unowned = json.tasks.find((t) => t.id === "DEMO0002");
    assert.equal(unowned.owner, null, "an unowned task carries owner: null");
    assert.deepEqual(unowned.collaborators, [], "and collaborators: []");

    const readme = generateArtifacts(root, cfg, data).files.find((f) => f.path.endsWith("README.md")).content;
    assert.match(readme, /\| ID \| Title \| Owner \| Priority \| Effort \|/, "the Owner column header is present");
    assert.match(readme, /Owned \| alice \|/, "the owner handle renders in the Owner column");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serializeFrontMatter/parseFrontMatter round-trip owner and collaborators", () => {
  const text = composeFile({ id: "DEMO0001", title: "T", status: "active", depends_on: [], owner: "alice", collaborators: ["bob", "carol"] }, "# DEMO0001 — T\n");
  assert.match(text, /^owner: alice$/m);
  assert.match(text, /^collaborators: \[bob, carol\]$/m);
  const parsed = parseFrontMatter(text, "x", []);
  assert.equal(parsed.owner, "alice");
  assert.deepEqual(parsed.collaborators, ["bob", "carol"]);
});

// ------------------------------------------------- id ledger config (TRL0037)

const LEDGER_CFG = { ...ARRAY_CFG, specVersion: "2.5", idAllocation: "ledger" };
const configErrors = (config) => withRepo(config, {}, (root) => loadConfig(root).errors);

test("idAllocation accepts scan and ledger and rejects anything else", () => {
  assert.deepEqual(configErrors({ ...ARRAY_CFG, idAllocation: "scan" }), []);
  assert.deepEqual(configErrors(LEDGER_CFG), []);
  assert.ok(configErrors({ ...ARRAY_CFG, idAllocation: "local" }).some((e) => e.includes("idAllocation")));
});

test("a present idAllocation or idLedgerRef must be valid, so an explicit null is an error", () => {
  assert.ok(configErrors({ ...ARRAY_CFG, idAllocation: null }).some((e) => e.includes("idAllocation")));
  assert.ok(configErrors({ ...LEDGER_CFG, idLedgerRef: null }).some((e) => e.includes("idLedgerRef")));
  assert.deepEqual(configErrors(ARRAY_CFG), [], "an absent key is still the default");
});

test("idLedgerRef must sit under refs/trellis/ and pass the ref-format rules", () => {
  assert.deepEqual(configErrors({ ...LEDGER_CFG, idLedgerRef: "refs/trellis/my-ids" }), []);
  const bad = [
    "refs/heads/ids", "refs/trellis/", "refs/trellis", "refs/trellis/my ids", "refs/trellis/a..b",
    "refs/trellis//a", "refs/trellis/a@{b", "refs/trellis/a~", "refs/trellis/a^", "refs/trellis/a:b",
    "refs/trellis/a?", "refs/trellis/a*", "refs/trellis/a[", "refs/trellis/a\\b", "refs/trellis/a\u007f",
    "refs/trellis/a\tb", "refs/trellis/a/", "refs/trellis/a.", "refs/trellis/.a", "refs/trellis/a.lock/b",
    "", 7,
  ];
  for (const ref of bad) {
    assert.ok(configErrors({ ...LEDGER_CFG, idLedgerRef: ref }).some((e) => e.includes("idLedgerRef")), `rejects ${JSON.stringify(ref)}`);
  }
});

test("ledger mode refuses a tasksDir inside .git; scan mode and lookalikes pass", () => {
  for (const tasksDir of [".git", ".git/trellis", "./.git/x", ".git/", ".GIT", ".Git/x", "./.gIt", ".//.git/refs", "././/.git", ".//.GIT//x"]) {
    assert.ok(configErrors({ ...LEDGER_CFG, tasksDir }).some((e) => e.includes("tasksDir")), `ledger rejects ${tasksDir}`);
  }
  for (const tasksDir of [".github", ".gitx/t", "docs/.git"]) {
    assert.deepEqual(configErrors({ ...LEDGER_CFG, tasksDir }), [], `ledger accepts ${tasksDir}`);
  }
  assert.deepEqual(configErrors({ ...ARRAY_CFG, tasksDir: ".git/t" }), [], "scan mode is unchanged");
});

test("ledger mode checks .git after the trailing-separator cleanup", () => {
  // On POSIX `.git\\` cleans to `.git`; `.git\\archive` is one ordinary folder name there.
  const bad = (tasksDir) => configErrors({ ...LEDGER_CFG, tasksDir }).some((e) => e.includes(".git"));
  assert.equal(bad(".git\\"), true);
  assert.equal(bad(".git/\\"), true);
  assert.equal(bad(".git\\archive"), process.platform === "win32");
});

test("ledger mode reads a backslash in tasksDir by the platform's rules", () => {
  const dir = ".git\\archive";
  const errors = configErrors({ ...LEDGER_CFG, tasksDir: dir }).filter((e) => e.includes(".git"));
  // On POSIX this is one ordinary folder name; on Windows it is a path inside .git.
  assert.equal(errors.length, process.platform === "win32" ? 1 : 0);
});

test("ledger mode needs integer effort values; scan mode keeps fractions", () => {
  for (const effort of [[0.5, 1, 3], { values: [1, 2.5] }, [1, 1e21]]) {
    assert.ok(configErrors({ ...LEDGER_CFG, effort }).some((e) => e.includes("integers")), JSON.stringify(effort));
  }
  assert.deepEqual(configErrors({ ...LEDGER_CFG, effort: [1, 2, 3] }), []);
  assert.deepEqual(configErrors({ ...ARRAY_CFG, effort: [0.5, 1, 3] }), []);
});

test("branchNameProblem applies the full refs/heads rules", () => {
  for (const name of ["@", "/lane", "lane/", "-x", "a//b", "a..b", "x.lock", "bad name", ""]) {
    assert.ok(branchNameProblem(name), JSON.stringify(name));
  }
  for (const name of ["main", "feature/x-1", "je/trl0037/slug"]) assert.equal(branchNameProblem(name), null, name);
});

test("ledger mode renders effort text on one line, so it cannot form a marker line", () => {
  const scale = (label, emoji) => ({
    ...LEDGER_CFG,
    effort: { values: [1, 2, 3], scale: "s", scales: { s: { 1: { label, emoji }, 2: { label: "Two" }, 3: { label: "Three" } } } },
  });
  const cfgOver = scale("Small\n<!-- END GENERATED:MILESTONES -->\r\nmore", "\u2028<!-- END GENERATED:MILESTONES -->");
  withRepo(cfgOver, { active: [{ id: "DEMO0001", title: "One", effort: 1 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    const { files, errors } = generateArtifacts(root, cfg, data);
    assert.deepEqual(errors, []);
    const readme = files.find((f) => f.path === paths(root, cfg).readme).content;
    const markerLines = readme.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => l.trim() === "<!-- END GENERATED:MILESTONES -->");
    assert.equal(markerLines.length, 1, "only the real end marker is a line");
    writeFileSync(paths(root, cfg).readme, readme);
    const again = generateArtifacts(root, cfg, readBacklog(root, cfg));
    assert.equal(again.files.find((f) => f.path === paths(root, cfg).readme).content, readme, "regenerates identically");
  });
});

test("ledger mode accepts trailing spaces and tabs on delimiter lines", () => {
  withRepo(LEDGER_CFG, { active: [{ id: "DEMO0001", title: "One", effort: 3 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const file = paths(root, cfg).readme;
    writeFileSync(file, "# Backlog\n\n<!-- BEGIN GENERATED:MILESTONES --> \t\nold\n<!-- END GENERATED:MILESTONES -->  \n");
    const { files, errors } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(errors, []);
    assert.match(files.find((f) => f.path === file).content, /DEMO0001/);
  });
});

test("ledger mode caps idWidth at 9", () => {
  assert.deepEqual(configErrors({ ...LEDGER_CFG, idWidth: 9 }), []);
  assert.ok(configErrors({ ...LEDGER_CFG, idWidth: 10 }).some((e) => e.includes("idWidth")));
  assert.deepEqual(configErrors({ ...ARRAY_CFG, idWidth: 10 }), [], "scan mode keeps any width");
});

test("ledger mode needs a plain prefix; scan mode accepts the same prefixes", () => {
  for (const idPrefix of ["A,B", " A", "R+", "A.B", "1A", "A-B", "A/B", "A\tB"]) {
    assert.ok(configErrors({ ...LEDGER_CFG, idPrefix }).some((e) => e.includes("idPrefix")), `ledger rejects ${JSON.stringify(idPrefix)}`);
    assert.deepEqual(configErrors({ ...ARRAY_CFG, idPrefix }), [], `scan accepts ${JSON.stringify(idPrefix)}`);
  }
  assert.deepEqual(configErrors({ ...LEDGER_CFG, idPrefix: "Ab9" }), []);
});

test("a scan backlog configured with R+ still checks RR0001.md", () => {
  withRepo({ ...ARRAY_CFG, idPrefix: "R+" }, { active: [{ id: "RR0001", title: "Regex quirk", effort: 3 }] }, (root) => {
    const { cfg, errors } = loadConfig(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(readBacklog(root, cfg).errors, []);
  });
});

// Run the real check CLI with PATH replaced, so any git call is observable or fails.
const CHECK_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "backlog-readme.mjs");
function runCheck(root, pathDir) {
  return spawnSync(process.execPath, [CHECK_CLI, "--check", "--target", root], {
    encoding: "utf8",
    env: { PATH: pathDir, HOME: root },
  });
}

function ledgerCheckRepo() {
  const root = makeRepo({ ...LEDGER_CFG, idLedgerRef: "refs/trellis/ids" }, { active: [{ id: "DEMO0001", title: "One", effort: 3 }] });
  // `generate` once so the check has current artifacts to compare.
  const { cfg } = loadConfig(root);
  const { files } = generateArtifacts(root, cfg, readBacklog(root, cfg));
  for (const f of files) writeFileSync(f.path, f.content);
  return root;
}

test("check passes in ledger mode with git unavailable", () => {
  const root = ledgerCheckRepo();
  const empty = mkdtempSync(join(tmpdir(), "trellis-nopath-"));
  try {
    const r = runCheck(root, empty);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("check never calls git in ledger mode", { skip: process.platform === "win32" }, () => {
  const root = ledgerCheckRepo();
  const shimDir = mkdtempSync(join(tmpdir(), "trellis-shim-"));
  const log = join(shimDir, "calls.log");
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  try {
    const r = runCheck(root, shimDir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", "", "no git invocation");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------ nextIdOverride hook (TRL0037)

test("nextIdOverride: undefined computes the scan value, null and strings are emitted as given", () => {
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0002", title: "Two", effort: 3 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    const json = (opts) => JSON.parse(buildBacklogJson(cfg, data, opts));
    assert.equal(buildBacklogJson(cfg, data), buildBacklogJson(cfg, data, {}), "default output is unchanged");
    assert.equal(buildBacklogJson(cfg, data), buildBacklogJson(cfg, data, { nextIdOverride: undefined }));
    assert.equal(json().nextId, "DEMO0003");
    assert.equal(json({ nextIdOverride: null }).nextId, null);
    assert.equal(json({ nextIdOverride: "DEMO0042" }).nextId, "DEMO0042");

    const plain = generateArtifacts(root, cfg, data);
    assert.equal(plain.nextId, "DEMO0003");
    const nulled = generateArtifacts(root, cfg, data, { nextIdOverride: null });
    assert.equal(nulled.nextId, null);
    const file = (r) => r.files.find((f) => f.path.endsWith("backlog.json")).content;
    assert.equal(JSON.parse(file(nulled)).nextId, null);
    assert.equal(file(plain), file(generateArtifacts(root, cfg, data, { nextIdOverride: undefined })));
    // Only backlog.json carries the next id.
    assert.deepEqual(plain.files.filter((f) => !f.path.endsWith("backlog.json")), nulled.files.filter((f) => !f.path.endsWith("backlog.json")));
  });
});

// ------------------------------------------ local generated artifacts (TRL0038)

const LOCAL_CFG = { ...ARRAY_CFG, specVersion: "2.5", milestones: ["Alpha", "Beta"], generatedArtifacts: "local" };
const ITEMS = {
  active: [
    { id: "DEMO0001", title: "First | pipe", effort: 3 },
    { id: "DEMO0002", title: "Second", effort: 5, milestone: "Beta", priority: "Low", depends_on: ["DEMO0001"] },
  ],
  completed: [{ id: "DEMO0003", title: "Done", effort: 2, summary: "Did it.", completed_on: "2026-01-02" }],
  removed: [{ id: "DEMO0004", title: "Gone", effort: 1, summary: "Dropped.", removed_on: "2026-01-03", removed_reason: "No longer needed." }],
};

// A local-mode repo: the committed README and index files are plain author text.
function makeLocalRepo(config = LOCAL_CFG, items = ITEMS) {
  const root = makeRepo(config, items);
  const tasks = join(root, "trellis");
  writeFileSync(join(tasks, "README.md"), "# Backlog\n\nAuthored prose.\n");
  writeFileSync(join(tasks, "completed", "index.md"), "# Completed\n\nAuthored notes.\n");
  writeFileSync(join(tasks, "removed", "index.md"), "# Removed\n");
  return root;
}
const withLocalRepo = (fn, config, items) => {
  const root = makeLocalRepo(config, items);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("generatedArtifacts: only committed or local is accepted, and null is not", () => {
  for (const good of ["committed", "local"]) {
    withRepo({ ...ARRAY_CFG, generatedArtifacts: good }, {}, (root) => assert.deepEqual(loadConfig(root).errors, []));
  }
  withRepo(ARRAY_CFG, {}, (root) => assert.deepEqual(loadConfig(root).errors, []));
  for (const bad of ["Local", "", null, true, 1, ["local"]]) {
    withRepo({ ...ARRAY_CFG, generatedArtifacts: bad }, {}, (root) => {
      assert.match(loadConfig(root).errors.join("\n"), /`generatedArtifacts` must be "committed" or "local"/, JSON.stringify(bad));
    });
  }
});

test("local mode requires an ASCII tasksDir; committed mode does not", () => {
  const unicode = ["planning", "r\u00e9sum\u00e9", "\u212a/backlog"];
  withRepo({ ...ARRAY_CFG, generatedArtifacts: "local", tasksDir: unicode[1] }, {}, (root) => {
    assert.match(loadConfig(root).errors.join("\n"), /`tasksDir` must be ASCII when `generatedArtifacts` is "local"/);
  });
  withRepo({ ...ARRAY_CFG, generatedArtifacts: "local", tasksDir: unicode[2] }, {}, (root) => {
    assert.match(loadConfig(root).errors.join("\n"), /must be ASCII/);
  });
  withRepo({ ...ARRAY_CFG, generatedArtifacts: "local", tasksDir: "docs/plan" }, {}, (root) => assert.deepEqual(loadConfig(root).errors, []));
  withRepo({ ...ARRAY_CFG, generatedArtifacts: "committed", tasksDir: unicode[1] }, {}, (root) => assert.deepEqual(loadConfig(root).errors, []));
});

test("committed output is byte-identical to the pinned fixture", () => {
  const cfg = { ...ARRAY_CFG, milestones: ["Alpha", "Beta"], effort: [1, 2, 3, 5] };
  withRepo(cfg, ITEMS, (root) => {
    const loaded = loadConfig(root).cfg;
    const { files, errors } = generateArtifacts(root, loaded, readBacklog(root, loaded));
    assert.deepEqual(errors, []);
    const rel = (f) => f.path.slice(root.length + 1).split(sep).join("/");
    assert.deepEqual(files.map(rel), ["trellis/README.md", "trellis/completed/index.md", "trellis/removed/index.md", "trellis/backlog.json"]);
    assert.equal(files[0].content, `# Backlog

<!-- BEGIN GENERATED:MILESTONES -->

### Alpha

| ID | Title | Owner | Priority | Effort |
| --- | --- | --- | --- | --- |
| [DEMO0001](active/DEMO0001.md) | First \\| pipe |  | High | 3 |

### Beta

| ID | Title | Owner | Priority | Effort |
| --- | --- | --- | --- | --- |
| [DEMO0002](active/DEMO0002.md) | Second |  | Low | 5 |

<!-- END GENERATED:MILESTONES -->
`);
    assert.equal(files[1].content, `# Completed

<!-- BEGIN GENERATED:COMPLETED -->
| ID | Title | Summary | Completed |
| --- | --- | --- | --- |
| [DEMO0003](tasks/DEMO0003.md) | Done | Did it. | 2026-01-02 |
<!-- END GENERATED:COMPLETED -->
`);
    assert.equal(files[2].content, `# Removed

<!-- BEGIN GENERATED:REMOVED -->
| ID | Title | Summary | Removed | Reason |
| --- | --- | --- | --- | --- |
| [DEMO0004](DEMO0004.md) | Gone | Dropped. | 2026-01-03 | No longer needed. |
<!-- END GENERATED:REMOVED -->
`);
    const json = JSON.parse(files[3].content);
    assert.equal(json.nextId, "DEMO0005");
    assert.deepEqual(json.counts, { active: 2, completed: 1, removed: 1 });
    assert.equal(files[3].content, buildBacklogJson(loaded, readBacklog(root, loaded)));
  });
});

test("artifactSet names the four files per mode and the author-owned files in local mode", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const set = artifactSet(root, loadConfig(root).cfg);
    assert.equal(set.mode, "committed");
    assert.deepEqual(set.generated.map((e) => e.rel.split(sep).join("/")), ["trellis/README.md", "trellis/completed/index.md", "trellis/removed/index.md", "trellis/backlog.json"]);
    assert.deepEqual(set.authorOwned, []);
  });
  withLocalRepo((root) => {
    const set = artifactSet(root, loadConfig(root).cfg);
    assert.equal(set.mode, "local");
    assert.deepEqual(set.generated.map((e) => e.rel.split(sep).join("/")), [
      "trellis/.generated/index.md", "trellis/.generated/completed.md", "trellis/.generated/removed.md", "trellis/.generated/backlog.json",
    ]);
    assert.deepEqual(set.authorOwned.map((e) => e.rel.split(sep).join("/")), ["trellis/README.md", "trellis/completed/index.md", "trellis/removed/index.md"]);
    assert.equal(set.dir, join(root, "trellis", ".generated"));
  });
});

test("local output has four files under .generated/ with headings and links that resolve", () => {
  withLocalRepo((root) => {
    const { cfg, errors: cfgErrors } = loadConfig(root);
    assert.deepEqual(cfgErrors, []);
    const { files, errors } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(errors, []);
    const dir = join(root, "trellis", ".generated");
    assert.deepEqual(files.map((f) => f.path), ["index.md", "completed.md", "removed.md", "backlog.json"].map((n) => join(dir, n)));
    const byName = Object.fromEntries(files.map((f) => [f.path.slice(dir.length + 1), f.content]));
    assert.match(byName["index.md"], /^# Backlog\n/);
    assert.match(byName["completed.md"], /^# Completed tasks\n/);
    assert.match(byName["removed.md"], /^# Removed tasks\n/);
    assert.match(byName["index.md"], /### Alpha/);
    assert.match(byName["index.md"], /### Beta/);
    // No generated Markdown file carries a marker, and every link resolves from .generated/.
    let links = 0;
    for (const name of ["index.md", "completed.md", "removed.md"]) {
      assert.doesNotMatch(byName[name], /GENERATED:/, name);
      for (const m of byName[name].matchAll(/\]\((\.\.\/[^)]+)\)/g)) {
        links++;
        assert.ok(existsSync(join(dir, m[1])), `${name} links to ${m[1]}`);
      }
    }
    assert.equal(links, 4);
    assert.equal(byName["index.md"].includes("](active/"), false, "no committed-style link");
  });
});

test("local generation reads no file and ignores a missing README", () => {
  withLocalRepo((root) => {
    rmSync(join(root, "trellis", "README.md"));
    rmSync(join(root, "trellis", "completed", "index.md"));
    rmSync(join(root, "trellis", "removed", "index.md"));
    const { cfg } = loadConfig(root);
    const { errors } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(errors, []);
  });
});

test("local backlog.json holds a given nextIdOverride, null included", () => {
  withLocalRepo((root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    const json = (opts) => JSON.parse(generateArtifacts(root, cfg, data, opts).files.find((f) => f.path.endsWith("backlog.json")).content);
    assert.equal(json().nextId, "DEMO0005");
    assert.equal(json({ nextIdOverride: null }).nextId, null);
    assert.equal(json({ nextIdOverride: "DEMO0042" }).nextId, "DEMO0042");
    assert.equal(generateArtifacts(root, cfg, data, { nextIdOverride: null }).nextId, null);
  });
});

const SIX_MARKERS = [
  "<!-- BEGIN GENERATED:MILESTONES -->", "<!-- END GENERATED:MILESTONES -->",
  "<!-- BEGIN GENERATED:COMPLETED -->", "<!-- END GENERATED:COMPLETED -->",
  "<!-- BEGIN GENERATED:REMOVED -->", "<!-- END GENERATED:REMOVED -->",
];

test("the marker scan fails on each of the six marker lines, in any author-owned file", () => {
  withLocalRepo((root) => {
    const { cfg } = loadConfig(root);
    const files = [join(root, "trellis", "README.md"), join(root, "trellis", "completed", "index.md"), join(root, "trellis", "removed", "index.md")];
    assert.deepEqual(markerLineErrors(root, cfg), []);
    SIX_MARKERS.forEach((marker, i) => {
      const file = files[i % 3];
      const original = readFileSync(file, "utf8");
      for (const tail of ["", " ", "\t", "\r"]) {
        writeFileSync(file, `${original}\n${marker}${tail}\nmore\n`);
        const errors = markerLineErrors(root, cfg);
        assert.equal(errors.length, 1, `${marker} + ${JSON.stringify(tail)}`);
        assert.ok(errors[0].includes(marker));
        assert.ok(errors[0].startsWith(file.slice(root.length + 1)), "names the file");
      }
      writeFileSync(file, original);
    });
  });
});

test("the marker scan reports a FIFO README without reading it", { skip: process.platform === "win32" }, () => {
  withLocalRepo((root) => {
    const { cfg } = loadConfig(root);
    const readme = join(root, "trellis", "README.md");
    rmSync(readme);
    execFileSync("mkfifo", [readme]);
    const errors = markerLineErrors(root, cfg);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^trellis\/README\.md: cannot read/);
  });
});

test("the marker scan passes on prose that names a marker", () => {
  withLocalRepo((root) => {
    const { cfg } = loadConfig(root);
    writeFileSync(join(root, "trellis", "README.md"), [
      "# Backlog", "", "Do not leave <!-- BEGIN GENERATED:MILESTONES --> in this file.", "    <!-- END GENERATED:MILESTONES -->", "`<!-- BEGIN GENERATED:COMPLETED -->`", "",
    ].join("\n"));
    assert.deepEqual(markerLineErrors(root, cfg), []);
  });
});

test("checkGenerated returns no files in local mode and the compare set in committed mode", () => {
  withLocalRepo((root) => {
    const { cfg } = loadConfig(root);
    const out = checkGenerated(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(out, { errors: [], files: [] });
  });
  withRepo(ARRAY_CFG, {}, (root) => {
    const { cfg } = loadConfig(root);
    const out = checkGenerated(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(out.errors, []);
    assert.equal(out.files.length, 4);
  });
});

test("the local validation entry point orders roster, item and marker errors with no early exit", () => {
  withLocalRepo((root) => {
    // A malformed item and a stray marker, plus a malformed roster.
    writeFileSync(join(root, "trellis", "active", "DEMO0001.md"), fm({ id: "DEMO0001", title: "T", status: "active", depends_on: [], summary: "S.", milestone: "Nope", priority: "High", effort: 3 }));
    writeFileSync(join(root, "trellis", "README.md"), `# Backlog\n\n${SIX_MARKERS[0]}\n`);
    writeFileSync(join(root, "trellis", "team.json"), JSON.stringify({ members: "x" }));
    const { cfg } = loadConfig(root);
    const { errors } = validateLocal(root, cfg);
    assert.equal(errors.length, 3, errors.join("\n"));
    assert.match(errors[0], /team\.json/);
    assert.match(errors[1], /active\/DEMO0001\.md: milestone must be one of/);
    assert.match(errors[2], /README\.md: holds the generated marker line/);
  });
});

// ---------------------------------------------------------- legacy config (TRL0039)
const LEGACY = { through: "DEMO0010", closedBefore: "2026-11-19" };
const withLegacy = (legacy, extra = {}) => ({ ...ARRAY_CFG, legacy, ...extra });

test("a valid legacy loads with no errors, and with ledger mode", () => {
  assert.deepEqual(configErrors(withLegacy(LEGACY)), []);
  assert.deepEqual(configErrors({ ...LEDGER_CFG, legacy: LEGACY }), []);
});

test("legacy.through must be a full id in the repo's format", () => {
  const bad = ["TRL0010", "DEMO010", "DEMO00010", "DEMO00x0", "DEMO", "", 5, null, undefined];
  for (const through of bad) {
    assert.ok(configErrors(withLegacy({ ...LEGACY, through })).some((e) => e.includes("through")), JSON.stringify(through));
  }
  // The remainder must be digits only, even under a longer prefix such as TR.
  const errs = configErrors({ ...ARRAY_CFG, idPrefix: "TR", idWidth: 5, legacy: { ...LEGACY, through: "TRL0038" } });
  assert.ok(errs.some((e) => e.includes("through")));
});

test("legacy.closedBefore must be a real date string", () => {
  for (const closedBefore of ["2026-02-31", "2026-13-01", "11/19/2026", "", 20261119, null, undefined, { toString: null }]) {
    assert.ok(configErrors(withLegacy({ ...LEGACY, closedBefore })).some((e) => e.includes("closedBefore")), JSON.stringify(closedBefore));
  }
});

test("legacy rejects extra keys, null, and non-objects", () => {
  assert.ok(configErrors(withLegacy({ ...LEGACY, extra: 1 })).some((e) => e.includes("unknown key")));
  for (const legacy of [null, [], "x", 3]) {
    assert.ok(configErrors(withLegacy(legacy)).some((e) => e.includes("`legacy`")), JSON.stringify(legacy));
  }
});

test("legacy needs a plain prefix; without legacy the same prefix behaves as today", () => {
  for (const idPrefix of ["T.P", "T+P"]) {
    const legacy = { through: `${idPrefix}0010`, closedBefore: "2026-11-19" };
    assert.ok(configErrors({ ...ARRAY_CFG, idPrefix, legacy }).some((e) => e.includes("idPrefix")), idPrefix);
    assert.ok(configErrors({ ...LEDGER_CFG, idPrefix, legacy }).length > 0, `ledger ${idPrefix}`);
    assert.deepEqual(configErrors({ ...ARRAY_CFG, idPrefix }), [], `no legacy ${idPrefix}`);
  }
});

test("legacy with a bad idPrefix or idWidth reports only the existing error and does not throw", () => {
  for (const idPrefix of [5, ""]) {
    const errs = configErrors({ ...ARRAY_CFG, idPrefix, legacy: LEGACY });
    assert.ok(errs.some((e) => e.includes("idPrefix")));
    assert.equal(errs.filter((e) => e.includes("idPrefix")).length, 1);
  }
  assert.ok(configErrors({ ...ARRAY_CFG, idWidth: 0, legacy: LEGACY }).some((e) => e.includes("idWidth")));
});

// ------------------------------------------------ legacy validation (TRL0039)
const LEGACY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-adoption");
const TAP_CFG = { ...FISH, idPrefix: "TAP", legacy: { through: "TAP0004", closedBefore: "2026-11-19" } };
const MISSING_FOUR = ["summary", "milestone", "priority", "effort"].map((f) => `missing \`${f}\``);

// A repo for TAP_CFG holding only the committed fixture files.
function legacyRoot(config = TAP_CFG, { fixture = true } = {}) {
  const root = makeRepo(config, {});
  if (fixture) cpSync(LEGACY_FIXTURE, join(root, "trellis"), { recursive: true });
  return root;
}

// Write one item file by hand: an undefined field is omitted, and values are raw
// front-matter text, so a blank is passed as `'""'` or `'"   "'`.
function putItem(root, folder, id, fields) {
  const base = { id, title: "T", status: folder === "removed" ? "removed" : "completed", depends_on: "[]" };
  const all = { ...base, ...fields };
  const text = Object.entries(all).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n");
  const dir = folder === "active" ? "active" : folder === "removed" ? "removed" : join("completed", "tasks");
  writeFileSync(join(root, "trellis", dir, `${id}.md`), `---\n${text}\n---\n\nBody.\n`);
}
const FULL = { summary: "S.", milestone: "Alpha", priority: "High", effort: 3 };
const closed = (folder, date, extra = {}) => ({ [folder === "removed" ? "removed_on" : "completed_on"]: date, ...(folder === "removed" ? { removed_reason: "R." } : {}), ...extra });

function legacyRead(root) {
  const { cfg, errors } = loadConfig(root);
  assert.deepEqual(errors, []);
  return { cfg, data: readBacklog(root, cfg) };
}
const legacyErrors = (root) => legacyRead(root).data.errors;
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test("legacy fixture items validate, emit null, and render empty Summary cells", () => {
  const root = legacyRoot();
  try {
    const { cfg, data } = legacyRead(root);
    assert.deepEqual(data.errors, []);
    const json = JSON.parse(buildBacklogJson(cfg, data));
    for (const t of json.tasks) {
      for (const k of ["summary", "milestone", "priority", "effort"]) assert.equal(t[k], null, `${t.id} ${k}`);
      for (const k of ["effortLabel", "effortEmoji", "effortImage"]) assert.equal(k in t, false, `${t.id} ${k}`);
    }
    const { files } = generateArtifacts(root, cfg, data);
    const done = files.find((f) => f.path === paths(root, cfg).completedIndex).content;
    const gone = files.find((f) => f.path === paths(root, cfg).removedIndex).content;
    assert.match(done, /\| \[TAP0002\]\(tasks\/TAP0002\.md\) \| Old completed item \|  \| 2026-06-01 \|/);
    assert.match(done, /\| \[TAP0003\]\(tasks\/TAP0003\.md\) \| Old completed item with blank fields \|  \| 2026-06-01 \|/);
    assert.match(gone, /\| Old removed item \|  \| 2026-06-01 \| Superseded before adoption\. \|/);
  } finally { cleanup(root); }
});

test("a completed item at through validates with the fields omitted, and with them blank", () => {
  for (const fields of [{}, { summary: '""', milestone: '""', priority: '"   "', effort: '""' }]) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, "completed", "TAP0004", closed("completed", "2026-06-01", fields));
      const { cfg, data } = legacyRead(root);
      assert.deepEqual(data.errors, []);
      const t = JSON.parse(buildBacklogJson(cfg, data)).tasks[0];
      assert.deepEqual([t.summary, t.milestone, t.priority, t.effort], [null, null, null, null]);
    } finally { cleanup(root); }
  }
});

test("a qualifying item mixing blank and populated fields keeps the populated ones", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    putItem(root, "completed", "TAP0002", closed("completed", "2026-06-01", { summary: "Kept.", milestone: '""', priority: "High", effort: '"  "' }));
    const { cfg, data } = legacyRead(root);
    assert.deepEqual(data.errors, []);
    const t = JSON.parse(buildBacklogJson(cfg, data)).tasks[0];
    assert.deepEqual([t.summary, t.milestone, t.priority, t.effort], ["Kept.", null, "High", null]);
    const { files } = generateArtifacts(root, cfg, data);
    const done = files.find((f) => f.path === paths(root, cfg).completedIndex).content;
    assert.match(done, /\| \[TAP0002\]\(tasks\/TAP0002\.md\) \| T \| Kept\. \| 2026-06-01 \|/);
  } finally { cleanup(root); }
});

test("an item above through, or closed on the adoption date, fails with today's messages", () => {
  const cases = [
    ["completed", "TAP0005", "2026-06-01"],
    ["completed", "TAP0002", "2026-11-19"],
    ["removed", "TAP0004", "2026-11-19"],
    ["removed", "TAP0005", "2026-06-01"],
  ];
  for (const [folder, id, date] of cases) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, folder, id, closed(folder, date));
      const errs = legacyErrors(root).join("\n");
      for (const m of MISSING_FOUR) assert.ok(errs.includes(m), `${folder} ${id} ${date}: ${m}`);
    } finally { cleanup(root); }
  }
});

test("a qualifying item the day before closedBefore validates, completed or removed", () => {
  for (const folder of ["completed", "removed"]) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, folder, "TAP0004", closed(folder, "2026-11-18"));
      assert.deepEqual(legacyErrors(root), [], folder);
    } finally { cleanup(root); }
  }
});

test("legacy still enforces removed_reason, depends_on, id and status", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    putItem(root, "removed", "TAP0004", { removed_on: "2026-06-01" });
    assert.ok(legacyErrors(root).some((e) => e.includes("removed_reason")));
    putItem(root, "removed", "TAP0004", closed("removed", "2026-06-01", { depends_on: undefined }));
    assert.ok(legacyErrors(root).some((e) => e.includes("depends_on")));
    putItem(root, "removed", "TAP0004", closed("removed", "2026-06-01", { id: undefined, status: "active" }));
    const errs = legacyErrors(root).join("\n");
    assert.match(errs, /missing `id`/);
    assert.match(errs, /`status` must be "removed"/);
  } finally { cleanup(root); }
});

test("with legacy, an impossible close date is an item error; without it only the shape is checked", () => {
  for (const folder of ["completed", "removed"]) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, folder, "TAP0005", closed(folder, "2026-02-31", FULL));
      assert.ok(legacyErrors(root).some((e) => e.includes("real calendar date")), folder);
      putItem(root, folder, "TAP0004", closed(folder, "2026-02-31"));
      assert.ok(legacyErrors(root).some((e) => e.includes("TAP0004") && e.includes("real calendar date")), `${folder} qualifying`);
    } finally { cleanup(root); }
    const { legacy, ...noLegacy } = TAP_CFG;
    const plain = legacyRoot(noLegacy, { fixture: false });
    try {
      putItem(plain, folder, "TAP0005", closed(folder, "2026-02-31", FULL));
      assert.deepEqual(legacyErrors(plain), [], `${folder} without legacy`);
    } finally { cleanup(plain); }
  }
});

for (const folder of ["completed", "removed"]) {
  for (const field of ["summary", "milestone", "priority", "effort"]) {
    for (const blank of ['""', '"   "']) {
      test(`a ${blank} ${field} on a non-qualifying ${folder} item: missing with legacy, as today without`, () => {
        const item = closed(folder, "2026-06-01", { ...FULL, [field]: blank });
        const withLegacyRoot = legacyRoot(TAP_CFG, { fixture: false });
        const { legacy, ...noLegacy } = TAP_CFG;
        const plain = legacyRoot(noLegacy, { fixture: false });
        try {
          putItem(withLegacyRoot, folder, "TAP0005", item);
          assert.ok(legacyErrors(withLegacyRoot).some((e) => e.includes(`missing \`${field}\``)));
          putItem(plain, folder, "TAP0005", item);
          // Today `"   "` is a present value and `""` is missing.
          assert.equal(legacyErrors(plain).some((e) => e.includes(`missing \`${field}\``)), blank === '""');
        } finally { cleanup(withLegacyRoot); cleanup(plain); }
      });
    }
  }
}

test("a numeric effort or summary never throws the blank test", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    putItem(root, "completed", "TAP0005", closed("completed", "2026-06-01", { ...FULL, summary: 0, effort: 5 }));
    assert.ok(legacyErrors(root).some((e) => e.includes("missing `summary`")), "summary: 0 is still missing, as today");
  } finally { cleanup(root); }
});

test("a qualifying removed item with blank fields emits null", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    putItem(root, "removed", "TAP0003", closed("removed", "2026-06-01", { summary: '""', milestone: '"   "', priority: '""', effort: '""' }));
    const { cfg, data } = legacyRead(root);
    assert.deepEqual(data.errors, []);
    const t = JSON.parse(buildBacklogJson(cfg, data)).tasks[0];
    assert.deepEqual([t.summary, t.milestone, t.priority, t.effort], [null, null, null, null]);
  } finally { cleanup(root); }
});

test("the blank rule is for closed items only: active items validate as today", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    const active = { id: "TAP0003", title: "T", status: "active", depends_on: "[]", ...FULL };
    for (const field of ["summary", "milestone", "priority"]) {
      for (const v of [undefined, '""']) {
        putItem(root, "active", "TAP0003", { ...active, [field]: v });
        assert.ok(legacyErrors(root).length > 0, `${field} ${v}`);
      }
    }
    putItem(root, "active", "TAP0003", { ...active, summary: '"   "' });
    assert.deepEqual(legacyErrors(root), []);
  } finally { cleanup(root); }
});

test("a qualifying item with an archived _effortLabel and a blank or missing effort emits no effortLabel", () => {
  for (const effort of ['""', undefined]) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, "completed", "TAP0002", closed("completed", "2026-06-01", { effort, _effortLabel: "Trout" }));
      const { cfg, data } = legacyRead(root);
      assert.deepEqual(data.errors, []);
      const t = JSON.parse(buildBacklogJson(cfg, data)).tasks[0];
      assert.equal("effortLabel" in t, false);
    } finally { cleanup(root); }
  }
});

test("through compares ids lexically, so ids past 2^53 do not collapse", () => {
  const cfg = { ...TAP_CFG, idWidth: 16, legacy: { through: "TAP9007199254740992", closedBefore: "2026-11-19" } };
  const root = legacyRoot(cfg, { fixture: false });
  try {
    putItem(root, "completed", "TAP9007199254740992", closed("completed", "2026-06-01"));
    assert.deepEqual(legacyErrors(root), []);
    putItem(root, "completed", "TAP9007199254740993", closed("completed", "2026-06-01"));
    const errs = legacyErrors(root);
    assert.ok(errs.every((e) => e.includes("TAP9007199254740993")));
    assert.ok(errs.some((e) => e.includes("missing `summary`")));
  } finally { cleanup(root); }
});

test("a scan-mode repo without legacy renders a $& title literally", () => {
  withRepo(ARRAY_CFG, { completed: [{ id: "DEMO0001", title: "Explain $&", effort: 3 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const { files, errors } = generateArtifacts(root, cfg, readBacklog(root, cfg));
    assert.deepEqual(errors, []);
    const index = files.find((f) => f.path === paths(root, cfg).completedIndex).content;
    assert.match(index, /\| Explain \$& \|/);
    assert.equal(index.split("BEGIN GENERATED:COMPLETED").length, 2);
  });
});

test("a qualifying item with a retired effort label and an old _effortLabel keeps the value and emits no display fields", () => {
  const root = legacyRoot(TAP_CFG, { fixture: false });
  try {
    putItem(root, "completed", "TAP0002", closed("completed", "2026-06-01", { ...FULL, effort: "Kraken", _effortLabel: "Trout" }));
    const { cfg, data } = legacyRead(root);
    assert.deepEqual(data.errors, []);
    const t = JSON.parse(buildBacklogJson(cfg, data)).tasks[0];
    assert.equal(t.effort, "Kraken");
    for (const k of ["effortLabel", "effortEmoji", "effortImage"]) assert.equal(k in t, false, k);
  } finally { cleanup(root); }
});

test("summary: 0 still fails on a qualifying item and on a non-qualifying one in a legacy repo", () => {
  for (const id of ["TAP0002", "TAP0005"]) {
    const root = legacyRoot(TAP_CFG, { fixture: false });
    try {
      putItem(root, "completed", id, closed("completed", "2026-06-01", { ...FULL, summary: 0 }));
      assert.ok(legacyErrors(root).some((e) => e.includes("missing `summary`")), id);
    } finally { cleanup(root); }
  }
});

// ------------------------------------------- reading seams (TRL0005)

test("a config whose JSON root is not an object is a config error, not a throw", () => {
  for (const raw of [null, [], 3, "x"]) {
    const root = mkdtempSync(join(tmpdir(), "trellis-backlog-"));
    try {
      mkdirSync(join(root, "trellis"), { recursive: true });
      writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(raw));
      const { cfg, errors } = loadConfig(root);
      assert.equal(cfg, null);
      assert.ok(errors.some((e) => e.includes("JSON object")), JSON.stringify(raw));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  assert.ok(validateConfig(null).errors.length > 0);
});

test("a scan idPrefix that does not compile is a config error, while R+ still loads", () => {
  for (const idPrefix of ["[", "R[", "(", "*"]) {
    assert.ok(configErrors({ ...ARRAY_CFG, idPrefix }).some((e) => e.includes("idPrefix")), idPrefix);
  }
  assert.deepEqual(configErrors({ ...ARRAY_CFG, idPrefix: "R+" }), []);
});

test("the default seams read the files as before and add skipped and configErrors", () => {
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "T", effort: 3 }] }, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.deepEqual(data.errors, []);
    assert.deepEqual(data.skipped, []);
    assert.deepEqual(data.configErrors, []);
    assert.deepEqual(data.active.map((a) => a._file), ["DEMO0001.md"]);
    assert.deepEqual([...data.ids], ["DEMO0001"]);
  });
});

test("an absent team.json is an empty roster, a skipped one is a roster error; same for the config", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    assert.deepEqual(loadRoster(root).errors, []);
    assert.deepEqual(loadRoster(root, { readText: () => null }).errors, []);
    const skippedRoster = loadRoster(root, { readText: () => ({ skip: "not a regular file" }) });
    assert.deepEqual(skippedRoster.errors, ["team.json was skipped (not a regular file)"]);
    assert.equal(skippedRoster.roster.members.length, 0);

    assert.deepEqual(loadConfig(root, { readText: () => null }).errors, ["missing backlog.config.json"]);
    const skippedCfg = loadConfig(root, { readText: () => ({ skip: "leaves the worktree" }) });
    assert.equal(skippedCfg.cfg, null);
    assert.deepEqual(skippedCfg.errors, ["backlog.config.json was skipped (leaves the worktree)"]);
  });
});

test("readBacklog reports a skipped roster as configErrors beside errors", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg, { readText: (p) => (p.endsWith("team.json") ? { skip: "fifo" } : null) });
    assert.deepEqual(data.configErrors, ["team.json was skipped (fifo)"]);
    assert.ok(data.errors.includes(data.configErrors[0]));
  });
});

test("readItem and listDir seams: skips are recorded, a skipped directory adds no ids, syntax errors flow into errors", () => {
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "A", effort: 3 }, { id: "DEMO0002", title: "B", effort: 3 }], completed: [{ id: "DEMO0009", title: "C" }] }, (root) => {
    const { cfg } = loadConfig(root);
    const calls = [];
    const data = readBacklog(root, cfg, {
      listDir: (dir) => (dir === join(root, "trellis", "completed", "tasks") ? { skip: "outside the worktree" } : ["DEMO0001.md", "DEMO0002.md"].filter(() => dir === join(root, "trellis", "active"))),
      readItem: (path, where) => {
        calls.push(where);
        if (where === "active/DEMO0002.md") return { skip: "unreadable" };
        return { fm: { id: "DEMO0001", title: "A", status: "active", milestone: "Alpha", priority: "High", effort: 3, depends_on: [], summary: "S." }, body: "b", syntaxErrors: ["active/DEMO0001.md: odd line"] };
      },
    });
    assert.deepEqual(calls, ["active/DEMO0001.md", "active/DEMO0002.md"]);
    assert.deepEqual(data.skipped, [{ path: "completed/tasks", reason: "outside the worktree" }, { path: "active/DEMO0002.md", reason: "unreadable" }]);
    assert.ok(data.errors.includes("active/DEMO0001.md: odd line"));
    assert.deepEqual([...data.ids].sort(), ["DEMO0001", "DEMO0002"], "the skipped directory contributed no ids");
    assert.equal(data.completed.length, 0);
  });
});

test("splitFrontMatter splits on the rule parseFrontMatter uses", () => {
  assert.deepEqual(splitFrontMatter("---\na: 1\n---\n\n# Body\n"), { block: "a: 1", body: "\n# Body\n" });
  assert.deepEqual(splitFrontMatter("---\r\na: 1\r\n---\r\nx\r\n"), { block: "a: 1", body: "x\n" });
  assert.deepEqual(splitFrontMatter("---\na: 1\n"), { block: null, body: "---\na: 1\n" });
  assert.deepEqual(splitFrontMatter("no fences"), { block: null, body: "no fences" });
  const errors = [];
  assert.equal(parseFrontMatter("---\na: 1\n", "x", errors), null);
  assert.equal(errors.length, 1);
});

test("a directory at backlog.config.json or team.json is a structured error with the default reader", () => {
  withRepo(ARRAY_CFG, {}, (root) => {
    const dirs = join(root, "trellis", "team.json");
    mkdirSync(dirs);
    const roster = loadRoster(root);
    assert.equal(roster.errors.length, 1);
    assert.match(roster.errors[0], /^team\.json was skipped \(/);
    rmSync(join(root, "trellis", "backlog.config.json"));
    mkdirSync(join(root, "trellis", "backlog.config.json"));
    const cfg = loadConfig(root);
    assert.equal(cfg.cfg, null);
    assert.match(cfg.errors[0], /^backlog\.config\.json was skipped \(/);
  });
});

test("an idPrefix that fits the filename pattern but not the bare id pattern is a config error", () => {
  assert.ok(configErrors({ ...ARRAY_CFG, idPrefix: ")T(" }).some((e) => e.includes("idPrefix")));
});

test("a non-string milestone or priority is a config error, not a throw", () => {
  for (const key of ["milestones", "priorities"]) {
    for (const bad of [[1], [null], [{}], ["A", ["B"]]]) {
      assert.ok(configErrors({ ...ARRAY_CFG, [key]: bad }).some((e) => e.includes(`\`${key}\` entries`)), `${key} ${JSON.stringify(bad)}`);
    }
  }
});

test("a task with ~200k malformed front-matter lines reports its diagnostics without overflowing the stack", () => {
  withRepo(ARRAY_CFG, { active: [{ id: "DEMO0001", title: "A", effort: 3 }] }, (root) => {
    writeFileSync(join(root, "trellis", "active", "DEMO0002.md"), `---\nid: DEMO0002\n${"???\n".repeat(200_000)}---\nb\n`);
    const { cfg } = loadConfig(root);
    const data = readBacklog(root, cfg);
    assert.ok(data.errors.filter((e) => e.startsWith("active/DEMO0002.md: cannot parse")).length >= 200_000);
    assert.equal(data.active.some((i) => i.id === "DEMO0001"), true, "the other task still loads");
  });
});
