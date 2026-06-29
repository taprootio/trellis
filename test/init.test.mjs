// Smoke/behavior tests for the `trellis init` scaffolder (zero-dependency,
// run via `node --test`). Scope is the init contract; the broader CLI/MCP suite
// is TRL0011. Each test scaffolds into a throwaway temp repo and cleans up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { applyScaffold, shouldPromptVocab } from "../src/init.mjs";
import { loadConfig, loadRoster, readBacklog, generateArtifacts } from "../src/backlog.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initScript = join(sourceRoot, "scripts", "trellis-init.mjs");
const yamlSrc = join(sourceRoot, "test", "fixtures", "yaml-frontmatter");
const legacySrc = join(sourceRoot, "test", "fixtures", "legacy-backlog");
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

// Isolated git invocation for the --retire-source tests — no global/system config so
// the host's settings can't change behavior; identity + signing set locally per repo.
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

// A throwaway git repo (main branch, local identity, signing off).
function gitRepo() {
  const root = tempRepo();
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Tester"]);
  git(root, ["config", "user.email", "tester@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

// Run the init CLI under the isolated git env; capture status/stdout/stderr rather than
// throwing on a non-zero exit.
function runInit(root, args) {
  try {
    const stdout = execFileSync(process.execPath, [initScript, root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}

test("scaffolds a fresh repo that the core validates clean", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    for (const rel of [
      "trellis/backlog.config.json",
      "trellis/team.json",
      "trellis/active/.gitkeep",
      "trellis/completed/tasks/.gitkeep",
      "trellis/README.md",
      "trellis/backlog.json",
      ".github/workflows/backlog.yml",
      ".github/pull_request_template.md",
      "trellis/playbooks/work-task.md",
      "trellis/branch-protection.md",
      "AGENTS.md",
    ]) assert.ok(existsSync(join(root, rel)), `${rel} should exist`);
    assert.deepEqual(summary.warnings, [], "a fresh scaffold should produce no warnings");
    assert.deepEqual(summary.errors, [], "a fresh scaffold should produce no errors");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scaffolds the branch-protection recipe and pins the required-check context (TRL0014)", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);

    // The recipe travels into the onboarded repo (copied verbatim like the playbooks).
    assert.ok(existsSync(join(root, "trellis/branch-protection.md")), "branch-protection.md is scaffolded");
    const recipe = readFileSync(join(root, "trellis/branch-protection.md"), "utf8");
    assert.match(recipe, /`backlog`/, "the recipe names the pinned check context");
    assert.match(recipe, /not `?Backlog Hygiene/, "the recipe warns to require the job name `backlog`, not the workflow display name");
    assert.match(recipe, /gh api/, "the recipe carries the GitHub gh api snippet");
    // Portable into a repo that has no SPEC.md / is not Trellis itself: no repo-root
    // relative spec link, no Trellis author branch prefix.
    assert.doesNotMatch(recipe, /\]\([^)]*SPEC\.md\)/, "no SPEC link of any shape (would dangle in an onboarded repo with no SPEC.md)");
    assert.doesNotMatch(recipe, /\bje\//, "no Trellis author branch prefix leaks into the copied recipe");

    // The emitted workflow pins the job with an explicit `name: backlog`, so the
    // required-check context is stable — a workflow rename can't silently drop it.
    const wf = readFileSync(join(root, ".github/workflows/backlog.yml"), "utf8");
    assert.match(wf, /^ {4}name: backlog$/m, "the workflow job carries an explicit name: backlog");

    // The onboarded AGENTS block points at the recipe for enabling the gate.
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /trellis\/branch-protection\.md/, "AGENTS points at the setup recipe");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scaffolds a valid team.json stub (one active member) and mentions the roster in AGENTS", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.created.includes("trellis/team.json"), "team.json is created (authored, not generated)");
    const { roster, errors } = loadRoster(root);
    assert.deepEqual(errors, [], "the stub roster validates");
    assert.equal(roster.members.length, 1);
    assert.equal(roster.members[0].status, "active");
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /trellis\/team\.json/, "AGENTS mentions the roster");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force preserves a valid team.json instead of clobbering it (no data loss, no dangling owners)", () => {
  // Regression: --force overwriting a real roster with the stub would drop members and
  // leave an active `owner: alice` dangling, failing generate after a partial write.
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/team.json"), JSON.stringify({ members: [{ handle: "alice", name: "Alice", status: "active" }] }, null, 2) + "\n");
    writeFileSync(
      join(root, "trellis/active/DEMO0001.md"),
      "---\nid: DEMO0001\ntitle: T\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 3\ndepends_on: []\nowner: alice\nsummary: S.\n---\n\n# DEMO0001 — T\n",
    );
    const { summary } = applyScaffold(root, { prefix: "DEMO", force: true }, {}, sourceRoot);
    assert.deepEqual(summary.errors, [], "force does not break the owned active task");
    assert.ok(summary.skipped.includes("trellis/team.json"), "the valid roster is preserved (skipped), not recreated");
    assert.deepEqual(loadRoster(root).roster.members.map((m) => m.handle), ["alice"], "members are intact, not replaced by the stub");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force repairs a broken team.json instead of refusing", () => {
  // A pre-existing broken roster would fail the core read; --force overwrites it with a
  // fresh stub, so preflight must not block on it (parallel to a corrupted index).
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/team.json"), "{ broken");
    // Without --force, the broken roster blocks (it would be kept and fail generate).
    const refused = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(refused.summary.errors.some((e) => /team\.json|backlog has errors/.test(e)), "non-force refuses a broken roster");
    // With --force, it is overwritten and the scaffold completes.
    const { summary } = applyScaffold(root, { prefix: "DEMO", force: true }, {}, sourceRoot);
    assert.ok(summary.created.includes("trellis/team.json"), "force re-creates the roster");
    assert.deepEqual(loadRoster(root).errors, [], "the restored roster is valid");
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
    assert.equal(cfg.specVersion, "2.3");
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
    assert.ok(summary.skipped.includes("trellis/team.json"));
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
    assert.ok(existsSync(join(root, "trellis/playbooks/conventions.md")), "conventions.md should be scaffolded");

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
      const body = readFileSync(join(root, "trellis/playbooks", rel), "utf8");
      assert.doesNotMatch(body, /this repo:/, `${rel} must not claim Trellis's value as the reader's ("this repo:")`);
      assert.doesNotMatch(body, /\bje\//, `${rel} must not carry Trellis's author branch prefix`);
      assert.doesNotMatch(body, /TRL(xxxx|\d)/, `${rel} must not bake in the Trellis id prefix as an example`);
    }
    const wt = readFileSync(join(root, "trellis/playbooks/work-task.md"), "utf8");
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

test("a kept config's custom tasksDir relocates the scaffolded tree, not the default root", () => {
  // Regression: init must scaffold the tree at the kept config's tasksDir. Using the
  // fixed default would write trellis/* skeletons the core then fails to fill against
  // the configured root, leaving a partial scaffold. The config home stays at trellis/.
  const root = tempRepo();
  try {
    mkdirSync(join(root, "trellis"), { recursive: true });
    writeFileSync(
      join(root, "trellis/backlog.config.json"),
      JSON.stringify({ specVersion: "2.0", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3], tasksDir: "planning" }, null, 2) + "\n",
    );
    const { summary } = applyScaffold(root, {}, {}, sourceRoot);
    assert.deepEqual(summary.errors, [], "scaffold over a custom-tasksDir config succeeds");
    assert.ok(existsSync(join(root, "planning/README.md")), "the tree is scaffolded under tasksDir");
    assert.ok(existsSync(join(root, "planning/backlog.json")), "artifacts land under tasksDir");
    assert.equal(existsSync(join(root, "trellis/README.md")), false, "nothing is scaffolded at the default root");
    assert.ok(existsSync(join(root, "trellis/backlog.config.json")), "the config home stays fixed at trellis/");
    // The playbooks and branch-protection recipe travel with the FIXED config home
    // (TRL0028), independent of tasksDir — they must NOT follow the relocated tree.
    // COPY_FILES is pinned at trellis/, decoupled from the task root; this guards a
    // future refactor that re-derived it from `root` against a silent regression.
    assert.ok(existsSync(join(root, "trellis/playbooks/work-task.md")), "playbooks scaffold at the fixed config home, not under tasksDir");
    assert.ok(existsSync(join(root, "trellis/branch-protection.md")), "the branch-protection recipe scaffolds at the fixed config home");
    assert.equal(existsSync(join(root, "planning/playbooks/work-task.md")), false, "playbooks are not scaffolded under the relocated task root");
    assert.equal(existsSync(join(root, "planning/branch-protection.md")), false, "the recipe is not scaffolded under the relocated task root");
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /`planning\/\{active/, "the AGENTS block reflects the configured root");
    assert.match(agents, /`planning\/backlog\.json`/, "the AGENTS generated-artifacts bullet names the root-relative paths");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tasksDir with a trailing slash is canonicalized — no doubled separators in paths or messages", () => {
  const root = tempRepo();
  try {
    mkdirSync(join(root, "trellis"), { recursive: true });
    writeFileSync(
      join(root, "trellis/backlog.config.json"),
      JSON.stringify({ specVersion: "2.0", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3], tasksDir: "planning/" }, null, 2) + "\n",
    );
    const { summary } = applyScaffold(root, {}, {}, sourceRoot);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.root, "planning", "the effective root is canonicalized");
    assert.ok(summary.generated.every((p) => !p.includes("//")), "no doubled separators in reported artifact paths");
    assert.doesNotMatch(readFileSync(join(root, "AGENTS.md"), "utf8"), /planning\/\//, "no doubled separator in the AGENTS block");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- init --import on-ramp (CLI-composed: scaffold, then import) ----------------

test("init --import scaffolds then imports an existing backlog in one command", () => {
  const root = tempRepo();
  try {
    const out = execFileSync(
      process.execPath,
      [initScript, root, "--prefix", "ONB", "--import", yamlSrc, "--profile", "yaml-frontmatter"],
      { encoding: "utf8" },
    );
    assert.match(out, /Scaffolded Trellis/);
    assert.match(out, /Imported 4 items/);
    assert.ok(existsSync(join(root, "trellis/active/ONB0001.md")), "an imported active item exists");
    assert.ok(existsSync(join(root, "trellis/completed/tasks/ONB0003.md")), "an imported completed item exists");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --import surfaces inferred-value provenance in its summary", () => {
  const root = tempRepo();
  try {
    // The legacy-backlog fixture's completed item carries a date header but no effort, so
    // the taproot profile fills it from defaults.effort and flags it — exercising the
    // provenance summary on the init --import on-ramp (no git needed).
    const out = execFileSync(
      process.execPath,
      [initScript, root, "--prefix", "ONB", "--import", legacySrc, "--profile", "taproot-ai-backlog"],
      { encoding: "utf8" },
    );
    assert.match(out, /Imported 5 items/);
    assert.match(out, /estimated: .*effort-estimated/, "init --import echoes the import provenance summary");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --import --dry-run previews and writes nothing", () => {
  const root = tempRepo();
  try {
    const out = execFileSync(
      process.execPath,
      [initScript, root, "--prefix", "ONB", "--import", yamlSrc, "--profile", "yaml-frontmatter", "--dry-run"],
      { encoding: "utf8" },
    );
    assert.match(out, /Would scaffold Trellis/);
    assert.match(out, /Would then import from .* using profile yaml-frontmatter/);
    assert.match(out, /trellis import --dry-run/, "points at the real import-plan preview");
    assert.equal(existsSync(join(root, "trellis")), false, "a dry run writes no trellis/ tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init rejects --import without a profile/mapping, and --profile without --import", () => {
  const root = tempRepo();
  const run = (args) => {
    try { execFileSync(process.execPath, [initScript, root, ...args], { encoding: "utf8" }); return { status: 0, stderr: "" }; }
    catch (e) { return { status: e.status, stderr: String(e.stderr) }; }
  };
  try {
    const noMapping = run(["--import", yamlSrc]);
    assert.equal(noMapping.status, 2);
    assert.match(noMapping.stderr, /--import requires exactly one of/);

    const noImport = run(["--profile", "yaml-frontmatter"]);
    assert.equal(noImport.status, 2);
    assert.match(noImport.stderr, /only apply with --import/);

    assert.equal(existsSync(join(root, "trellis")), false, "a usage error scaffolds nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- reconciliation report (TRL0027): report-only, never edits author prose ----

test("reports a stale 'AI Backlog' guidance section and leaves the file byte-for-byte unchanged", () => {
  const root = tempRepo();
  try {
    const guide = "# AI guidelines\n\n## AI Backlog\n\nTasks live in `docs/tasks/` — edit the YAML there.\n";
    writeFileSync(join(root, "AI_GUIDELINES.md"), guide);
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const notes = summary.reconcile.filter((r) => r.file === "AI_GUIDELINES.md");
    assert.equal(notes.length, 1, "the stale AI Backlog section is flagged once");
    assert.match(notes[0].note, /AI Backlog/, "the note names the offending section");
    assert.match(notes[0].note, /trellis\//, "the note points at the new root");
    assert.equal(readFileSync(join(root, "AI_GUIDELINES.md"), "utf8"), guide, "init must not touch the file");
    assert.deepEqual(summary.warnings, [], "a reconcile note is not a scaffold warning");
    assertCheckClean(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags an author backlog section in AGENTS.md but never the Trellis block init appends", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n\n## Backlog\n\nSee `docs/tasks/` for the task files.\n");
    const first = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot).summary;
    const a1 = first.reconcile.filter((r) => r.file === "AGENTS.md");
    assert.equal(a1.length, 1, "the author's Backlog section is flagged");
    assert.match(a1[0].note, /"Backlog"/, "the note names the author heading");
    assert.doesNotMatch(a1[0].note, /Trellis\)/, "the note is not the appended '## Backlog (Trellis)' block");
    assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes("<!-- BEGIN TRELLIS -->"), "the block was appended");

    // Idempotent re-run: the block is now present, yet the scan still flags only the
    // author section — the stripped Trellis block (which has its own "Backlog" heading)
    // is never re-flagged.
    const a2 = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot).summary.reconcile.filter((r) => r.file === "AGENTS.md");
    assert.equal(a2.length, 1, "the re-run flags the author section once, not the Trellis block");
    assert.doesNotMatch(a2[0].note, /Trellis\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not flag a backlog section that already points at the new root", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "AI_GUIDELINES.md"), "## Backlog\n\nManaged with Trellis under `trellis/`.\n");
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.deepEqual(summary.reconcile.filter((r) => r.file === "AI_GUIDELINES.md"), [], "an already-reconciled section is not flagged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a doc that references the imported source path, and only when --import is given", () => {
  const root = tempRepo();
  try {
    // No backlog *heading*, so signal (a) stays silent and this isolates the import-path signal.
    writeFileSync(join(root, "CLAUDE.md"), "# Project notes\n\nOld tasks live under planning/legacy until migrated.\n");

    const withImport = applyScaffold(root, { prefix: "DEMO", import: "planning/legacy" }, {}, sourceRoot).summary;
    const notes = withImport.reconcile.filter((r) => r.file === "CLAUDE.md");
    assert.equal(notes.length, 1, "the doc referencing the import path is flagged");
    assert.match(notes[0].note, /planning\/legacy/, "the note names the imported path");

    const noImport = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot).summary;
    assert.deepEqual(noImport.reconcile.filter((r) => r.file === "CLAUDE.md"), [], "without --import the import-path signal does not fire");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the init CLI prints a Reconcile section for stale guidance", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "AI_GUIDELINES.md"), "## AI Backlog\n\nTasks are in `docs/tasks/`.\n");
    const out = execFileSync(process.execPath, [initScript, root, "--prefix", "DEMO"], { encoding: "utf8" });
    assert.match(out, /reconcile \(\d+\)/, "the CLI prints a reconcile header with a count");
    assert.match(out, /AI_GUIDELINES\.md/, "the CLI names the offending file");
    assert.match(out, /AI Backlog/, "the CLI names the offending section");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh scaffold (init writes its own AGENTS.md) reports no reconcile notes", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.deepEqual(summary.reconcile, [], "init's own output never self-flags");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- --retire-source (TRL0027): history-preserving, stage-only, never mid-import ----

test("--retire-source stages a git rm of a tracked source tree without committing", () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, "planning/legacy"), { recursive: true });
    writeFileSync(join(root, "planning/legacy/a.md"), "old task a\n");
    writeFileSync(join(root, "planning/legacy/b.md"), "old task b\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "import legacy backlog"]);
    const headBefore = git(root, ["rev-parse", "HEAD"]).trim();

    const { status, stdout } = runInit(root, ["--retire-source", "planning/legacy"]);
    assert.equal(status, 0, "a successful retirement exits 0");
    assert.match(stdout, /Retired "planning\/legacy"/);
    assert.match(stdout, /2 tracked files/);

    assert.equal(existsSync(join(root, "planning/legacy/a.md")), false, "files are removed from the working tree");
    const porcelain = git(root, ["status", "--porcelain"]);
    assert.match(porcelain, /^D {2}planning\/legacy\/a\.md$/m, "the deletion is staged");
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), headBefore, "retirement does not create a commit");
    assert.equal(git(root, ["cat-file", "-t", `${headBefore}:planning/legacy/a.md`]).trim(), "blob", "history is preserved at HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source --dry-run lists the files and changes nothing", () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, "planning/legacy"), { recursive: true });
    writeFileSync(join(root, "planning/legacy/a.md"), "old task a\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "import legacy backlog"]);

    const { status, stdout } = runInit(root, ["--retire-source", "planning/legacy", "--dry-run"]);
    assert.equal(status, 0);
    assert.match(stdout, /Would retire "planning\/legacy"/);
    assert.match(stdout, /dry run/);
    assert.match(stdout, /planning\/legacy\/a\.md/, "a dry run lists the files that would be removed");
    assert.ok(existsSync(join(root, "planning/legacy/a.md")), "a dry run leaves the files in place");
    assert.equal(git(root, ["status", "--porcelain"]).trim(), "", "a dry run stages nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source refuses an untracked path (nothing changed)", () => {
  const root = gitRepo();
  try {
    mkdirSync(join(root, "planning/legacy"), { recursive: true });
    writeFileSync(join(root, "planning/legacy/a.md"), "never committed\n");
    const { status, stderr } = runInit(root, ["--retire-source", "planning/legacy"]);
    assert.equal(status, 1, "a refusal exits 1");
    assert.match(stderr, /not tracked by git/);
    assert.ok(existsSync(join(root, "planning/legacy/a.md")), "the untracked file is left untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source refuses a path outside the repo", () => {
  const root = gitRepo();
  try {
    const { status, stderr } = runInit(root, ["--retire-source", "../outside"]);
    assert.equal(status, 1);
    assert.match(stderr, /outside the repo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source in a non-git directory fails cleanly", () => {
  const root = tempRepo(); // not a git repo
  try {
    mkdirSync(join(root, "planning/legacy"), { recursive: true });
    writeFileSync(join(root, "planning/legacy/a.md"), "a\n");
    const { status, stderr } = runInit(root, ["--retire-source", "planning/legacy"]);
    assert.equal(status, 1);
    assert.match(stderr, /not a git work tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source cannot be combined with --import", () => {
  const root = gitRepo();
  try {
    const { status, stderr } = runInit(root, ["--retire-source", "planning/legacy", "--import", "old", "--profile", "yaml-frontmatter"]);
    assert.equal(status, 2, "a usage error exits 2");
    assert.match(stderr, /--retire-source cannot be combined with --import/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valueless --retire-source is a usage error, never a silent scaffold", () => {
  const root = tempRepo(); // not git — the usage error must fire before any fs/git work
  try {
    for (const args of [["--retire-source"], ["--retire-source", ""]]) {
      const { status, stderr } = runInit(root, args);
      assert.equal(status, 2, `${JSON.stringify(args)} should be a usage error`);
      assert.match(stderr, /--retire-source requires a path/);
    }
    assert.equal(existsSync(join(root, "trellis")), false, "a valueless retire flag scaffolds nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source does not swallow a following flag as its path", () => {
  const root = gitRepo();
  try {
    // `--retire-source --dry-run` omits the path; the parser must treat --dry-run as the
    // next flag (→ a missing-path usage error), not consume it as a path named "--dry-run"
    // while silently dropping the dry run and staging a real git rm.
    const { status, stderr } = runInit(root, ["--retire-source", "--dry-run"]);
    assert.equal(status, 2, "a missing path is a usage error");
    assert.match(stderr, /--retire-source requires a path/);
    assert.equal(git(root, ["status", "--porcelain"]).trim(), "", "nothing is staged");
    assert.equal(existsSync(join(root, "trellis")), false, "and nothing is scaffolded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--retire-source does not consume a short option (-h) as its path", () => {
  const root = gitRepo();
  try {
    // The worst case: a tracked file literally named "-h". The parser must never treat it
    // as the retire path just because it followed --retire-source.
    writeFileSync(join(root, "-h"), "do not delete me\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "add a file named -h"]);

    // -h is the help flag, not a path: help wins and nothing is retired.
    const h = runInit(root, ["--retire-source", "-h"]);
    assert.equal(h.status, 0, "-h shows help and exits 0");
    assert.match(h.stdout, /--retire-source/, "help text is printed");
    assert.ok(existsSync(join(root, "-h")), "the tracked '-h' file is untouched");
    assert.equal(git(root, ["status", "--porcelain"]).trim(), "", "nothing is staged");

    // A non-help short option is an unknown flag → usage error, still no retire.
    const x = runInit(root, ["--retire-source", "-x"]);
    assert.equal(x.status, 2, "-x is rejected as an unknown flag");
    assert.match(x.stderr, /Unknown flag/);
    assert.ok(existsSync(join(root, "-h")), "still untouched");
    assert.equal(git(root, ["status", "--porcelain"]).trim(), "", "still nothing staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldPromptVocab never prompts for a retire-only run, even a valueless one", () => {
  // The bug this guards: a valueless --retire-source leaves opts.retireSource === undefined
  // (key present), so a truthiness check would still prompt. Keyed on presence, it must not.
  assert.equal(shouldPromptVocab({ retireSource: undefined }, true), false, "valueless --retire-source skips prompts");
  assert.equal(shouldPromptVocab({ retireSource: "planning/old" }, true), false, "a normal retire run skips prompts");
  // Sanity: a normal interactive run with missing vocab still prompts; the usual skips hold.
  assert.equal(shouldPromptVocab({}, true), true, "missing vocab on an interactive run prompts");
  assert.equal(shouldPromptVocab({ prefix: "X", milestones: ["A"] }, true), false, "nothing missing → no prompt");
  assert.equal(shouldPromptVocab({}, false), false, "non-interactive never prompts");
  assert.equal(shouldPromptVocab({ dryRun: true }, true), false, "a dry run never prompts");
});
