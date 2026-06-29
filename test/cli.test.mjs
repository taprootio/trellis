// Packaged CLI behavior tests. These exercise the npm-bin dispatcher from outside
// the Trellis source checkout so target repos are resolved from cwd / --target,
// while package assets still come from this checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { applyScaffold } from "../src/init.mjs";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliScript = join(sourceRoot, "scripts", "trellis.mjs");
const legacySrc = join(sourceRoot, "test", "fixtures", "legacy-backlog");
const tempRepo = () => mkdtempSync(join(tmpdir(), "trellis-cli-"));

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

test("packaged generate/check operate on cwd by default, not the package checkout", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/backlog.json"), "{}\n");

    execFileSync(process.execPath, [cliScript, "generate"], { cwd: root, encoding: "utf8" });
    assertCheckClean(root);

    const out = execFileSync(process.execPath, [cliScript, "check"], { cwd: root, encoding: "utf8" });
    assert.match(out, /Backlog check OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged generate/check accept --target from another cwd", () => {
  const root = tempRepo();
  const other = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis/backlog.json"), "{}\n");

    const stale = spawnSync(process.execPath, [cliScript, "check", "--target", root], { cwd: other, encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /trellis\/backlog\.json is stale/);

    execFileSync(process.execPath, [cliScript, "generate", "--repo", root], { cwd: other, encoding: "utf8" });
    const clean = execFileSync(process.execPath, [cliScript, "check", "--target", root], { cwd: other, encoding: "utf8" });
    assert.match(clean, /Backlog check OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("successful CLI reports advisory warnings before the final line on stdout", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const res = spawnSync(
      process.execPath,
      [cliScript, "import", legacySrc, "--profile", "taproot-ai-backlog", "--target", root],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
    const warningAt = res.stdout.indexOf("  warning:");
    const finalAt = res.stdout.indexOf("Dry run");
    assert.ok(warningAt !== -1, "expected import warnings in stdout");
    assert.ok(finalAt !== -1, "expected final dry-run line in stdout");
    assert.ok(warningAt < finalAt, "warnings should be grouped before the final line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged pr-title uses the target repo vocabulary", () => {
  const root = tempRepo();
  const other = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const res = spawnSync(
      process.execPath,
      [cliScript, "pr-title", "--target", root],
      { cwd: other, encoding: "utf8", env: { ...process.env, PR_TITLE: "DEMO0001: add package cli" } },
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PR title OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
