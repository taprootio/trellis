// Behavior tests for the generator core's effort-scale support (SPEC §6),
// run via `node --test`. Each test builds a throwaway temp repo with a chosen
// config + item files, then exercises loadConfig / resolveEffort / readBacklog /
// generateArtifacts / buildBacklogJson directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  paths,
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
  for (const tasksDir of [".git", ".git/trellis", "./.git/x", ".git/"]) {
    assert.ok(configErrors({ ...LEDGER_CFG, tasksDir }).some((e) => e.includes("tasksDir")), `ledger rejects ${tasksDir}`);
  }
  for (const tasksDir of [".github", ".gitx/t", "docs/.git"]) {
    assert.deepEqual(configErrors({ ...LEDGER_CFG, tasksDir }), [], `ledger accepts ${tasksDir}`);
  }
  assert.deepEqual(configErrors({ ...ARRAY_CFG, tasksDir: ".git/t" }), [], "scan mode is unchanged");
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

test("check never calls git in ledger mode", () => {
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
