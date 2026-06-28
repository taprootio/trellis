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
import { loadConfig, readBacklog, generateArtifacts, parseFrontMatter, nextId } from "../src/backlog.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(projectRoot, "test", "fixtures");
const legacySrc = join(fixtures, "legacy-backlog");
const yamlSrc = join(fixtures, "yaml-frontmatter");
// Header-less / size-only drift (TRL0026): closed items with no date header, effort
// under a `Size:` label, and one item with no effort signal at all.
const headerlessSrc = join(fixtures, "legacy-headerless");
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

test("ids continue from the core `nextId` when importing into a non-empty target", () => {
  const root = initTarget();
  try {
    // First import fills the target (TAP0001…TAP0005).
    applyImport(root, legacySrc, mapping, {});
    assertCheckClean(root);

    // The next id is whatever the core computes from the existing item ids — the
    // README no longer carries it (SPEC §8.1/§8.2), so a second import must start
    // there, proving allocation is core-sourced, not parsed from the README.
    const { cfg } = loadConfig(root);
    const expected = nextId(readBacklog(root, cfg).ids, cfg);
    const { summary } = applyImport(root, legacySrc, mapping, {});
    assert.deepEqual(summary.errors, []);
    const assigned = summary.idMap.map((m) => m.newId).sort();
    assert.equal(assigned[0], expected, "first imported id continues the core sequence");
    assert.ok(assigned.every((id) => id > "TAP0005"), "no id collides with the first import");
    assertCheckClean(root);
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
    // A roster so the fixture's owners resolve: alice/bob active, carol since gone inactive.
    writeFileSync(join(root, "trellis/team.json"), JSON.stringify({ members: [
      { handle: "alice", name: "Alice", status: "active" },
      { handle: "bob", name: "Bob", status: "active" },
      { handle: "carol", name: "Carol", status: "inactive" },
    ] }, null, 2) + "\n");
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

    // owners resolve against the seeded roster; collaborators too
    assert.equal(fm(root, `trellis/active/${loginId}.md`).owner, "alice");
    assert.equal(logout.owner, "bob");
    assert.deepEqual(logout.collaborators, ["alice"]);

    // completed/removed close metadata read straight from yaml
    const spec = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/initial-spec.md")}.md`);
    assert.equal(spec.completed_on, "2025-01-15");
    assert.equal(spec.owner, "carol", "a now-inactive owner is kept as a historical value on a closed item");
    const removed = fm(root, `trellis/removed/${newIdFor(summary.idMap, "removed/telepathy-login.md")}.md`);
    assert.equal(removed.removed_on, "2025-02-01");
    assert.equal(removed.removed_reason, "Not feasible with current hardware.");
    assert.equal(removed.owner, "dave", "an owner absent from the roster is carried verbatim on a closed item");

    assert.deepEqual(snapshot(yamlSrc), before); // source untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import: remap.owner resolves a source handle; an unmapped active owner drops to unassigned + warns", () => {
  const root = initTarget();
  writeFileSync(join(root, "trellis/team.json"), JSON.stringify({ members: [{ handle: "ana", name: "Ana", status: "active" }] }, null, 2) + "\n");
  const src = mkdtempSync(join(tmpdir(), "trellis-owner-"));
  try {
    mkdirSync(join(src, "active"), { recursive: true });
    writeFileSync(join(src, "active", "001-mapped.md"), "# Mapped\n\nOwner: A. Person\n\nProse.\n");
    writeFileSync(join(src, "active", "002-absent.md"), "# Absent\n\nProse.\n");
    writeFileSync(join(src, "active", "003-unknown.md"), "# Unknown\n\nOwner: Nobody\n\nProse.\n");
    const m = {
      sources: { active: { dirs: ["active"], file: "*.md" } },
      fields: { id: { from: "filename", pattern: "^(\\d+)" }, title: { from: "h1" }, owner: { from: "header", label: "Owner" } },
      remap: { owner: { "A. Person": "ana" } },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 }, // no defaults.owner → unmapped drops
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/001-mapped.md")}.md`).owner, "ana", "remap.owner → roster handle");
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/002-absent.md")}.md`).owner, undefined, "absent owner stays unassigned");
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/003-unknown.md")}.md`).owner, undefined, "unmapped owner drops to unassigned (never invents a member)");
    assert.ok(summary.warnings.some((w) => /owner "Nobody".*unassigned/.test(w)), `expected an unassigned warning, got ${JSON.stringify(summary.warnings)}`);
    assert.ok(!summary.warnings.some((w) => /002-absent/.test(w)), "an absent owner is not warned");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("import: an unresolved active owner falls back to defaults.owner", () => {
  const root = initTarget();
  writeFileSync(join(root, "trellis/team.json"), JSON.stringify({ members: [{ handle: "lee", name: "Lee", status: "active" }] }, null, 2) + "\n");
  const src = mkdtempSync(join(tmpdir(), "trellis-ownerdef-"));
  try {
    mkdirSync(join(src, "active"), { recursive: true });
    writeFileSync(join(src, "active", "001-absent.md"), "# Absent\n\nProse.\n");
    writeFileSync(join(src, "active", "002-unmapped.md"), "# Unmapped\n\nOwner: Someone Else\n\nProse.\n");
    const m = {
      sources: { active: { dirs: ["active"], file: "*.md" } },
      fields: { id: { from: "filename", pattern: "^(\\d+)" }, title: { from: "h1" }, owner: { from: "header", label: "Owner" } },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1, owner: "lee" },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/001-absent.md")}.md`).owner, "lee", "defaults.owner fills an absent owner");
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/002-unmapped.md")}.md`).owner, "lee", "defaults.owner also catches an unmapped owner before unassigning");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("import drops a closed-item owner/collaborator that is not a valid handle instead of carrying a non-handle", () => {
  const root = initTarget();
  writeFileSync(join(root, "trellis/team.json"), JSON.stringify({ members: [] }, null, 2) + "\n"); // empty roster → everything historical
  const src = mkdtempSync(join(tmpdir(), "trellis-collab-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    // "Jane Doe" survives asList/extraction as one token (a space, no comma) but is not
    // a valid handle; "validhandle" is. Only the latter may be carried — for both the
    // scalar owner (a non-handle must not be stored) and the inline collaborators list
    // (a non-handle would corrupt serialization).
    writeFileSync(join(src, "completed", "001-x.md"), "# Done\n\nCreated: 2024-02-03\nOwner: Jane Doe\nCollaborators: Jane Doe; validhandle\n\nIt shipped.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        completed_on: { from: "header", label: "Created" },
        owner: { from: "header", label: "Owner" },
        collaborators: { from: "header", label: "Collaborators" },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/001-x.md")}.md`);
    assert.equal(item.owner, undefined, "a non-handle historical owner is dropped, not stored verbatim");
    assert.deepEqual(item.collaborators, ["validhandle"], "the non-handle token is dropped; the valid one is carried, no corruption");
    assert.ok(summary.warnings.some((w) => /owner "Jane Doe".*not a valid handle/.test(w)), `expected a dropped-owner warning, got ${JSON.stringify(summary.warnings)}`);
    assert.ok(summary.warnings.some((w) => /collaborator "Jane Doe".*not a valid handle/.test(w)), `expected a dropped-collaborator warning, got ${JSON.stringify(summary.warnings)}`);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
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

// --------------------------------------------------- TRL0026: close-date fallback
const hasGit = () => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
};

test("git-date fallback dates a header-less completed item, flags it, and counts it", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-gitdate-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    // No Completed:/Created: header anywhere — the only date signal is git.
    writeFileSync(join(src, "completed", "040-no-date.md"), "# A dateless done thing\n\n**Effort:** 3\n\nIt shipped, but nobody wrote a date.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed", fallback: { from: "header", label: "Created" } },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 },
    };
    // Inject a deterministic resolver so the test needs no real repo.
    const gitDate = () => "2023-09-14";
    const { summary } = applyImport(root, src, m, { dryRun: false, gitDate });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/040-no-date.md")}.md`);
    assert.equal(item.completed_on, "2023-09-14", "completed_on filled from the git commit date");
    assert.equal(summary.provenance.gitDated, 1, "the git-dated item is counted");
    assert.equal(summary.provenance.dateDefaulted, 0);
    assert.ok(summary.warnings.some((w) => /040-no-date.*completed_on 2023-09-14 derived from git/.test(w)), `expected a git-dated warning, got ${JSON.stringify(summary.warnings)}`);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("a header date still wins over git — git is only a fallback", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-headerwins-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "043-dated.md"), "# A dated thing\n\nCompleted: 2022-03-04\n**Effort:** 2\n\nIt shipped with a date.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 },
    };
    const gitDate = () => "2099-12-31"; // would be obviously wrong if it leaked through
    const { summary } = applyImport(root, src, m, { dryRun: false, gitDate });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/043-dated.md")}.md`);
    assert.equal(item.completed_on, "2022-03-04", "the authored header date is used, not git");
    assert.equal(summary.provenance.gitDated, 0, "an authored date is not counted as git-dated");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("falls back to a defaults.completed_on floor when neither header nor git yields a date", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-datefloor-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "041-no-date.md"), "# Another dateless thing\n\n**Effort:** 2\n\nNo date, and not in git either.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1, completed_on: "2020-01-01" },
    };
    const gitDate = () => null; // simulate a non-repo / uncommitted source
    const { summary } = applyImport(root, src, m, { dryRun: false, gitDate });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/041-no-date.md")}.md`);
    assert.equal(item.completed_on, "2020-01-01", "completed_on filled from the floor default");
    assert.equal(summary.provenance.dateDefaulted, 1);
    assert.equal(summary.provenance.gitDated, 0);
    assert.ok(summary.warnings.some((w) => /041-no-date.*from defaults\.completed_on/.test(w)), `expected a date-defaulted warning, got ${JSON.stringify(summary.warnings)}`);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("refuses a header-less completed item when there is no git date and no floor default", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-nodate-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "042-no-date.md"), "# Hopeless\n\n**Effort:** 1\n\nNo date anywhere.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 }, // no completed_on floor
    };
    const gitDate = () => null;
    const plan = planImport(root, src, m, { gitDate });
    assert.ok(plan.errors.some((e) => e.includes("completed_on")), `expected a completed_on error, got ${JSON.stringify(plan.errors)}`);
    const { summary } = applyImport(root, src, m, { dryRun: false, gitDate });
    assert.ok(summary.errors.length > 0);
    assertCheckClean(root); // nothing written
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("the default resolver reads a real git commit date (integration)", (t) => {
  if (!hasGit()) return t.skip("git not available");
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-realgit-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "050-committed.md"), "# A committed done thing\n\n**Effort:** 2\n\nShipped and committed.\n");
    // Build a source git repo and commit the item with a pinned author date. Neutralize
    // any global/system git config so the pinned date and a local identity always win.
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: "2021-07-08T12:00:00", GIT_COMMITTER_DATE: "2021-07-08T12:00:00",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const g = (...args) => execFileSync("git", ["-C", src, ...args], { stdio: "ignore", env });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "Tester");
    g("add", ".");
    g("commit", "-q", "-m", "import source");
    // No injected gitDate → the production resolver runs real git against `src`.
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      defaults: { milestone: "Alpha", priority: "Low", effort: 1 },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/050-committed.md")}.md`);
    assert.equal(item.completed_on, "2021-07-08", "completed_on derived from the pinned commit date");
    assert.equal(summary.provenance.gitDated, 1);
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("a present-but-invalid authored close date is refused, not papered over by git or a floor", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-baddate-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    writeFileSync(join(src, "completed", "044-bad-date.md"), "# Impossible date\n\nCompleted: 2024-02-31\n**Effort:** 2\n\nThe author wrote a bad date.\n");
    const m = {
      sources: { completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      // A valid git date AND a floor default are both available — neither may rescue a
      // present-but-malformed authored date; it must be refused.
      defaults: { milestone: "Alpha", priority: "Low", effort: 1, completed_on: "2020-01-01" },
    };
    const gitDate = () => "2023-09-14";
    const plan = planImport(root, src, m, { gitDate });
    assert.ok(plan.errors.some((e) => /completed_on .*not an ISO date/.test(e)), `expected a malformed-date error, got ${JSON.stringify(plan.errors)}`);
    const { summary } = applyImport(root, src, m, { dryRun: false, gitDate });
    assert.ok(summary.errors.length > 0, "the import is refused");
    assert.equal(summary.provenance.gitDated, 0, "git is not consulted for a present-but-invalid date");
    assertCheckClean(root); // nothing written
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- TRL0026: Size → effort
test("Size: feeds effort when Effort: is absent (profile fallback extractor)", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-size-"));
  try {
    mkdirSync(join(src, "active"), { recursive: true });
    writeFileSync(join(src, "active", "060-sized.md"), "# A sized task\n\n**Priority:** P2\n**Milestone:** Pre-Launch\n**Size:** 8\n\nProse.\n");
    const m = {
      sources: { active: { dirs: ["active"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        priority: { from: "inline", label: "Priority" },
        milestone: { from: "inline", label: "Milestone" },
        effort: { from: "inline", label: "Effort", fallback: { from: "inline", label: "Size" } },
      },
      remap: { priority: { P2: "Medium" }, milestone: { "Pre-Launch": "Alpha" } },
      defaults: { effort: 1 },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    const item = fm(root, `trellis/active/${newIdFor(summary.idMap, "active/060-sized.md")}.md`);
    assert.equal(item.effort, 8, "effort read from the Size fallback, not the flat default");
    assert.equal(summary.provenance.effortEstimated, 0, "a real Size signal is not an estimate");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("remap.effort maps a foreign size label to a canonical effort value", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-remapeffort-"));
  try {
    mkdirSync(join(src, "active"), { recursive: true });
    writeFileSync(join(src, "active", "061-large.md"), "# A large task\n\n**Priority:** P1\n**Milestone:** Pre-Launch\n**Size:** L\n\nProse.\n");
    const m = {
      sources: { active: { dirs: ["active"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        priority: { from: "inline", label: "Priority" },
        milestone: { from: "inline", label: "Milestone" },
        effort: { from: "inline", label: "Size" },
      },
      remap: { priority: { P1: "High" }, milestone: { "Pre-Launch": "Alpha" }, effort: { S: 1, M: 3, L: 8 } },
      defaults: { effort: 1 },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    assert.equal(fm(root, `trellis/active/${newIdFor(summary.idMap, "active/061-large.md")}.md`).effort, 8, "L → 8 via remap.effort");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("a closed item with no effort signal is filled from defaults.effort and flagged estimated; an active one is not", () => {
  const root = initTarget();
  const src = mkdtempSync(join(tmpdir(), "trellis-effortest-"));
  try {
    mkdirSync(join(src, "completed"), { recursive: true });
    mkdirSync(join(src, "active"), { recursive: true });
    writeFileSync(join(src, "completed", "070-done.md"), "# A done thing\n\nCompleted: 2024-05-06\n\nNo effort recorded.\n");
    writeFileSync(join(src, "active", "071-live.md"), "# A live thing\n\n**Priority:** P3\n**Milestone:** Pre-Launch\n\nNo effort recorded.\n");
    const m = {
      sources: { active: { dirs: ["active"], file: "*.md" }, completed: { dirs: ["completed"], file: "*.md" } },
      fields: {
        id: { from: "filename", pattern: "^(\\d+)" },
        title: { from: "h1" },
        priority: { from: "inline", label: "Priority" },
        milestone: { from: "inline", label: "Milestone" },
        effort: { from: "inline", label: "Effort" },
        completed_on: { from: "header", label: "Completed" },
      },
      remap: { priority: { P3: "Low" }, milestone: { "Pre-Launch": "Alpha" } },
      defaults: { milestone: "Alpha", priority: "Low", effort: 2 },
    };
    const { summary } = applyImport(root, src, m, { dryRun: false });
    assert.deepEqual(summary.errors, []);
    const done = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/070-done.md")}.md`);
    const live = fm(root, `trellis/active/${newIdFor(summary.idMap, "active/071-live.md")}.md`);
    assert.equal(done.effort, 2, "closed item filled from defaults.effort");
    assert.equal(live.effort, 2, "active item also filled from defaults.effort");
    assert.equal(summary.provenance.effortEstimated, 1, "only the closed item is counted as estimated");
    assert.ok(summary.warnings.some((w) => /070-done.*effort 2 estimated/.test(w)), `expected a closed effort-estimate warning, got ${JSON.stringify(summary.warnings)}`);
    assert.ok(!summary.warnings.some((w) => /071-live.*estimated/.test(w)), "an active item's defaulted effort is not flagged");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

// ------------------------- TRL0026: header-less / size-only fixture, end-to-end
test("taproot profile imports a header-less, size-only fixture: git-dated, Size→effort, estimate-flagged", () => {
  const root = initTarget();
  const before = snapshot(headerlessSrc);
  try {
    // Inject the git date so the end-to-end assertion is deterministic; the real-git
    // path is covered by the integration test above.
    const gitDate = () => "2022-11-02";
    const { summary } = applyImport(root, headerlessSrc, mapping, { dryRun: false, gitDate });
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.counts, { active: 1, completed: 2, removed: 0, total: 3 });

    // Active item: effort read from `Size:` (Effort: absent), enums remapped.
    const active = fm(root, `trellis/active/${newIdFor(summary.idMap, "active/100-sized-active.md")}.md`);
    assert.equal(active.effort, 5, "active effort from the Size fallback");
    assert.equal(active.priority, "Medium"); // P2 → Medium
    assert.equal(active.milestone, "Beta");  // "MCP Servers" → Beta

    // Header-less completed item with a Size: git-dated, effort from Size, not estimated.
    const sized = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/099-no-date.md")}.md`);
    assert.equal(sized.completed_on, "2022-11-02", "completed_on git-dated");
    assert.equal(sized.effort, 3, "closed effort from the Size fallback");

    // Header-less completed item with no effort signal: git-dated + defaults.effort, flagged.
    const bare = fm(root, `trellis/completed/tasks/${newIdFor(summary.idMap, "completed/098-no-size.md")}.md`);
    assert.equal(bare.completed_on, "2022-11-02");
    assert.equal(bare.effort, 1, "effort from defaults.effort");

    assert.equal(summary.provenance.gitDated, 2, "both header-less completed items git-dated");
    assert.equal(summary.provenance.effortEstimated, 1, "only the no-size completed item is effort-estimated");
    assert.ok(summary.warnings.some((w) => /098-no-size.*effort 1 estimated/.test(w)), `expected an estimate warning, got ${JSON.stringify(summary.warnings)}`);
    assert.deepEqual(snapshot(headerlessSrc), before, "source tree untouched");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
