// Smoke/behavior tests for the backlog import engine (zero-dependency, run via
// `node --test`). Scope is the TRL0021 import contract; the broader CLI/MCP matrix
// is TRL0011. Each test scaffolds a throwaway target with `trellis init`, imports a
// fixture that mimics a foreign backlog's drift (bold-inline active items,
// header-style completed items, three colliding `021`s, a cross-item dependency,
// a removed item), and cleans up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { planImport, applyImport } from "../src/import.mjs";
import { loadProfile, listProfiles } from "../src/profiles.mjs";
import { loadConfig, readBacklog, generateArtifacts, parseFrontMatter } from "../src/backlog.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(projectRoot, "test", "fixtures");
const legacySrc = join(fixtures, "legacy-backlog");
const yamlSrc = join(fixtures, "yaml-frontmatter");
// The shipped Taproot reference profile doubles as this suite's regression mapping
// (the built-in profiles are the canonical fixtures — TRL0022).
const mapping = loadProfile("taproot-ai-backlog").mapping;

const tempRepo = () => mkdtempSync(join(tmpdir(), "trellis-import-"));

// A fresh, --check-green target backlog (prefix TAP) for import to land in.
function initTarget() {
  const root = tempRepo();
  const { summary } = applyScaffold(root, { prefix: "TAP" }, {}, projectRoot);
  assert.deepEqual(summary.errors, [], "init target should have no errors");
  return root;
}

// Recursively snapshot every *.md under dir → { relpath: content }, to prove the
// source tree is never mutated (copy-out, never delete).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".md")) out[relative(dir, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return out;
}

// Assert the target is --check-green: every generated artifact on disk matches what
// the core would regenerate from the item files + config.
function assertCheckClean(root) {
  const { cfg, errors } = loadConfig(root);
  assert.deepEqual(errors, [], "config should load without errors");
  const data = readBacklog(root, cfg);
  assert.deepEqual(data.errors, [], "backlog should read without errors");
  const { files, errors: gerr } = generateArtifacts(root, cfg, data);
  assert.deepEqual(gerr, [], "generate should have no errors");
  const stale = files.filter((f) => (existsSync(f.path) ? readFileSync(f.path, "utf8") : "") !== f.content);
  assert.deepEqual(stale.map((f) => f.path), [], "no generated artifact should be stale");
}

const newIdFor = (idMap, sourceFile) => (idMap.find((m) => m.sourceFile === sourceFile) || {}).newId;
const fm = (root, rel) => parseFrontMatter(readFileSync(join(root, rel), "utf8"), rel, []);

