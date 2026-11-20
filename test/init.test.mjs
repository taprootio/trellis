// Smoke/behavior tests for the `trellis init` scaffolder (zero-dependency,
// run via `node --test`). Scope is the init contract; the broader CLI/MCP suite
// is TRL0011. Each test scaffolds into a throwaway temp repo and cleans up.

import { test } from "node:test";
import { ledgerTest } from "./git-support.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, chmodSync, lstatSync, symlinkSync, realpathSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { applyScaffold, planScaffold, shouldPromptVocab, agentsBlock, compactBlock, artifactBullet, AGENTS_BYTE_LIMIT, AGENTS_MARKERS, INIT_TOKENS, SKIP_PARTS, DEFAULTS } from "../src/init.mjs";
import { assertNotLegacyConfig } from "../src/import.mjs";
import { testSeams as outputSeams, previewNextId } from "../src/local-output.mjs";
import { initRefFormat } from "./git-support.mjs";
import { seed, claim } from "../src/ledger.mjs";
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
function gitRepo(initArgs = []) {
  const root = tempRepo();
  git(root, ["init", "-q", ...initArgs, "-b", "main"]);
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

test("init CLI tells import adopters to import before creating new tasks", () => {
  const root = tempRepo();
  try {
    const { status, stdout } = runInit(root, ["--prefix", "DEMO"]);
    assert.equal(status, 0);
    assert.match(stdout, /For a fresh backlog, add a task/);
    assert.match(stdout, /run `npx @taprootio\/trellis import \.\.\.` before creating any new task/);
    assert.match(stdout, /imported ids keep the first available range/);
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

test("scaffolds a valid team.json stub (an inactive placeholder) and mentions the roster in AGENTS", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(summary.created.includes("trellis/team.json"), "team.json is created (authored, not generated)");
    const { roster, errors } = loadRoster(root);
    assert.deepEqual(errors, [], "the stub roster validates");
    assert.equal(roster.members.length, 1);
    assert.equal(roster.members[0].status, "inactive", "the stub is an inactive placeholder, not a real teammate (TRL0034)");
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
    assert.equal(cfg.specVersion, "2.5");
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
    assert.match(agents, /npx @taprootio\/trellis generate/, "regenerate value is the package command");
    assert.match(agents, /npx @taprootio\/trellis check/, "check value is the package command");
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
    assert.match(out, /npx @taprootio\/trellis import --dry-run/, "points at the real import-plan preview");
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

// ------------------------------------------------------ ledger-mode refusals
// A ledger-mode target (TRL0037): import and init --force/--import refuse before any
// write. `snapshotAll` lists every file with its bytes, so "wrote nothing" is exact.
function snapshotAll(root) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}
function ledgerTarget(root) {
  const cfgPath = join(root, "trellis", "backlog.config.json");
  const cfg = { ...JSON.parse(readFileSync(cfgPath, "utf8")), idAllocation: "ledger" };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return root;
}

test("init --import --force refuses on a ledger-mode backlog and writes nothing", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    ledgerTarget(root);
    const before = snapshotAll(root);
    const r = spawnSync(process.execPath, [initScript, root, "--import", legacySrc, "--profile", "taproot-ai-backlog", "--force"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ledger/);
    assert.deepEqual(snapshotAll(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

ledgerTest("plain init --force refuses on a ledger-mode backlog; the config and ref are unchanged", () => {
  const root = gitRepo(["--ref-format=files"]);
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    ledgerTarget(root);
    const { cfg } = loadConfig(root);
    seed(root, cfg);
    claim(root, cfg, { title: "Open claim" });
    const refBefore = git(root, ["rev-parse", "refs/trellis/ids"]);
    const before = snapshotAll(root);
    const r = spawnSync(process.execPath, [initScript, root, "--force"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ledger/);
    assert.deepEqual(snapshotAll(root), before);
    assert.equal(git(root, ["rev-parse", "refs/trellis/ids"]), refBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init preflight on a ledger-mode target matches delimiter lines like the generator", () => {
  const root = tempRepo();
  const readme = join(root, "trellis", "README.md");
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    ledgerTarget(root);
    writeFileSync(readme, "# B\n\n<!-- BEGIN GENERATED:MILESTONES --> \t\n<!-- END GENERATED:MILESTONES -->  \n");
    let r = spawnSync(process.execPath, [initScript, root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // The markers appear only inside a line of text, so the generator could not fill them.
    writeFileSync(readme, "# B\n\nsee <!-- BEGIN GENERATED:MILESTONES --> and <!-- END GENERATED:MILESTONES -->\n");
    r = spawnSync(process.execPath, [initScript, root], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /markers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init --force still works on a scan-mode backlog", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const r = spawnSync(process.execPath, [initScript, root, "--force", "--prefix", "DEMO"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init --force refuses when the existing config cannot be read", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs POSIX permissions and a non-root user" }, () => {
  const root = tempRepo();
  const cfgPath = join(root, "trellis", "backlog.config.json");
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    ledgerTarget(root);
    chmodSync(cfgPath, 0o000);
    const r = spawnSync(process.execPath, [initScript, root, "--force"], { encoding: "utf8" });
    chmodSync(cfgPath, 0o644);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot check/);
    assert.match(readFileSync(cfgPath, "utf8"), /"ledger"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------- local-mode init (TRL0038)
const IGNORE = "trellis/.generated/\n";
const GENERATED_NAMES = ["index.md", "completed.md", "removed.md", "backlog.json"];
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const localConfig = (extra = {}) => ({ specVersion: "2.5", idPrefix: "TAP", idWidth: DEFAULTS.idWidth, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort, generatedArtifacts: "local", ...extra });

// A target holding only a local-mode config. `inGit: false` leaves it outside a work
// tree; `ignore` is the .gitignore text (null writes none).
function localInit({ inGit = true, ignore = IGNORE, cfg = {} } = {}) {
  const root = realpathSync(tempRepo());
  mkdirSync(join(root, "trellis"), { recursive: true });
  writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(localConfig(cfg), null, 2) + "\n");
  if (inGit) git(root, ["init", "-q", ...initRefFormat, "-b", "main"]);
  if (ignore !== null) writeFileSync(join(root, ".gitignore"), ignore);
  return root;
}
// Every file and folder with its bytes, so "unchanged" compares the whole tree.
function tree(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) { out[relative(root, abs)] = "<dir>"; walk(abs); }
      else out[relative(root, abs)] = lstatSync(abs).isSymbolicLink() ? "<link>" : readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}
const T = (root, ...p) => join(root, "trellis", ...p);
const withShim = (fn) => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "trellis-shim-")));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--show-prefix" ]; then echo "fatal: detected dubious ownership" >&2; exit 128; fi\ndone\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try { return fn(); } finally { process.env.PATH = old; rmSync(bin, { recursive: true, force: true }); }
};

test("local init --import from a marker-free config with no .generated/ scaffolds, imports and writes .generated/", () => {
  const root = localInit();
  try {
    const r = runInit(root, ["--import", legacySrc, "--profile", "taproot-ai-backlog"]);
    assert.equal(r.status, 0, r.stderr);
    for (const n of GENERATED_NAMES) assert.ok(existsSync(T(root, ".generated", n)), n);
    assert.ok(readdirSync(T(root, "active")).some((f) => f.endsWith(".md")), "items imported");
    const chk = spawnSync(process.execPath, [join(sourceRoot, "scripts", "backlog-readme.mjs"), "--check", "--target", root], { encoding: "utf8" });
    assert.equal(chk.status, 0, chk.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local init creates no README or index, and leaves existing ones as they are", () => {
  const fresh = localInit();
  const kept = localInit();
  try {
    assert.equal(runInit(fresh, []).status, 0);
    for (const f of ["README.md", "completed/index.md", "removed/index.md", "backlog.json"]) assert.equal(existsSync(T(fresh, f)), false, f);
    for (const n of GENERATED_NAMES) assert.ok(existsSync(T(fresh, ".generated", n)), n);

    mkdirSync(T(kept, "completed"), { recursive: true });
    mkdirSync(T(kept, "removed"));
    writeFileSync(T(kept, "README.md"), "# Mine\n\nNo markers here.\n");
    writeFileSync(T(kept, "completed", "index.md"), "Authored.\n");
    writeFileSync(T(kept, "removed", "index.md"), "");
    const before = ["README.md", "completed/index.md", "removed/index.md"].map((f) => readFileSync(T(kept, f), "utf8"));
    assert.equal(runInit(kept, []).status, 0);
    assert.deepEqual(["README.md", "completed/index.md", "removed/index.md"].map((f) => readFileSync(T(kept, f), "utf8")), before);
  } finally { rmSync(fresh, { recursive: true, force: true }); rmSync(kept, { recursive: true, force: true }); }
});

test("local init never edits .gitignore, and the ignore line covers planning[old]", () => {
  const line = "planning\\[old\\]/.generated/\n";
  const root = localInit({ ignore: line, cfg: { tasksDir: "planning[old]" } });
  try {
    const r = runInit(root, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), line);
    for (const n of GENERATED_NAMES) {
      assert.ok(existsSync(join(root, "planning[old]", ".generated", n)), n);
      assert.equal(spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", `./planning[old]/.generated/${n}`]).status, 0, n);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local init refuses an unignored output, printing the line to add, and writes nothing", () => {
  const negation = "trellis/.generated/*\n!trellis/.generated/backlog.json\n";
  for (const [name, ignore, unignored] of [["no rule", null, /index\.md/], ["a negation exposing a later output", negation, /backlog\.json/]]) {
    const root = localInit({ ignore });
    try {
      const before = tree(root);
      const r = runInit(root, []);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, unignored, name);
      assert.match(r.stderr, /^\s+trellis\/\.generated\/$/m, name);
      assert.deepEqual(tree(root), before, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("local init refuses a tracked output and a non-regular output path (the latter also outside git)", { skip: process.platform === "win32" }, () => {
  const tracked = localInit();
  try {
    mkdirSync(T(tracked, ".generated"));
    writeFileSync(T(tracked, ".generated", "index.md"), "old\n");
    git(tracked, ["add", "-f", "trellis/.generated/index.md"]);
    const before = tree(tracked);
    const r = runInit(tracked, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tracked by git/);
    assert.deepEqual(tree(tracked), before);
  } finally { rmSync(tracked, { recursive: true, force: true }); }
  for (const inGit of [true, false]) {
    const root = localInit({ inGit });
    try {
      mkdirSync(T(root, ".generated", "index.md"), { recursive: true });
      const before = tree(root);
      const r = runInit(root, []);
      assert.equal(r.status, 1, `inGit ${inGit}`);
      assert.match(r.stderr, /not a regular file/);
      assert.deepEqual(tree(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("local init succeeds outside a git work tree", () => {
  const root = localInit({ inGit: false, ignore: null });
  try {
    const r = runInit(root, []);
    assert.equal(r.status, 0, r.stderr);
    for (const n of GENERATED_NAMES) assert.ok(existsSync(T(root, ".generated", n)), n);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the local AGENTS block names .generated/ and mentions no markers", () => {
  const root = localInit();
  try {
    assert.equal(runInit(root, []).status, 0);
    const text = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.match(text, /trellis\/\.generated\//);
    assert.doesNotMatch(text, /marker|BEGIN\/END GENERATED/i);
    assert.match(text, /`gates`/, "the Loop contract table is still there");
  } finally { rmSync(root, { recursive: true, force: true }); }
  // Committed mode keeps its text.
  const committed = tempRepo();
  try {
    applyScaffold(committed, { prefix: "DEMO" }, {}, sourceRoot);
    assert.match(readFileSync(join(committed, "AGENTS.md"), "utf8"), /never hand-edit between the `BEGIN\/END GENERATED` markers/);
  } finally { rmSync(committed, { recursive: true, force: true }); }
});

test("init --force on a local-mode repo is refused before any write", () => {
  const root = localInit();
  try {
    const before = tree(root);
    const r = runInit(root, ["--force"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /generatedArtifacts is "local"/);
    assert.deepEqual(tree(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local init refuses a leftover marker and writes nothing", () => {
  const root = localInit();
  try {
    writeFileSync(T(root, "README.md"), "# B\n\n<!-- BEGIN GENERATED:MILESTONES -->\n<!-- END GENERATED:MILESTONES -->\n");
    const before = tree(root);
    const r = runInit(root, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /GENERATED:MILESTONES/);
    assert.deepEqual(tree(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local init writes all four outputs through writeArtifactFiles when .generated/ is absent", () => {
  const root = localInit();
  try {
    let writes = 0;
    outputSeams.beforeWrite = () => { writes++; };
    const { summary } = applyScaffold(root, {}, {}, sourceRoot);
    assert.deepEqual(summary.errors, []);
    assert.equal(writes, 4);
    assert.deepEqual(summary.generated, GENERATED_NAMES.map((n) => `trellis/.generated/${n}`));
  } finally { outputSeams.beforeWrite = null; rmSync(root, { recursive: true, force: true }); }
});

for (const [mode, extra] of [["scan", {}], ["ledger", { idAllocation: "ledger" }]]) {
  test(`local init refuses a real .generated/ holding a symlink or directory output, in ${mode} mode, with or without git`, { skip: process.platform === "win32" }, () => {
    for (const inGit of [true, false]) for (const kind of ["symlink", "directory"]) {
      const root = localInit({ inGit, cfg: extra });
      try {
        mkdirSync(T(root, ".generated"));
        if (kind === "symlink") { writeFileSync(join(root, "elsewhere.md"), "x\n"); symlinkSync(join(root, "elsewhere.md"), T(root, ".generated", "backlog.json")); }
        else mkdirSync(T(root, ".generated", "backlog.json"));
        const before = tree(root);
        const r = runInit(root, []);
        assert.notEqual(r.status, 0, `${kind} inGit ${inGit}`);
        assert.deepEqual(tree(root), before, `${kind} inGit ${inGit}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
}

ledgerTest("local ledger init writes the ledger preview into .generated/backlog.json, and null without the ref", () => {
  const root = localInit({ cfg: { idAllocation: "ledger" } });
  try {
    let r = runInit(root, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(T(root, ".generated", "backlog.json")).nextId, null, "no ref yet");

    const { cfg } = loadConfig(root);
    seed(root, cfg);
    const expected = previewNextId(root, cfg);
    assert.match(expected, /^TAP\d+$/);
    r = runInit(root, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(T(root, ".generated", "backlog.json")).nextId, expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local init --dry-run lists the local set and writes nothing", () => {
  const root = localInit();
  try {
    const before = tree(root);
    const r = runInit(root, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    for (const n of GENERATED_NAMES) assert.match(r.stdout, new RegExp(`trellis/\\.generated/${n.replace(".", "\\.")}`));
    assert.doesNotMatch(r.stdout, /trellis\/README\.md/);
    assert.deepEqual(tree(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a forced git discovery error makes local init refuse with the target unchanged", { skip: process.platform === "win32" }, () => {
  const root = localInit();
  try {
    const before = tree(root);
    const { summary } = withShim(() => applyScaffold(root, {}, {}, sourceRoot));
    assert.match(summary.errors.join(), /dubious ownership/);
    assert.deepEqual(tree(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------- legacy cutoff (TRL0039)
const LEGACY_ITEMS = join(sourceRoot, "test", "fixtures", "legacy-adoption");
const LEGACY_CUTOFF = { through: "TAP0004", closedBefore: "2026-11-19" };

// A target with a committed-mode `legacy` config and the legacy-adoption items under
// `tasksDir` (default `trellis`). `legacy: null` leaves the key out.
function legacyTarget({ tasksDir, legacy = LEGACY_CUTOFF, inGit = false } = {}) {
  const root = realpathSync(tempRepo());
  mkdirSync(join(root, "trellis"), { recursive: true });
  const cfg = localConfig({ generatedArtifacts: "committed", ...(tasksDir ? { tasksDir } : {}), ...(legacy === null ? {} : { legacy }) });
  writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(cfg, null, 2) + "\n");
  cpSync(LEGACY_ITEMS, join(root, tasksDir || "trellis"), { recursive: true });
  if (inGit) {
    git(root, ["init", "-q", ...initRefFormat, "-b", "main"]);
    git(root, ["config", "user.name", "Tester"]);
    git(root, ["config", "user.email", "tester@example.com"]);
    git(root, ["config", "commit.gpgsign", "false"]);
  }
  return root;
}

for (const [name, opts, extra] of [
  ["a custom tasksDir", { tasksDir: "work/backlog" }, []],
  ["the default tasksDir", {}, []],
  ["an invalid null legacy value", { legacy: null }, ["null"]],
  ["an invalid empty legacy object", { legacy: {} }, ["{}"]],
]) {
  test(`init --force with ${name} in the config is refused before any write`, () => {
    const root = legacyTarget(extra.length ? {} : opts);
    try {
      if (extra.length) {
        const cfgPath = join(root, "trellis", "backlog.config.json");
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        writeFileSync(cfgPath, JSON.stringify({ ...cfg, legacy: JSON.parse(extra[0]) }, null, 2) + "\n");
      }
      const before = tree(root);
      const r = runInit(root, ["--force"]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /legacy/);
      assert.deepEqual(tree(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("init --force --import with a legacy config is refused by the same early guard", () => {
  const root = legacyTarget();
  try {
    const before = tree(root);
    const r = runInit(root, ["--force", "--import", legacySrc, "--profile", "taproot-ai-backlog"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /legacy/);
    assert.deepEqual(tree(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A tracked folder to retire, committed, in a target that also holds a config.
function retireRepo(configure) {
  const root = legacyTarget({ inGit: true });
  configure(root);
  mkdirSync(join(root, "planning/legacy"), { recursive: true });
  writeFileSync(join(root, "planning/legacy/a.md"), "old task a\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "setup"]);
  return root;
}

test("init --force --retire-source in a repo with legacy exits 2 and changes nothing", () => {
  const root = retireRepo(() => {});
  try {
    const before = tree(root);
    const staged = git(root, ["diff", "--cached"]);
    const r = runInit(root, ["--force", "--retire-source", "planning/legacy"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no use with --retire-source/);
    assert.doesNotMatch(r.stderr, /replacement config/);
    assert.deepEqual(tree(root), before);
    assert.equal(git(root, ["diff", "--cached"]), staged);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init --retire-source without --force still stages the removal in a repo with legacy", () => {
  const root = retireRepo(() => {});
  try {
    const r = runInit(root, ["--retire-source", "planning/legacy"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(git(root, ["status", "--porcelain"]), /^D {2}planning\/legacy\/a\.md$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable config does not trigger the legacy refusal: retire-only still works", () => {
  for (const shape of ["config is a directory", "trellis is a file"]) {
    const root = gitRepo();
    try {
      if (shape === "config is a directory") mkdirSync(join(root, "trellis", "backlog.config.json"), { recursive: true });
      else writeFileSync(join(root, "trellis"), "not a folder\n");
      mkdirSync(join(root, "planning/legacy"), { recursive: true });
      writeFileSync(join(root, "planning/legacy/a.md"), "old task a\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "setup"]);
      const r = runInit(root, ["--force", "--retire-source", "planning/legacy"]);
      assert.equal(r.status, 0, `${shape}: ${r.stderr}`);
      assert.match(git(root, ["status", "--porcelain"]), /^D {2}planning\/legacy\/a\.md$/m);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("init --force with trellis as a regular file still reports today's cannot-check message", () => {
  const root = tempRepo();
  try {
    writeFileSync(join(root, "trellis"), "not a folder\n");
    const r = runInit(root, ["--force"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot check/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assertNotLegacyConfig passes absent, unparseable, null and array configs through", () => {
  const configs = [undefined, "{bad", "null", "[]"];
  for (const text of configs) {
    const root = tempRepo();
    try {
      if (text !== undefined) {
        mkdirSync(join(root, "trellis"), { recursive: true });
        writeFileSync(join(root, "trellis", "backlog.config.json"), text);
      }
      assert.doesNotThrow(() => assertNotLegacyConfig(root, "init --force", "why"), String(text));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("init --force with no config, a raw [] config, or an unparseable one takes today's path", () => {
  for (const text of [undefined, "[]", "{bad"]) {
    const root = tempRepo();
    try {
      if (text !== undefined) {
        mkdirSync(join(root, "trellis"), { recursive: true });
        writeFileSync(join(root, "trellis", "backlog.config.json"), text);
      }
      const r = runInit(root, ["--force", "--prefix", "DEMO"]);
      assert.equal(r.status, 0, `${text}: ${r.stderr}`);
      assert.equal(readJson(join(root, "trellis", "backlog.config.json")).idPrefix, "DEMO");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("planScaffold drops the --force hint for a kept legacy config only", () => {
  const withLegacy = legacyTarget();
  const without = legacyTarget({ legacy: null });
  try {
    for (const [root, hint] of [[withLegacy, false], [without, true]]) {
      const { warnings } = planScaffold(root, { prefix: "OTHER" }, sourceRoot);
      const kept = warnings.find((w) => w.includes("supplied flags ignored"));
      assert.ok(kept, "the conflict warning is still there");
      assert.equal(kept.includes("--force"), hint);
    }
  } finally { rmSync(withLegacy, { recursive: true, force: true }); rmSync(without, { recursive: true, force: true }); }
});

test("init with legacy already in the config scaffolds, checks green and renders blanks and nulls", () => {
  const root = legacyTarget();
  try {
    const r = runInit(root, []);
    assert.equal(r.status, 0, r.stderr);
    assertCheckClean(root);
    for (const f of [["completed", "index.md"], ["removed", "index.md"]]) {
      const text = readFileSync(T(root, ...f), "utf8");
      assert.match(text, /\| Old (completed|removed) item[^|]* \|  \| 2026-06-01 \|/);
    }
    for (const t of readJson(T(root, "backlog.json")).tasks) {
      for (const k of ["summary", "milestone", "priority", "effort"]) assert.equal(t[k], null, `${t.id} ${k}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init over the same items without legacy is refused with today's messages", () => {
  const root = legacyTarget({ legacy: null });
  try {
    const r = runInit(root, []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /missing `summary`/);
    assert.match(r.stderr, /missing `milestone`/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init --help documents the legacy cutoff and the --force refusal", () => {
  const r = spawnSync(process.execPath, [initScript, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /legacy/);
  assert.match(r.stdout, /--force is refused/);
});

test("an archived title holding $& survives init and check in a scan-mode repo with legacy", () => {
  const root = legacyTarget();
  try {
    const item = T(root, "completed", "tasks", "TAP0002.md");
    writeFileSync(item, readFileSync(item, "utf8").replace("title: Old completed item", () => "title: Explain $&"));
    assert.equal(runInit(root, []).status, 0);
    assertCheckClean(root);
    const index = readFileSync(T(root, "completed", "index.md"), "utf8");
    assert.match(index, /\| Explain \$& \|/);
    assert.equal(index.split("BEGIN GENERATED:COMPLETED").length, 2, "the markers are not duplicated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------- AGENTS block fixtures (TRL0040)
const fixturePath = (name) => join(sourceRoot, "test", "fixtures", name);
const readFixture = (name) => readFileSync(fixturePath(name), "utf8");
const BLOCK_OPTS = { prefix: "DEMO", idWidth: 5, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort };
// The text from the begin marker through the end marker and its newline.
function markedBlock(text) {
  const [begin, end] = AGENTS_MARKERS;
  const bi = text.indexOf(begin);
  return text.slice(bi, text.indexOf(end, bi) + end.length + 1);
}

test("the full AGENTS block renderer matches the pinned fixtures", () => {
  for (const mode of ["committed", "local"]) {
    assert.equal(agentsBlock(BLOCK_OPTS, "trellis", mode), readFixture(`agents-block-${mode}.md`));
  }
});

test("a scaffold writes the pinned full block into AGENTS.md", () => {
  const fresh = tempRepo();
  try {
    applyScaffold(fresh, { prefix: "DEMO", idWidth: 5 }, {}, sourceRoot);
    const text = readFileSync(join(fresh, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("# AGENTS\n\n"));
    assert.equal(markedBlock(text), readFixture("agents-block-committed.md"));
  } finally { rmSync(fresh, { recursive: true, force: true }); }

  const root = localInit({ cfg: { idPrefix: "DEMO", idWidth: 5 } });
  try {
    applyScaffold(root, {}, {}, sourceRoot);
    assert.equal(markedBlock(readFileSync(join(root, "AGENTS.md"), "utf8")), readFixture("agents-block-local.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// -------------------------------------------------------- --skip parts (TRL0040)
const SKIP_NAMES = Object.keys(SKIP_PARTS);
const WORKFLOW = ".github/workflows/backlog.yml";
// The files and the raw index bytes, so "unchanged" covers the Git index too.
const snapshotWithIndex = (root) => ({ ...snapshotAll(root), ".git/index": existsSync(join(root, ".git", "index")) ? readFileSync(join(root, ".git", "index")).toString("hex") : null });

test("each --skip part leaves its files out and lists the part under omitted", () => {
  for (const part of SKIP_NAMES) {
    const root = tempRepo();
    try {
      const { summary } = applyScaffold(root, { prefix: "DEMO", skip: [part] }, {}, sourceRoot);
      assert.deepEqual(summary.errors, [], part);
      assert.deepEqual(summary.omitted, [part]);
      for (const rel of SKIP_PARTS[part]) assert.equal(existsSync(join(root, rel)), false, rel);
      // Everything outside the part is still written, and nothing is reported missing.
      const others = SKIP_NAMES.filter((n) => n !== part).flatMap((n) => SKIP_PARTS[n]);
      for (const rel of others) assert.ok(existsSync(join(root, rel)), rel);
      assert.deepEqual(summary.warnings, []);
      assert.deepEqual(summary.skipped, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("an omitted part's copy source is never read, so it cannot be reported missing", () => {
  const copySources = Object.values(SKIP_PARTS).flat().filter((rel) => rel !== WORKFLOW && rel !== "AGENTS.md");
  for (const part of SKIP_NAMES) {
    const src = tempRepo();
    const root = tempRepo();
    try {
      // A source holding every copy file except the omitted part's.
      for (const rel of copySources.filter((r) => !SKIP_PARTS[part].includes(r))) {
        mkdirSync(dirname(join(src, rel)), { recursive: true });
        writeFileSync(join(src, rel), readFileSync(join(sourceRoot, rel), "utf8"));
      }
      const { summary } = applyScaffold(root, { prefix: "DEMO", skip: [part] }, {}, src);
      assert.deepEqual(summary.warnings, [], part);
      assert.deepEqual(summary.omitted, [part]);
    } finally { rmSync(src, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  }
});

test("--skip values from repeated flags and comma lists form one union", () => {
  for (const args of [["--skip", "ci", "--skip", "playbooks"], ["--skip", "ci,playbooks"], ["--skip=playbooks", "--skip", "ci,playbooks"]]) {
    const root = tempRepo();
    try {
      for (const flags of [args, [...args, "--dry-run"]]) {
        const r = runInit(root, ["--prefix", "DEMO", ...flags]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /omitted \(2\): ci, playbooks/);
      }
      assert.equal(existsSync(join(root, WORKFLOW)), false);
      assert.equal(existsSync(join(root, "trellis", "playbooks")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("an omitted part whose file already exists is not listed under skipped", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const plain = applyScaffold(root, {}, { dryRun: true }, sourceRoot).summary;
    const { summary } = applyScaffold(root, { skip: ["ci"] }, {}, sourceRoot);
    assert.deepEqual(summary.skipped, plain.skipped.filter((rel) => rel !== WORKFLOW));
    assert.deepEqual(summary.omitted, ["ci"]);
    assert.ok(existsSync(join(root, WORKFLOW)), "an existing file is left alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bad --skip value is a usage error and nothing is written", () => {
  for (const args of [["--skip", "nope"], ["--skip", "ci,nope"], ["--skip", "--force"], ["--skip="], ["--skip", ","], ["--skip"]]) {
    const root = tempRepo();
    try {
      const r = runInit(root, [...args]);
      assert.equal(r.status, 2, args.join(" "));
      assert.deepEqual(readdirSync(root), [], "nothing written");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const root = tempRepo();
  try {
    assert.equal(applyScaffold(root, { skip: ["nope"] }, {}, sourceRoot).summary.errors.length, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip agents writes no AGENTS.md and leaves an existing one out of the reconciliation scan", () => {
  const fresh = tempRepo();
  try {
    applyScaffold(fresh, { skip: ["agents"] }, {}, sourceRoot);
    assert.equal(existsSync(join(fresh, "AGENTS.md")), false);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
  const root = tempRepo();
  try {
    const authored = "# Team guide\n\n## AI Backlog\n\nOld notes.\n";
    writeFileSync(join(root, "AGENTS.md"), authored);
    const noted = (skip) => applyScaffold(root, { skip }, { dryRun: true }, sourceRoot).summary.reconcile.map((r) => r.file);
    assert.deepEqual(noted([]), ["AGENTS.md"]);
    assert.deepEqual(noted(["agents"]), []);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), authored);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip playbooks with --with-playbooks is a usage error and the target is unchanged", () => {
  const root = gitRepo();
  try {
    const before = snapshotWithIndex(root);
    const r = runInit(root, ["--skip", "playbooks", "--with-playbooks"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--skip/);
    assert.match(r.stderr, /--with-playbooks/);
    assert.deepEqual(snapshotWithIndex(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A committed, scaffolded repo the switch and the retirement can both start from.
function committedRepo() {
  const root = gitRepo();
  applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
  mkdirSync(join(root, "planning"), { recursive: true });
  writeFileSync(join(root, "planning", "a.md"), "old task\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

test("--switch-to-local and --retire-source refuse --skip and --with-playbooks, changing nothing", () => {
  const root = committedRepo();
  try {
    const cases = [
      [["--switch-to-local", "--skip", "pr-template"], ["--switch-to-local", "--skip"]],
      [["--switch-to-local", "--with-playbooks"], ["--switch-to-local", "--with-playbooks"]],
      [["--retire-source", "planning", "--skip", "pr-template"], ["--retire-source", "--skip"]],
      [["--retire-source", "planning", "--with-playbooks"], ["--retire-source", "--with-playbooks"]],
    ];
    for (const [args, names] of cases) {
      const before = snapshotWithIndex(root);
      const r = runInit(root, args);
      assert.equal(r.status, 2, args.join(" "));
      for (const n of names) assert.ok(r.stderr.includes(n), `${n} in: ${r.stderr}`);
      assert.deepEqual(snapshotWithIndex(root), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------ block variants (TRL0040)
const CLAIM_RE = /npx @taprootio\/trellis claim --title/;
// The AGENTS.md block `planScaffold` would append to an existing AGENTS.md without one.
const plannedBlock = (root, opts = {}) => markedBlock(planScaffold(root, opts, sourceRoot).actions.find((a) => a.rel === "AGENTS.md").content);

test("the claim line is its own bullet in a ledger config, and absent in scan mode", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    rmSync(join(root, "AGENTS.md"));
    assert.doesNotMatch(plannedBlock(root), CLAIM_RE);
    ledgerTarget(root);
    const lines = plannedBlock(root).split("\n");
    const at = lines.findIndex((l) => CLAIM_RE.test(l));
    assert.ok(at > 0, "the claim line is present");
    assert.ok(lines[at].startsWith("- "), "it starts its own bullet");
    assert.ok(lines[at + 1].startsWith("- "), "the next line starts a new bullet");
    assert.ok(at < lines.findIndex((l) => /BEGIN\/END GENERATED/.test(l)), "it sits before the artifact bullet");
    assert.equal(lines.filter((l) => CLAIM_RE.test(l)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local config gets the .generated/ wording in the full block", () => {
  const root = localInit();
  try {
    assert.match(plannedBlock(root), /trellis\/\.generated\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip playbooks,branch-protection leaves no path to a skipped file in the block", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", skip: ["playbooks", "branch-protection"] }, {}, sourceRoot);
    assert.deepEqual(summary.omitted, ["playbooks", "branch-protection"]);
    const block = markedBlock(readFileSync(join(root, "AGENTS.md"), "utf8"));
    assert.doesNotMatch(block, /trellis\/playbooks\//);
    assert.doesNotMatch(block, /branch-protection\.md/);
    assert.match(block, /### Loop contract/);
    assert.match(block, /`gates`/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip ci writes the pinned skip-variant block", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO", idWidth: 5, skip: ["ci"] }, {}, sourceRoot);
    const block = markedBlock(readFileSync(join(root, "AGENTS.md"), "utf8"));
    assert.equal(block, readFixture("agents-block-skip-ci.md"));
    assert.doesNotMatch(block, /CI runs/);
    assert.match(block, /`main` is protected/);
    assert.match(block, /\| `check` \| `npx @taprootio\/trellis check` \|/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------- detection, compact block, --with-playbooks (TRL0040)
const GOOD_AGENT_MARKERS = ["good-agent.config.json", ".agents/skills/work-task/SKILL.md"];
const PLAYBOOKS = SKIP_PARTS.playbooks;
const DEMO = { prefix: "DEMO", idWidth: 4, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort };
function seedMarker(root, rel = GOOD_AGENT_MARKERS[0]) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), "{}\n");
}
// spawnSync, because `runInit` returns no stderr on an exit-0 run.
const cliRun = (root, args, env = {}) => spawnSync(process.execPath, [initScript, root, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, ...env } });
const tokenLine = (text, token) => text.split("\n").find((l) => l.startsWith(token));
// A detected repo scaffolded once, so its AGENTS.md holds the compact block.
function detectedRepo() {
  const root = tempRepo();
  seedMarker(root);
  applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
  return root;
}
const agentsPath = (root) => join(root, "AGENTS.md");

test("good-agent detection through each marker file skips the playbooks and writes the compact block", () => {
  for (const marker of GOOD_AGENT_MARKERS) {
    const root = tempRepo();
    try {
      seedMarker(root, marker);
      const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
      assert.equal(summary.detected, marker);
      assert.deepEqual(summary.omitted, ["playbooks"]);
      assert.equal(summary.playbooksOmittedBy, "detection");
      for (const rel of PLAYBOOKS) assert.equal(existsSync(join(root, rel)), false, rel);
      assert.equal(markedBlock(readFileSync(agentsPath(root), "utf8")), compactBlock(DEMO));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("--with-playbooks on a detected repo writes the playbooks and the full block with their pointers", () => {
  for (const marker of GOOD_AGENT_MARKERS) {
    const root = tempRepo();
    try {
      seedMarker(root, marker);
      const { summary } = applyScaffold(root, { prefix: "DEMO", withPlaybooks: true }, {}, sourceRoot);
      assert.equal(summary.detected, marker);
      assert.deepEqual(summary.omitted, []);
      assert.equal(summary.playbooksOmittedBy, null);
      for (const rel of PLAYBOOKS) assert.ok(existsSync(join(root, rel)), rel);
      assert.equal(markedBlock(readFileSync(agentsPath(root), "utf8")), agentsBlock(DEMO));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a directory at a marker path is not detected, and --with-playbooks changes nothing without a marker", () => {
  const dirRoot = tempRepo();
  try {
    mkdirSync(join(dirRoot, "good-agent.config.json"));
    const { summary } = applyScaffold(dirRoot, { prefix: "DEMO" }, {}, sourceRoot);
    assert.equal(summary.detected, null);
    assert.deepEqual(summary.omitted, []);
    for (const rel of PLAYBOOKS) assert.ok(existsSync(join(dirRoot, rel)), rel);
  } finally { rmSync(dirRoot, { recursive: true, force: true }); }

  const plain = tempRepo();
  const flagged = tempRepo();
  try {
    applyScaffold(plain, { prefix: "DEMO" }, {}, sourceRoot);
    const { summary } = applyScaffold(flagged, { prefix: "DEMO", withPlaybooks: true }, {}, sourceRoot);
    assert.deepEqual(summary.printed, []);
    assert.deepEqual(snapshotAll(flagged), snapshotAll(plain));
  } finally { rmSync(plain, { recursive: true, force: true }); rmSync(flagged, { recursive: true, force: true }); }
});

test("a detected repo with --skip playbooks reports the explicit skip, not the detection", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    const { summary } = applyScaffold(root, { prefix: "DEMO", skip: ["playbooks"] }, {}, sourceRoot);
    assert.equal(summary.detected, GOOD_AGENT_MARKERS[0]);
    assert.equal(summary.playbooksOmittedBy, "skip");
    const out = cliRun(root, ["--skip", "playbooks"]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(GOOD_AGENT_MARKERS[0]));
    assert.ok(out.stdout.includes("--skip playbooks"), "the cause line names the explicit skip");
    // Detection alone does not name the flag as the cause.
    const alone = tempRepo();
    try {
      seedMarker(alone);
      assert.ok(!cliRun(alone, []).stdout.includes("--skip playbooks"));
    } finally { rmSync(alone, { recursive: true, force: true }); }
    assert.ok(!out.stdout.includes(INIT_TOKENS.blockNotUpdated), "no recovery line for a detected repo");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repo that is not detected and skips the playbooks is told how to add them", () => {
  const root = tempRepo();
  try {
    const r = cliRun(root, ["--skip", "playbooks"]);
    assert.equal(r.status, 0, r.stderr);
    const line = tokenLine(r.stdout.replace(/^ +/gm, ""), INIT_TOKENS.blockNotUpdated);
    assert.ok(line, "the recovery line is present");
    assert.ok(line.includes("trellis init --with-playbooks"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the omitted line names a detection-caused playbook omission, with and without --dry-run", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    for (const flags of [[], ["--dry-run"]]) {
      const r = cliRun(root, flags);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /omitted \(1\): playbooks/);
      assert.ok(r.stdout.includes(GOOD_AGENT_MARKERS[0]));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the compact block: ledger claim line, local wording, committed markers and a byte ceiling", () => {
  const localLedger = localInit({ cfg: { idAllocation: "ledger" } });
  try {
    seedMarker(localLedger);
    const block = plannedBlock(localLedger);
    assert.match(block, CLAIM_RE);
    const lines = block.split("\n");
    const at = lines.findIndex((l) => CLAIM_RE.test(l));
    assert.ok(lines[at].startsWith("- "));
    assert.ok(lines[at + 1].startsWith("- "), "the next line starts a new bullet");
    assert.ok(block.includes(artifactBullet("trellis", "local", "compact")));
    assert.ok(Buffer.byteLength(block) < 1200, `${Buffer.byteLength(block)} bytes`);
  } finally { rmSync(localLedger, { recursive: true, force: true }); }

  const bullet = artifactBullet("trellis", "committed", "compact");
  assert.ok(bullet.includes("`BEGIN/END GENERATED`"));
  assert.ok(bullet.includes("`backlog.json` is generated in full (it has no markers)"));
  assert.ok(bullet.includes("the `BEGIN GENERATED` / `END GENERATED` markers apply only to the Markdown files"));
  // The compact bullet ends its list item, so the switch can recognize it.
  assert.ok(compactBlock(DEMO).includes(`${bullet}\n\n### `));
  // Scan mode has no claim line.
  assert.doesNotMatch(compactBlock(DEMO), CLAIM_RE);
});

test("--with-playbooks on a detected repo with a block leaves AGENTS.md alone and prints the full block", () => {
  const root = detectedRepo();
  try {
    // Multibyte text around the block, so the byte count differs from the character count.
    const head = "# Café ünï 🌱\n\n";
    const tail = "\n## Notes — ünïcode\n";
    writeFileSync(agentsPath(root), head + markedBlock(readFileSync(agentsPath(root), "utf8")) + tail);
    const before = readFileSync(agentsPath(root));
    const full = agentsBlock(DEMO);

    const { summary } = applyScaffold(root, { withPlaybooks: true }, {}, sourceRoot);
    assert.equal(summary.printed.length, 1);
    const [p] = summary.printed;
    assert.equal(p.reason, "existing-block");
    assert.equal(p.block, full);
    const expected = head + full.trimEnd() + "\n" + tail;
    assert.equal(p.bytesNeeded, Buffer.byteLength(expected));
    assert.ok(p.bytesNeeded > expected.length, "bytes, not characters");
    assert.ok(readFileSync(agentsPath(root)).equals(before), "AGENTS.md is byte-identical");
    for (const rel of PLAYBOOKS) assert.ok(existsSync(join(root, rel)), rel);

    const r = cliRun(root, ["--with-playbooks"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(full));
    const line = tokenLine(r.stderr, INIT_TOKENS.carryOver);
    assert.ok(line, "the carry-over warning is on stderr");
    assert.ok(line.includes(String(p.bytesNeeded)) && line.includes(String(AGENTS_BYTE_LIMIT)));
    assert.ok(readFileSync(agentsPath(root)).equals(before));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dry run of --with-playbooks previews the block and changes nothing", () => {
  const root = detectedRepo();
  try {
    const before = snapshotAll(root);
    const r = cliRun(root, ["--with-playbooks", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(tokenLine(r.stdout, INIT_TOKENS.preview), "marked as a preview");
    assert.ok(r.stdout.includes(agentsBlock(DEMO)));
    assert.deepEqual(snapshotAll(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--with-playbooks prints nothing when the repo is not detected", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const r = cliRun(root, ["--with-playbooks"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(INIT_TOKENS.preview) && !r.stdout.includes("<!-- BEGIN TRELLIS -->"));
    assert.ok(!r.stderr.includes(INIT_TOKENS.carryOver));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unterminated BEGIN TRELLIS keeps the skip behavior: nothing printed, no size report", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(agentsPath(root), `# Guide\n\n${AGENTS_MARKERS[0]}\nno end marker here\n`);
    const before = readFileSync(agentsPath(root));
    const r = cliRun(root, ["--with-playbooks"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(INIT_TOKENS.preview) && !r.stderr.includes(INIT_TOKENS.carryOver));
    assert.ok(readFileSync(agentsPath(root)).equals(before));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip agents with --with-playbooks restores the playbooks and touches nothing about AGENTS.md", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    // An authored backlog heading would be flagged by the reconciliation scan if AGENTS.md were scanned.
    writeFileSync(agentsPath(root), "# Notes\n\n## Our backlog\n\nOld guidance.\n\n" + markedBlock(readFileSync(agentsPath(root), "utf8")));
    const before = readFileSync(agentsPath(root));
    const r = cliRun(root, ["--skip", "agents", "--with-playbooks"]);
    assert.equal(r.status, 0, r.stderr);
    for (const rel of PLAYBOOKS) assert.ok(existsSync(join(root, rel)), rel);
    assert.ok(readFileSync(agentsPath(root)).equals(before));
    assert.ok(!r.stdout.includes("<!-- BEGIN TRELLIS -->") && !r.stdout.includes(INIT_TOKENS.preview));
    assert.ok(!r.stderr.includes(INIT_TOKENS.carryOver));
    assert.doesNotMatch(r.stdout, /reconcile/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a printed block over 64 KiB reaches a pipe whole, through --with-playbooks --dry-run --import", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    mkdirSync(join(root, "trellis"), { recursive: true });
    const cfg = { specVersion: "2.5", idPrefix: "TAP", idWidth: 70000, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort };
    writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(cfg, null, 2) + "\n");
    writeFileSync(agentsPath(root), `${AGENTS_MARKERS[0]}\nold\n${AGENTS_MARKERS[1]}\n`);
    const before = snapshotAll(root);
    const r = cliRun(root, ["--with-playbooks", "--dry-run", "--import", legacySrc, "--profile", "taproot-ai-backlog"]);
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const full = agentsBlock({ ...DEMO, prefix: "TAP", idWidth: 70000 });
    assert.ok(full.length > 65536);
    assert.ok(r.stdout.includes(full), "the whole block arrives");
    assert.deepEqual(snapshotAll(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an import refused after the scaffold exits 2 without a stack trace", { skip: process.platform === "win32" }, () => {
  const root = localInit();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "trellis-shim-")));
  try {
    // git fails its prefix probe only once the scaffold has written its tree, which is
    // after the scaffold's own preflight and before the import's.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--show-prefix" ] && [ -e "${root}/trellis/active/.gitkeep" ]; then echo "fatal: forced failure" >&2; exit 128; fi\ndone\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const r = cliRun(root, ["--import", legacySrc, "--profile", "taproot-ai-backlog"], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^error: .*forced failure/m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  } finally { rmSync(bin, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------- size guard (TRL0040)
// A block's AGENTS.md size grows one byte per `idWidth`, so a wide width lands a fresh
// target's file exactly on the limit.
const HEADING = "# AGENTS\n\n";
const freshBytes = (idWidth) => Buffer.byteLength(HEADING + agentsBlock({ ...DEMO, idWidth }));
function widthForBytes(target) {
  let w = 1;
  while (freshBytes(w) < target) w += Math.max(1, Math.floor((target - freshBytes(w)) / 2));
  assert.equal(freshBytes(w), target, "a width that lands on the byte count");
  return w;
}
// 32,600 bytes of AGENTS.md from multibyte text (fewer characters than bytes).
const multibyteAgents = (bytes) => "é".repeat((bytes - 2) / 2) + "x\n";

test("an AGENTS.md the block would push over the limit is left alone, the block is printed and the rest is written", () => {
  const root = tempRepo();
  try {
    const cur = multibyteAgents(32600);
    assert.equal(Buffer.byteLength(cur), 32600);
    writeFileSync(agentsPath(root), cur);
    const r = cliRun(root, ["--prefix", "DEMO"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(agentsPath(root), "utf8"), cur, "never written");
    const block = agentsBlock(DEMO);
    assert.ok(r.stdout.includes(block));
    const needed = Buffer.byteLength(cur + "\n" + block);
    const line = tokenLine(r.stderr, INIT_TOKENS.size);
    assert.ok(line, "the size warning is on stderr");
    assert.ok(line.includes(String(needed)) && line.includes(String(AGENTS_BYTE_LIMIT)));
    assert.ok(tokenLine(r.stderr, INIT_TOKENS.carryOver));
    assert.ok(!tokenLine(r.stderr, INIT_TOKENS.carryOver).includes(String(needed)), "the size path keeps its count on the size line");
    assert.ok(existsSync(join(root, "trellis", "backlog.config.json")), "other files are written");
    assertCheckClean(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the size guard counts bytes, not characters", () => {
  const root = tempRepo();
  try {
    const cur = "é".repeat(20000);
    assert.ok(cur.length < AGENTS_BYTE_LIMIT && Buffer.byteLength(cur) > AGENTS_BYTE_LIMIT);
    // Already over before the block: the append is still printed, not written.
    writeFileSync(agentsPath(root), cur);
    const { summary } = applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    assert.equal(summary.printed.length, 1);
    assert.equal(summary.printed[0].reason, "size");
    assert.equal(readFileSync(agentsPath(root), "utf8"), cur);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a result of exactly 32,768 bytes is written and 32,769 is printed, the heading counted on a create", () => {
  const exact = tempRepo();
  const over = tempRepo();
  try {
    const wExact = widthForBytes(AGENTS_BYTE_LIMIT);
    const a = applyScaffold(exact, { prefix: "DEMO", idWidth: wExact }, {}, sourceRoot).summary;
    assert.deepEqual(a.printed, []);
    assert.equal(statSync(agentsPath(exact)).size, AGENTS_BYTE_LIMIT);

    const b = applyScaffold(over, { prefix: "DEMO", idWidth: widthForBytes(AGENTS_BYTE_LIMIT + 1) }, {}, sourceRoot).summary;
    assert.equal(b.printed.length, 1);
    assert.equal(b.printed[0].bytesNeeded, AGENTS_BYTE_LIMIT + 1, "the reported count includes the # AGENTS heading");
    assert.equal(existsSync(agentsPath(over)), false, "a create is never written either");
  } finally { rmSync(exact, { recursive: true, force: true }); rmSync(over, { recursive: true, force: true }); }
});

test("a dry run of the size guard previews the block and leaves the target unchanged", () => {
  const root = tempRepo();
  try {
    writeFileSync(agentsPath(root), multibyteAgents(32600));
    const before = snapshotAll(root);
    const r = cliRun(root, ["--prefix", "DEMO", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(tokenLine(r.stdout, INIT_TOKENS.preview));
    assert.ok(r.stdout.includes(agentsBlock(DEMO)));
    assert.ok(tokenLine(r.stderr, INIT_TOKENS.size));
    assert.deepEqual(snapshotAll(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--skip agents leaves an oversize AGENTS.md alone and prints and warns nothing for it", () => {
  const root = tempRepo();
  try {
    const cur = multibyteAgents(32600);
    writeFileSync(agentsPath(root), cur);
    const r = cliRun(root, ["--prefix", "DEMO", "--skip", "agents"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(agentsPath(root), "utf8"), cur);
    assert.ok(!r.stdout.includes("<!-- BEGIN TRELLIS -->"));
    assert.ok(!r.stderr.includes(INIT_TOKENS.size) && !r.stderr.includes(INIT_TOKENS.carryOver));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a size-guard block over 64 KiB reaches a pipe whole", () => {
  const root = tempRepo();
  try {
    const r = cliRun(root, ["--prefix", "DEMO", "--id-width", "70000"]);
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const block = agentsBlock({ ...DEMO, idWidth: 70000 });
    assert.ok(block.length > 65536);
    assert.ok(r.stdout.includes(block));
    assert.equal(existsSync(agentsPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------ init output, guide, pr-draft (TRL0040)
const DONE_LINES = (stdout) => stdout.slice(stdout.indexOf("Done.")).split("\n");
// The text of a `## ` section, from its heading to the next `## ` heading.
const sectionOf = (text, heading) => {
  const from = text.indexOf(`\n${heading}\n`) + 1;
  assert.ok(from > 0, heading);
  const next = text.indexOf("\n## ", from + heading.length);
  return text.slice(from, next === -1 ? undefined : next);
};

test("the completion message follows --skip ci and --skip branch-protection", () => {
  const root = tempRepo();
  try {
    const real = cliRun(root, ["--prefix", "DEMO", "--skip", "ci"]);
    assert.equal(real.status, 0, real.stderr);
    const ciDone = DONE_LINES(real.stdout).join("\n");
    assert.ok(ciDone.includes("trellis check"));
    assert.ok(!ciDone.includes("`backlog`"));
  } finally { rmSync(root, { recursive: true, force: true }); }

  const bp = tempRepo();
  try {
    const r = cliRun(bp, ["--prefix", "DEMO", "--skip", "branch-protection"]);
    assert.equal(r.status, 0, r.stderr);
    const done = DONE_LINES(r.stdout).join("\n");
    assert.ok(!done.includes("branch-protection.md"));
    assert.ok(done.includes("`backlog`"), "the job still exists, so the gate line names it");
  } finally { rmSync(bp, { recursive: true, force: true }); }
});

test("the one universal branch-protection guide names the owner's CI status and offers backlog only as an example", () => {
  const root = tempRepo();
  try {
    // The guide is scaffolded by `--skip ci` alone, which also shows it was not omitted.
    applyScaffold(root, { prefix: "DEMO", skip: ["ci"] }, {}, sourceRoot);
    const guide = readFileSync(join(root, "trellis", "branch-protection.md"), "utf8");
    assert.equal(guide, readFileSync(join(sourceRoot, "templates", "trellis", "branch-protection.md"), "utf8"));
    assert.equal(guide, readFileSync(join(sourceRoot, "trellis", "branch-protection.md"), "utf8"));

    assert.ok(guide.slice(0, guide.indexOf("\n## ")).includes("your CI status"), "intro");
    assert.ok(sectionOf(guide, "## GitHub").includes("your CI status"), "setup");
    assert.ok(sectionOf(guide, "## Verify the gate").includes("your CI status"), "verify");
    assert.ok(guide.includes('"contexts": ["<your-ci-status>"]'));
    assert.ok(guide.includes("Use PUT only to create a new protection rule"));
    assert.ok(guide.includes("if you installed Trellis's workflow"));
    assert.ok(guide.includes("gh api"));
    assert.ok(guide.includes("edit the rule that covers the default branch"), "owners with a rule edit it");

    // `backlog` lives only in the bounded example section.
    const example = /^### Example: if you installed Trellis's workflow\n[\s\S]*?(?=^## )/m.exec(guide);
    assert.ok(example, "the example section exists");
    assert.match(example[0], /`backlog`/);
    assert.match(example[0], /not `?Backlog Hygiene/);
    assert.doesNotMatch(guide.replace(example[0], ""), /backlog/i);
    assert.doesNotMatch(guide.match(/^## The required-check context.*$/m)[0], /backlog/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("both pr-draft.md copies carry the two branches, and no PR template points at the playbook", () => {
  for (const rel of ["trellis/playbooks/pr-draft.md", "templates/trellis/playbooks/pr-draft.md"]) {
    const text = readFileSync(join(sourceRoot, rel), "utf8");
    for (const h of ["## With a PR template", "## Without a PR template", "## Title and attribution (both branches)"]) assert.ok(text.includes(`\n${h}\n`), `${rel}: ${h}`);
    const withT = sectionOf(text, "## With a PR template");
    const without = sectionOf(text, "## Without a PR template");
    const intro = text.slice(0, text.indexOf("\n## "));
    const SECTIONS = /Summary, Task, Changes, Verification, Follow-ups/;
    assert.match(withT, SECTIONS);
    assert.match(withT, /pull_request_template/);
    assert.doesNotMatch(without, /pull_request_template/);
    assert.doesNotMatch(without + intro + sectionOf(text, "## Title and attribution (both branches)"), SECTIONS);
    assert.doesNotMatch(intro, /pull_request_template/);
    assert.ok(without.includes("AGENTS.md") && without.includes("CONTRIBUTING"));
    assert.ok(without.includes("# <ID>: <summary>"));
  }
  for (const rel of [".github/pull_request_template.md", "templates/.github/pull_request_template.md"]) {
    const text = readFileSync(join(sourceRoot, rel), "utf8");
    assert.ok(!text.includes("trellis/playbooks/pr-draft.md"), rel);
    assert.match(text, /attribution policy \(AGENTS\.md\)/i);
  }
});

test("init --help lists --skip and --with-playbooks and carries the recovery token", () => {
  const r = spawnSync(process.execPath, [initScript, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const flags = r.stdout.slice(r.stdout.indexOf("Flags:"), r.stdout.indexOf("\n\n", r.stdout.indexOf("Flags:")));
  assert.ok(flags.includes("--skip") && flags.includes("--with-playbooks"));
  for (const part of SKIP_NAMES) assert.ok(flags.includes(part), part);
  assert.ok(r.stdout.includes(INIT_TOKENS.blockNotUpdated));
  assert.ok(r.stdout.includes(String(AGENTS_BYTE_LIMIT)));
  // The migration paragraph tells the follow-up ordinary init to repeat the skips, and
  // does not ask for --with-playbooks, which the switch rejects.
  const start = r.stdout.indexOf("--switch-to-local is a standalone");
  const paragraph = r.stdout.slice(start, r.stdout.indexOf("\n\n", start));
  assert.ok(paragraph.includes("--skip"));
  assert.ok(!paragraph.includes("--with-playbooks"));
});

test("a comma list inside one --skip value is normalized before planning", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", skip: ["ci,agents"] }, {}, sourceRoot);
    assert.deepEqual(summary.omitted, ["ci", "agents"]);
    assert.equal(existsSync(join(root, WORKFLOW)), false);
    assert.equal(existsSync(agentsPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("under --skip agents the new README points at the spec, not AGENTS.md", () => {
  const root = tempRepo();
  const plain = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO", skip: ["agents"] }, {}, sourceRoot);
    const readme = readFileSync(join(root, "trellis", "README.md"), "utf8");
    assert.ok(!readme.includes("AGENTS.md"));
    assert.ok(readme.includes("SPEC.md"));
    assertCheckClean(root);
    applyScaffold(plain, { prefix: "DEMO" }, {}, sourceRoot);
    assert.ok(readFileSync(join(plain, "trellis", "README.md"), "utf8").includes("AGENTS.md"));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

test("when the size guard keeps AGENTS.md from being created, the new README links the spec", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", idWidth: widthForBytes(AGENTS_BYTE_LIMIT + 1) }, {}, sourceRoot);
    assert.equal(summary.printed.length, 1);
    const readme = readFileSync(join(root, "trellis", "README.md"), "utf8");
    assert.ok(!readme.includes("AGENTS.md") && readme.includes("SPEC.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the recovery commands say to run them from the target repository", () => {
  const root = tempRepo();
  try {
    const skipped = cliRun(root, ["--skip", "playbooks"]);
    assert.ok(skipped.stdout.includes("from the target repository"));
    seedMarker(root);
    assert.ok(cliRun(root, ["--dry-run"]).stdout.includes("from the target repository"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the CLI recovery command carries the remaining skips", () => {
  const root = tempRepo();
  try {
    const r = cliRun(root, ["--skip", "ci,playbooks"]);
    assert.ok(tokenLine(r.stdout.replace(/^ +/gm, ""), INIT_TOKENS.blockNotUpdated).includes("trellis init --with-playbooks --skip ci"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an appended AGENTS.md kept out by the size guard also gets a README that links the spec", () => {
  const root = tempRepo();
  try {
    writeFileSync(agentsPath(root), multibyteAgents(32600));
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const readme = readFileSync(join(root, "trellis", "README.md"), "utf8");
    assert.ok(!readme.includes("AGENTS.md") && readme.includes("SPEC.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a detected repo with --skip ci prints the restore command with that skip", () => {
  const root = tempRepo();
  try {
    seedMarker(root);
    const r = cliRun(root, ["--skip", "ci"]);
    assert.ok(r.stdout.includes("trellis init --with-playbooks --skip ci"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("applyScaffold refuses skip playbooks with withPlaybooks and writes nothing", () => {
  const root = tempRepo();
  try {
    const { summary } = applyScaffold(root, { prefix: "DEMO", skip: ["playbooks"], withPlaybooks: true }, {}, sourceRoot);
    assert.equal(summary.errors.length, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
