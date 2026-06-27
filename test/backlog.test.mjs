// Behavior tests for the generator core's effort-scale support (SPEC §6),
// run via `node --test`. Each test builds a throwaway temp repo with a chosen
// config + item files, then exercises loadConfig / resolveEffort / readBacklog /
// generateArtifacts / buildBacklogJson directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  readBacklog,
  resolveEffort,
  generateArtifacts,
  buildBacklogJson,
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
  for (const it of completed) writeFileSync(join(tasks, "completed", "tasks", `${it.id}.md`), fm({ status: "completed", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", completed_on: "2026-01-01", ...it }));
  for (const it of removed) writeFileSync(join(tasks, "removed", `${it.id}.md`), fm({ status: "removed", depends_on: [], summary: "S.", milestone: "Alpha", priority: "High", removed_on: "2026-01-01", removed_reason: "R.", ...it }));
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
