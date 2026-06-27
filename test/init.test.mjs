// Smoke/behavior tests for the `trellis init` scaffolder (zero-dependency,
// run via `node --test`). Scope is the init contract; the broader CLI/MCP suite
// is TRL0011. Each test scaffolds into a throwaway temp repo and cleans up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRepo = () => mkdtempSync(join(tmpdir(), "trellis-init-"));

// Assert the scaffolded repo is --check-green: every generated artifact on disk
// matches what the core would regenerate from the item files + config.
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

test("scaffolds a fresh repo that the core validates clean", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    for (const rel of [
      "trellis/backlog.config.json",
      "trellis/active/.gitkeep",
      "trellis/completed/tasks/.gitkeep",
      "trellis/README.md",
      "trellis/backlog.json",
      ".github/workflows/backlog.yml",
      ".github/pull_request_template.md",
      "docs/playbooks/work-task.md",
      "AGENTS.md",
    ]) assert.ok(existsSync(join(root, rel)), `${rel} should exist`);
    assert.deepEqual(summary.warnings, [], "a fresh scaffold should produce no warnings");
    assert.deepEqual(summary.errors, [], "a fresh scaffold should produce no errors");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("respects --prefix in config, next id, and the AGENTS block", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "ACME" }, {}, sourceRoot);
    const cfg = JSON.parse(readFileSync(join(root, "trellis/backlog.config.json"), "utf8"));
    assert.equal(cfg.idPrefix, "ACME");
    assert.equal(cfg.specVersion, "2.0");
    const backlog = JSON.parse(readFileSync(join(root, "trellis/backlog.json"), "utf8"));
    assert.equal(backlog.prefix, "ACME");
    assert.equal(backlog.nextId, "ACME0001");
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /ids are `ACME`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("is idempotent — a re-run skips every template file and stays clean", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.deepEqual(summary.created, [], "nothing new should be created on re-run");
    assert.deepEqual(summary.appended, [], "nothing should be appended on re-run");
    assert.ok(summary.skipped.includes("trellis/backlog.config.json"));
    assert.ok(summary.skipped.includes("AGENTS.md"));
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appends the Trellis block to an existing AGENTS.md without markers", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# My Repo\n\nExisting guidance.\n");
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.deepEqual(summary.appended, ["AGENTS.md"]);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Existing guidance\./, "existing content is preserved");
    assert.match(agents, /<!-- BEGIN TRELLIS -->/, "the marked block is appended");
    const second = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(second.summary.skipped.includes("AGENTS.md"), "re-run leaves AGENTS.md untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run reports a plan but writes nothing", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, { dryRun: true }, sourceRoot);
    assert.ok(summary.created.length > 0, "dry-run still reports planned files");
    assert.equal(existsSync(join(root, "trellis/backlog.config.json")), false);
    assert.equal(existsSync(join(root, "trellis/README.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force overwrites a tampered template but leaves the AGENTS block intact", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/backlog.config.json"), "{}\n"); // tamper
    const { summary } = applyScaffold(root, { prefix: "DEMO", force: true }, {}, sourceRoot);
    assert.ok(summary.created.includes("trellis/backlog.config.json"), "force re-creates templates");
    assert.equal(JSON.parse(readFileSync(join(root, "trellis/backlog.config.json"), "utf8")).idPrefix, "DEMO");
    assert.ok(summary.skipped.includes("AGENTS.md"), "the marked AGENTS block is never clobbered, even under --force");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves an AGENTS.md that already contains the Trellis block untouched", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# Repo\n\n<!-- BEGIN TRELLIS -->\nLOCAL EDIT\n<!-- END TRELLIS -->\n");
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.skipped.includes("AGENTS.md"));
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /LOCAL EDIT/, "local edits inside the block survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an invalid resolved config and leaves the target untouched", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", idWidth: 0 }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /id-width/.test(e)), "an option error is reported");
    assert.deepEqual(summary.created, [], "nothing is created on an invalid config");
    assert.equal(existsSync(join(root, "trellis/backlog.config.json")), false, "no file is written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force over a repo with an existing active item re-scaffolds without crashing", () => {
  // preflight validates existing items against the synthetic effectiveConfig
  // (not loadConfig) under --force. That config must carry an effortScale, or
  // readBacklog → resolveEffort dereferences undefined and throws (regression).
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(
      join(root, "trellis/active/DEMO0001.md"),
      "---\nid: DEMO0001\ntitle: T\nstatus: active\ndepends_on: []\nsummary: S.\nmilestone: Alpha\npriority: High\neffort: 3\n---\n\nBody.\n",
    );
    const { summary } = applyScaffold(root, { prefix: "DEMO", force: true }, {}, sourceRoot);
    assert.deepEqual(summary.errors, [], "force re-scaffold over an active item succeeds");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a provided-but-empty list flag is rejected, not masked by the default", () => {
  // `--effort abc` parses to []; that must reach validateOptions, not silently
  // fall back to the default effort scale.
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", effort: [] }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /effort/.test(e)), "an empty effort list is rejected");
    assert.deepEqual(summary.created, []);
    assert.equal(existsSync(join(root, "trellis/backlog.config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partially-invalid effort list (a NaN token) is rejected", () => {
  // `--effort 1,abc,3` parses to [1, NaN, 3]; the typo must surface, not be dropped.
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", effort: [1, NaN, 3] }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /effort/.test(e)));
    assert.deepEqual(summary.created, []);
    assert.equal(existsSync(join(root, "trellis/backlog.config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to scaffold over a target whose existing backlog has errors", () => {
  // A pre-existing malformed item would make the core-generate step fail; init
  // must refuse up front and leave the target untouched (no half-scaffold).
  const root = tempRepo();
  try {
    mkdirSync(join(root, "trellis/active"), { recursive: true });
    writeFileSync(join(root, "trellis/active/DEMO0001.md"), "no front-matter here\n");
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /backlog has errors/.test(e)), "the broken item is surfaced");
    assert.deepEqual(summary.created, [], "nothing is scaffolded");
    assert.equal(existsSync(join(root, "trellis/backlog.config.json")), false, "no config is written");
    assert.equal(existsSync(join(root, "trellis/README.md")), false, "no skeleton is written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing copy source is a benign warning, not a refusal", () => {
  // With a sourceRoot lacking the playbooks/PR template, init warns but still
  // scaffolds a --check-green backlog — so the CLI must not treat it as a failure.
  const root = tempRepo();
  const emptySource = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, emptySource);
    assert.ok(summary.warnings.some((w) => /source not found/.test(w)), "missing copies are warned");
    assert.ok(summary.created.includes("trellis/backlog.config.json"), "the scaffold still proceeds");
    assert.ok(summary.generated.length > 0, "artifacts are still generated");
    assert.ok(existsSync(join(root, "trellis/backlog.json")), "the backlog is produced");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptySource, { recursive: true, force: true });
  }
});

test("refuses (no partial write) when an existing generated file lost its markers", () => {
  // Valid config but a corrupted README skeleton (markers stripped) + a missing
  // template: a naive impl would write the template then fail generate. Preflight
  // must refuse before any write so the target is left as-is.
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot); // full valid scaffold
    writeFileSync(join(root, "trellis/README.md"), "# Backlog\n\nno markers here\n");
    rmSync(join(root, ".github/workflows/backlog.yml")); // a now-missing template
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /markers/.test(e)), "the markerless file is a fatal error");
    assert.deepEqual(summary.created, [], "nothing new is written");
    assert.equal(existsSync(join(root, ".github/workflows/backlog.yml")), false, "no partial write — the missing template stays missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses (no partial write) when a generated index has wrong-section markers", () => {
  // README carrying the COMPLETED markers instead of MILESTONES passed the old
  // substring check, then the core failed to fill it after writes. Preflight must
  // require the exact begin/end pair and refuse before writing.
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot); // valid scaffold
    writeFileSync(join(root, "trellis/README.md"), "# Backlog\n\n<!-- BEGIN GENERATED:COMPLETED -->\n<!-- END GENERATED:COMPLETED -->\n");
    rmSync(join(root, ".github/workflows/backlog.yml")); // a now-missing template
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /markers/.test(e)), "wrong-section markers are caught in preflight");
    assert.equal(existsSync(join(root, ".github/workflows/backlog.yml")), false, "no partial write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses (no partial write) when a generated index has out-of-order markers", () => {
  // END before BEGIN: both substrings are present (the old includes check passed),
  // but fillMarkers needs begin→end, so generate would fail after writes.
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/README.md"), "# Backlog\n\n<!-- END GENERATED:MILESTONES -->\n<!-- BEGIN GENERATED:MILESTONES -->\n");
    rmSync(join(root, ".github/workflows/backlog.yml"));
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.errors.some((e) => /markers/.test(e)), "out-of-order markers are caught");
    assert.equal(existsSync(join(root, ".github/workflows/backlog.yml")), false, "no partial write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force repairs a corrupted generated index instead of refusing", () => {
  // --force overwrites the index with a fresh skeleton, so a markerless README
  // must NOT block the run — preflight skips the marker check under --force.
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/README.md"), "# Backlog\n\nno markers here\n");
    const { summary } = applyScaffold(root, { prefix: "DEMO", force: true }, {}, sourceRoot);
    assert.deepEqual(summary.errors, [], "--force does not refuse a corrupted index");
    assert.ok(summary.generated.includes("trellis/README.md"), "the index is regenerated");
    assert.match(readFileSync(join(root, "trellis/README.md"), "utf8"), /<!-- BEGIN GENERATED:MILESTONES -->/, "markers restored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renders the AGENTS block from a kept existing config, not the supplied flags", () => {
  // A repo already configured with idPrefix DEMO must not get an AGENTS block that
  // claims ids are ACME just because --prefix ACME was passed; the kept config wins.
  const root = tempRepo();
  try {
    mkdirSync(join(root, "trellis"), { recursive: true }); // config home must exist before we seed it
    writeFileSync(
      join(root, "trellis/backlog.config.json"),
      JSON.stringify({ specVersion: "2.0", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3] }, null, 2) + "\n",
    );
    writeFileSync(join(root, "AGENTS.md"), "# Repo\n"); // no Trellis block yet
    const { summary } = applyScaffold(root, { prefix: "ACME" }, {}, sourceRoot);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /ids are `DEMO`/, "AGENTS reflects the kept config");
    assert.doesNotMatch(agents, /ids are `ACME`/, "the supplied --prefix is not used");
    assert.ok(summary.warnings.some((w) => /governs/.test(w)), "the ignored flag is warned");
    assert.equal(JSON.parse(readFileSync(join(root, "trellis/backlog.config.json"), "utf8")).idPrefix, "DEMO", "the kept config is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// TRL0007 smoke test: the per-repo conventions contract must travel intact into a
// non-Trellis repo — the universal playbooks copied verbatim, but the authoritative
// seam values (in AGENTS.md) reflecting the onboarded repo, not Trellis's own.
test("the conventions contract travels into an onboarded repo without leaking Trellis specifics", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);

    // The contract definition travels verbatim alongside the playbooks.
    assert.ok(existsSync(join(root, "docs/playbooks/conventions.md")), "conventions.md should be scaffolded");

    // The onboarded AGENTS.md is the *authoritative* per-repo contract: it declares
    // the seam points with this repo's package commands — never Trellis's own npm
    // scripts or author branch prefix.
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Loop contract/, "AGENTS declares a Loop contract block");
    assert.match(agents, /`branch-naming`/, "declares the branch-naming seam the playbooks read");
    assert.match(agents, /npx trellis generate/, "regenerate value is the package command");
    assert.match(agents, /npx trellis check/, "check value is the package command");
    assert.doesNotMatch(agents, /npm run backlog:/, "Trellis's own npm scripts must not leak into an onboarded contract");
    assert.doesNotMatch(agents, /\bje\//, "Trellis's author branch prefix must not leak");

    // The copied playbooks are universal: they name seam points and defer to
    // AGENTS.md, and never mis-attribute Trellis's value to the reader's repo via
    // an indexical "this repo:" claim (which the verbatim copy would carry along).
    for (const rel of ["work-task.md", "code-review.md", "pr-draft.md", "conventions.md"]) {
      const body = readFileSync(join(root, "docs/playbooks", rel), "utf8");
      assert.doesNotMatch(body, /this repo:/, `${rel} must not claim Trellis's value as the reader's ("this repo:")`);
      assert.doesNotMatch(body, /\bje\//, `${rel} must not carry Trellis's author branch prefix`);
      assert.doesNotMatch(body, /TRL(xxxx|\d)/, `${rel} must not bake in the Trellis id prefix as an example`);
    }
    const wt = readFileSync(join(root, "docs/playbooks/work-task.md"), "utf8");
    assert.match(wt, /`regenerate`/, "work-task names the regenerate seam");
    assert.match(wt, /`branch-naming`/, "work-task names the branch-naming seam");
    assert.match(wt, /see\s+AGENTS\.md/, "work-task defers to AGENTS.md for the seam value");

    // The copied PR template is a COPY_FILES artifact too: no Trellis id prefix,
    // author branch prefix, or hard-coded npm command may ride along into a foreign
    // repo (the standard itself is TRL0016; this is just copy hygiene).
    const prTemplate = readFileSync(join(root, ".github/pull_request_template.md"), "utf8");
    assert.doesNotMatch(prTemplate, /TRL(xxxx|\d)/, "PR template must not bake in the Trellis id prefix");
    assert.doesNotMatch(prTemplate, /\bje\//, "PR template must not carry the author branch prefix");
    assert.doesNotMatch(prTemplate, /npm run/, "PR template must not bake in Trellis's npm commands");
    // Attribution is a default-with-override seam (default none, repos may opt in):
    // the copied template keeps the no-attribution default but defers to AGENTS.md so
    // a repo can change it without editing the template.
    assert.match(prTemplate, /attribution policy \(AGENTS\.md\)/i, "PR template defers attribution to the repo's policy (override seam present)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the onboarded branch example respects the repo's configured id width", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO", idWidth: 2 }, {}, sourceRoot);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /demo01\//, "the branch example pads the sample id to the repo's width");
    assert.doesNotMatch(agents, /demo0001/, "no hard-coded 4-digit id when idWidth is 2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