test("dry-run reports the full plan, writes nothing, and leaves the source untouched", () => {
  const root = initTarget();
  const before = snapshot(legacySrc);
  try {
    const { summary } = applyImport(root, legacySrc, mapping, { dryRun: true });
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.counts, { active: 3, completed: 1, removed: 1, total: 5 });
    assert.equal(summary.idMap.length, 5);
    assert.equal(summary.imported.length, 5);
    // nothing landed in the target …
    assert.equal(existsSync(join(root, "trellis/active", `${newIdFor(summary.idMap, "active/021-importer.md")}.md`)), false);
    assertCheckClean(root);
    // … and the source is byte-identical
    assert.deepEqual(snapshot(legacySrc), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports the fixture and the core validates it clean (--check green)", () => {
  const root = initTarget();
  const before = snapshot(legacySrc);
  try {
    const { summary } = applyImport(root, legacySrc, mapping, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.counts, { active: 3, completed: 1, removed: 1, total: 5 });
    assertCheckClean(root);

    const importerId = newIdFor(summary.idMap, "active/021-importer.md");
    const relocateId = newIdFor(summary.idMap, "active/021-relocate.md");
    const coreId = newIdFor(summary.idMap, "active/015-core.md");
    // the three colliding `021`s deduped to distinct ids
    assert.ok(importerId && relocateId && coreId);
    assert.notEqual(importerId, relocateId);

    // depends_on rewritten through the id map (source `015` → coreId), enums remapped
    const importer = fm(root, `trellis/active/${importerId}.md`);
    assert.deepEqual(importer.depends_on, [coreId]);
    assert.equal(importer.priority, "High");   // P1 → High
    assert.equal(importer.milestone, "Beta");  // "MCP Servers" → Beta
    assert.equal(importer.effort, 8);
    // summary synthesized from prose, skipping the bold metadata lines
    assert.equal(importer.summary, "Convert a foreign backlog into Trellis items via a declarative mapping.");

    // case-insensitive priority remap ("p2" → Medium); no deps
    const relocate = fm(root, `trellis/active/${relocateId}.md`);
    assert.equal(relocate.priority, "Medium");
    assert.equal(relocate.milestone, "Alpha");
    assert.deepEqual(relocate.depends_on, []);

    // completed item: `Created:` → completed_on fallback
    const spec = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/007-spec.md")}.md`);
    assert.equal(spec.status, "completed");
    assert.equal(spec.completed_on, "2024-02-03");

    // removed item: removed_on + removed_reason
    const idea = fm(root, `trellis/removed/${newIdFor(summary.idMap, "removed/009-idea.md")}.md`);
    assert.equal(idea.status, "removed");
    assert.equal(idea.removed_on, "2024-03-01");
    assert.equal(idea.removed_reason, "superseded by the importer");

    assert.deepEqual(snapshot(legacySrc), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loud on an unmapped milestone for an active item and writes nothing", () => {
  const root = initTarget();
  const m2 = JSON.parse(JSON.stringify(mapping));
  delete m2.remap.milestone["MCP Servers"]; // 021-importer's milestone now has no remap
  try {
    const plan = planImport(root, legacySrc, m2);
    assert.ok(
      plan.errors.some((e) => e.includes("milestone") && e.includes("MCP Servers")),
      `expected a milestone error, got ${JSON.stringify(plan.errors)}`,
    );
    const { summary } = applyImport(root, legacySrc, m2, { dryRun: false });
    assert.ok(summary.errors.length > 0);
    assert.equal(existsSync(join(root, "trellis/active", `${newIdFor(plan.idMap, "active/021-importer.md")}.md`)), false);
    assertCheckClean(root); // target unchanged by the refused import
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats a dependency on a collided source id as a hard error", () => {
  const root = initTarget();
  const ambSrc = join(fixtures, "ambiguous-deps");
  const m = {
    sources: { active: { dirs: ["active"], file: "*.md" } },
    fields: {
      id: { from: "filename", pattern: "^(\\d+)" },
      title: { from: "h1" },
      priority: { from: "inline", label: "Priority" },
      effort: { from: "inline", label: "Effort" },
      milestone: { from: "inline", label: "Milestone" },
      depends_on: { from: "inline", label: "Depends on" },
    },
    remap: { priority: { P1: "High" }, milestone: { "Pre-Launch": "Alpha" } },
  };
  try {
    const plan = planImport(root, ambSrc, m);
    assert.ok(plan.errors.some((e) => e.includes("ambiguous")), `expected an ambiguous-dep error, got ${JSON.stringify(plan.errors)}`);
    const { summary } = applyImport(root, ambSrc, m, { dryRun: false });
    assert.ok(summary.errors.length > 0);
    assertCheckClean(root); // nothing written
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects non-calendar close dates instead of guessing, but accepts real ones", () => {
  const root = initTarget();
  const m = {
    sources: { completed: { dirs: ["completed"], file: "*.md" } },
    fields: {
      id: { from: "filename", pattern: "^(\\d+)" },
      title: { from: "h1" },
      completed_on: { from: "header", label: "Created" },
    },
    defaults: { milestone: "Alpha", priority: "Low", effort: 1 }, // isolate the date as the only variable
  };
  const writeSrc = (date) => {
    const src = mkdtempSync(join(tmpdir(), "trellis-srcdate-"));
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "001-x.md"), `# A done thing\n\nCreated: ${date}\n\nIt shipped.\n`);
    return src;
  };
  try {
    for (const bad of ["2024-13-40", "2024-02-31", "2024-00-10", "2024-12-00"]) {
      const src = writeSrc(bad);
      try {
        const plan = planImport(root, src, m);
        assert.ok(plan.errors.some((e) => e.includes("completed_on")), `expected a date error for ${bad}, got ${JSON.stringify(plan.errors)}`);
        assert.ok(applyImport(root, src, m, { dryRun: false }).summary.errors.length > 0);
      } finally { rmSync(src, { recursive: true, force: true }); }
    }
    const ok = writeSrc("2024-02-29"); // 2024 is a leap year — a real date
    try {
      const { summary } = applyImport(root, ok, m, { dryRun: false });
      assert.deepEqual(summary.errors, []);
      assertCheckClean(root);
    } finally { rmSync(ok, { recursive: true, force: true }); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires historical metadata on closed items unless a mapping default supplies it", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-srcmeta-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "007-x.md"), "# Shipped thing\n\nCreated: 2024-02-03\n\nIt shipped.\n");
    const base = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        completed_on: { from: "header", label: "Created" },
      },
    };
    // No defaults: the header-style item has no milestone/priority/effort → hard error.
    const plan = planImport(root, src, base);
    for (const f of ["milestone", "priority", "effort"]) {
      assert.ok(plan.errors.some((e) => e.includes(f)), `expected a missing-${f} error, got ${JSON.stringify(plan.errors)}`);
    }
    assert.ok(applyImport(root, src, base, { dryRun: false }).summary.errors.length > 0);
    assertCheckClean(root); // nothing written

    // With mapping defaults, the same source imports clean.
    const withDefaults = { ...base, defaults: { milestone: "Alpha", priority: "Low", effort: 1 } };
    const { summary } = applyImport(root, src, withDefaults, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("rejects source dirs that escape the source root", () => {
  const root = initTarget();
  try {
    const m = {
      sources: { active: { dirs: ["../escape"], file: "*.md" } },
      fields: { id: { from: "filename" }, title: { from: "h1" } },
    };
    const plan = planImport(root, legacySrc, m);
    assert.ok(plan.errors.some((e) => e.includes("within the source")), `expected a traversal error, got ${JSON.stringify(plan.errors)}`);
    assert.ok(applyImport(root, legacySrc, m, { dryRun: false }).summary.errors.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to import into an uninitialized target and writes nothing", () => {
  const root = tempRepo(); // bare dir, never init-ed
  try {
    const { summary } = applyImport(root, legacySrc, mapping, { dryRun: false });
    assert.ok(summary.errors.length > 0);
    assert.deepEqual(summary.created, []);
    assert.equal(existsSync(join(root, "trellis")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI is dry-run by default and writes only with --apply (via --profile)", () => {
  const root = initTarget();
  const script = join(projectRoot, "scripts", "trellis-import.mjs");
  const mdCount = () => readdirSync(join(root, "trellis/active")).filter((f) => f.endsWith(".md")).length;
  try {
    const dry = execFileSync(process.execPath, [script, legacySrc, "--profile", "taproot-ai-backlog", "--target", root], { encoding: "utf8" });
    assert.match(dry, /Would import 5 items/);
    assert.equal(mdCount(), 0, "dry-run writes no items");

    const applied = execFileSync(process.execPath, [script, legacySrc, "--profile", "taproot-ai-backlog", "--target", root, "--apply"], { encoding: "utf8" });
    assert.match(applied, /Imported 5 items/);
    assert.equal(mdCount(), 3, "apply writes the 3 active items");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports the yaml-frontmatter profile clean, with dates and a dep rewrite (anti-overfit)", () => {
  const root = initTarget();
  const before = snapshot(yamlSrc);
  const yaml = loadProfile("yaml-frontmatter").mapping;
  try {
    const { summary } = applyImport(root, yamlSrc, yaml, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.counts, { active: 2, completed: 1, removed: 1, total: 4 });
    assertCheckClean(root);

    const loginId = newIdFor(summary.idMap, "active/feature-login.md");
    const logoutId = newIdFor(summary.idMap, "active/feature-logout.md");
    // depends_on rewritten through the id map (source EX-1 → loginId)
    const logout = fm(root, `trellis/active/${logoutId}.md`);
    assert.deepEqual(logout.depends_on, [loginId]);
    // no remap or defaults needed — yaml values pass straight through
    assert.equal(logout.priority, "Medium");
    assert.equal(logout.milestone, "Beta");
    assert.equal(logout.effort, 2);
    // summary synthesized from the prose when the yaml omits it
    assert.equal(logout.summary, "Tear down the session and clear the auth cookie.");

    // completed/removed close metadata read straight from yaml
    const spec = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/initial-spec.md")}.md`);
    assert.equal(spec.completed_on, "2025-01-15");
    const removed = fm(root, `trellis/removed/${newIdFor(summary.idMap, "removed/telepathy-login.md")}.md`);
    assert.equal(removed.removed_on, "2025-02-01");
    assert.equal(removed.removed_reason, "Not feasible with current hardware.");

    assert.deepEqual(snapshot(yamlSrc), before); // source untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every built-in profile loads and is a structurally valid, documented mapping", () => {
  const profiles = listProfiles();
  for (const name of ["taproot-ai-backlog", "yaml-frontmatter"]) {
    assert.ok(profiles.some((p) => p.name === name), `${name} profile ships`);
  }
  for (const p of profiles) {
    const { mapping: m, error } = loadProfile(p.name);
    assert.equal(error, null, `profile ${p.name} loads: ${error}`);
    assert.ok(m && typeof m === "object" && m.sources && m.fields, `profile ${p.name} has sources + fields`);
    assert.ok(p.description, `profile ${p.name} documents itself with a description`);
  }
  // The clean-import proof for each profile is its dedicated test above.
});

test("CLI lists profiles, and --mapping <file> matches --profile <name>", () => {
  const script = join(projectRoot, "scripts", "trellis-import.mjs");
  const list = execFileSync(process.execPath, [script, "--list-profiles"], { encoding: "utf8" });
  assert.match(list, /taproot-ai-backlog/);
  assert.match(list, /yaml-frontmatter/);

  const root = initTarget();
  const profileFile = join(projectRoot, "profiles", "taproot-ai-backlog.json");
  try {
    const viaProfile = execFileSync(process.execPath, [script, legacySrc, "--profile", "taproot-ai-backlog", "--target", root], { encoding: "utf8" });
    const viaMapping = execFileSync(process.execPath, [script, legacySrc, "--mapping", profileFile, "--target", root], { encoding: "utf8" });
    assert.match(viaProfile, /Would import 5 items/);
    assert.match(viaMapping, /Would import 5 items/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: an explicit --dry-run wins over --apply and writes nothing", () => {
  const root = initTarget();
  const script = join(projectRoot, "scripts", "trellis-import.mjs");
  try {
    const out = execFileSync(
      process.execPath,
      [script, legacySrc, "--profile", "taproot-ai-backlog", "--target", root, "--apply", "--dry-run"],
      { encoding: "utf8" },
    );
    assert.match(out, /Would import 5 items/);
    assert.equal(readdirSync(join(root, "trellis/active")).filter((f) => f.endsWith(".md")).length, 0, "the contradictory combo writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
