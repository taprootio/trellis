// Packaged CLI behavior tests. These exercise the npm-bin dispatcher from outside
// the Trellis source checkout so target repos are resolved from cwd / --target,
// while package assets still come from this checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, symlinkSync, renameSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { applyScaffold } from "../src/init.mjs";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliScript = join(sourceRoot, "scripts", "trellis.mjs");
const legacySrc = join(sourceRoot, "test", "fixtures", "legacy-backlog");
const tempRepo = () => mkdtempSync(join(tmpdir(), "trellis-cli-"));
const TEMPLATE_PAIRS = [
  ["trellis/playbooks/conventions.md", "templates/trellis/playbooks/conventions.md"],
  ["trellis/playbooks/work-task.md", "templates/trellis/playbooks/work-task.md"],
  ["trellis/playbooks/code-review.md", "templates/trellis/playbooks/code-review.md"],
  ["trellis/playbooks/pr-draft.md", "templates/trellis/playbooks/pr-draft.md"],
  ["trellis/branch-protection.md", "templates/trellis/branch-protection.md"],
  [".github/pull_request_template.md", "templates/.github/pull_request_template.md"],
];

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
    assert.doesNotMatch(res.stderr, /Done\.|Dry run/, "the final success line should not be routed to stderr");
    const lines = res.stdout.trimEnd().split("\n");
    const warningAt = lines.findIndex((line) => line.startsWith("  warning:"));
    const finalAt = lines.findIndex((line) => line === "Dry run — nothing written. Re-run with --apply to write.");
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

test("packaged scaffold templates match the live scaffold sources", () => {
  for (const [live, tmpl] of TEMPLATE_PAIRS) {
    assert.equal(
      readFileSync(join(sourceRoot, tmpl), "utf8"),
      readFileSync(join(sourceRoot, live), "utf8"),
      `${tmpl} should match ${live}`,
    );
  }
});

test("package ships scaffold templates without the live backlog index", () => {
  const cache = mkdtempSync(join(tmpdir(), "trellis-npm-cache-"));
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
    });
    const [{ files }] = JSON.parse(out);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("docs/import.md"), "the README-linked import guide should ship");
    assert.ok(paths.includes("templates/trellis/playbooks/work-task.md"), "playbook templates should ship");
    assert.ok(paths.includes("templates/trellis/branch-protection.md"), "branch-protection template should ship");
    assert.ok(paths.includes("templates/.github/pull_request_template.md"), "PR template should ship");
    assert.equal(paths.includes("trellis/README.md"), false, "the live generated backlog index should not ship");
    assert.equal(paths.some((p) => p.startsWith("trellis/active/")), false, "live backlog items should not ship");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ trellis claim
// A git repo with a ledger-mode (or scan-mode) scaffold and one linked worktree.
function claimRepo(cfgOverrides = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trellis-claim-")));
  const root = join(dir, "main");
  mkdirSync(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "--ref-format=files", "-b", "main");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "user.email", "tester@example.com");
  applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
  const cfgPath = join(root, "trellis/backlog.config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), idAllocation: "ledger", ...cfgOverrides }, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const lane = join(dir, "lane");
  git(root, "worktree", "add", "-q", "-b", "lane", lane);
  return { dir, root, lane, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (cwd, args, extra = {}) => spawnSync(process.execPath, [cliScript, ...args], { cwd, encoding: "utf8", ...extra });
const REF = "refs/trellis/ids";
const refTip = (root) => { try { return execFileSync("git", ["-C", root, "rev-parse", "--verify", "-q", REF], { encoding: "utf8" }).trim(); } catch { return null; } };

test("claim: mode matrix and exit codes", () => {
  const c = claimRepo();
  try {
    // Ref absent: --title, --through and --list refuse and name --seed.
    for (const args of [["claim", "--title", "x"], ["claim", "--through", "DEMO0009"], ["claim", "--list"]]) {
      const r = run(c.root, args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /claim --seed/);
    }
    assert.equal(refTip(c.root), null);

    const seeded = run(c.root, ["claim", "--seed"]);
    assert.equal(seeded.status, 0, seeded.stderr);
    const t = refTip(c.root);
    const again = run(c.root, ["claim", "--seed"]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing was written/);
    assert.equal(refTip(c.root), t);

    const a = run(c.root, ["claim", "--title", "First"]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout.trim(), "DEMO0001");
    const b = run(c.lane, ["claim", "--title", "Second"]);
    assert.equal(b.stdout.trim(), "DEMO0002");

    const through = run(c.root, ["claim", "--through", "DEMO0050"]);
    assert.equal(through.status, 0, through.stderr);
    assert.equal(run(c.root, ["claim", "--title", "After"]).stdout.trim(), "DEMO0051");

    // --list shows every kind, header first.
    const listed = run(c.root, ["claim", "--list"]);
    assert.equal(listed.status, 0);
    const lines = listed.stdout.trim().split("\n");
    assert.equal(lines[0], `tip ${refTip(c.root)}`);
    assert.equal(lines[1], "id\tdate\tkind\tbranch\ttitle");
    const kinds = lines.slice(2).map((l) => l.split("\t")[2]);
    assert.deepEqual(kinds, ["claim", "claim", "through", "claim"]);
  } finally { c.cleanup(); }
});

test("claim: --seed lists seed rows and works before the config switches", () => {
  const c = claimRepo({ idAllocation: "scan" });
  try {
    mkdirSync(join(c.lane, "trellis/active"), { recursive: true });
    writeFileSync(join(c.lane, "trellis/active/DEMO0007.md"), "---\nid: DEMO0007\ntitle: Lane only\nstatus: active\n---\n");
    const r = run(c.root, ["claim", "--seed"]);
    assert.equal(r.status, 0, r.stderr);
    const listed = run(c.root, ["claim", "--list"]).stdout;
    assert.match(listed, /DEMO0007\t\d{4}-\d{2}-\d{2}\tseed\tlane\tLane only/);
    // --title still needs ledger mode.
    const t = run(c.root, ["claim", "--title", "x"]);
    assert.equal(t.status, 2);
    assert.match(t.stderr, /idAllocation/);
  } finally { c.cleanup(); }
});

test("claim: scan-mode --seed and --through refuse a prefix that is not plain", () => {
  for (const prefix of ["A,B", "R+"]) {
    const c = claimRepo({ idAllocation: "scan", idPrefix: prefix });
    try {
      for (const args of [["claim", "--seed"], ["claim", "--through", `${prefix}0001`]]) {
        const r = run(c.root, args);
        assert.equal(r.status, 2, `${prefix} ${args.join(" ")}`);
      }
      assert.equal(refTip(c.root), null);
    } finally { c.cleanup(); }
  }
});

test("claim: a tab or newline in --title exits 2 and writes nothing", () => {
  const c = claimRepo();
  try {
    run(c.root, ["claim", "--seed"]);
    const t = refTip(c.root);
    for (const title of ["a\tb", "a\nb"]) {
      const r = run(c.root, ["claim", "--title", title]);
      assert.equal(r.status, 2);
    }
    assert.equal(refTip(c.root), t);
  } finally { c.cleanup(); }
});

test("claim: two spawned processes get distinct, consecutive ids", async () => {
  const c = claimRepo();
  try {
    run(c.root, ["claim", "--seed"]);
    const go = (cwd, n) => new Promise((resolve) => {
      let out = "";
      const p = spawn(process.execPath, [cliScript, "claim", "--title", `from ${n}`], { cwd, stdio: ["ignore", "pipe", "inherit"] });
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", (code) => resolve({ code, id: out.trim() }));
    });
    const results = await Promise.all([go(c.root, "a"), go(c.lane, "b"), go(c.root, "c"), go(c.lane, "d")]);
    assert.ok(results.every((r) => r.code === 0));
    assert.deepEqual(results.map((r) => r.id).sort(), ["DEMO0001", "DEMO0002", "DEMO0003", "DEMO0004"]);
  } finally { c.cleanup(); }
});

test("claim: --seed --through on an existing ledger writes nothing and names claim --through", () => {
  const c = claimRepo();
  try {
    run(c.root, ["claim", "--seed"]);
    const t = refTip(c.root);
    const r = run(c.root, ["claim", "--seed", "--through", "DEMO0100"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing was written/);
    assert.match(r.stdout, /claim --through/);
    assert.equal(refTip(c.root), t);
  } finally { c.cleanup(); }
});

test("claim: exits 1 when every retry loses the compare-and-swap", { skip: process.platform === "win32" }, () => {
  const c = claimRepo();
  try {
    run(c.root, ["claim", "--seed"]);
    // A git shim that lets a rival claim land just before every ref update.
    const ledgerUrl = new URL("../src/ledger.mjs", import.meta.url).href;
    const rival = join(c.dir, "rival.mjs");
    writeFileSync(rival, `import { claim } from ${JSON.stringify(ledgerUrl)};
      claim(${JSON.stringify(c.lane)}, { idPrefix: "DEMO", idWidth: 4, idAllocation: "ledger" }, { title: "rival" });`);
    const bin = join(c.dir, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh
if [ -z "$SHIM_OFF" ]; then
  for a in "$@"; do
    if [ "$a" = "update-ref" ]; then SHIM_OFF=1 "${process.execPath}" "${rival}"; fi
  done
fi
exec "${realGit}" "$@"
`);
    chmodSync(join(bin, "git"), 0o755);
    const r = run(c.root, ["claim", "--title", "mine"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /after 10 attempts/);
    const rows = run(c.root, ["claim", "--list"]).stdout;
    assert.doesNotMatch(rows, /\tmine/);
  } finally { c.cleanup(); }
});

test("generate in ledger mode prints the claim note, never Next id", () => {
  const c = claimRepo();
  try {
    // Ref absent: the note carries the seed reason.
    let r = run(c.root, ["generate"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Next id:/);
    assert.match(r.stdout, /claim --seed/);

    run(c.root, ["claim", "--seed"]);
    r = run(c.root, ["generate"]);
    assert.doesNotMatch(r.stdout, /Next id:/);
    assert.match(r.stdout, /claim ids with `trellis claim`/);
  } finally { c.cleanup(); }
});

test("generate in ledger mode names the exhaustion reason at the width limit", () => {
  const c = claimRepo({ idWidth: 1 });
  try {
    run(c.root, ["claim", "--seed"]);
    assert.equal(run(c.root, ["claim", "--through", "DEMO9"]).status, 0);
    const r = run(c.root, ["generate"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Next id:/);
    assert.match(r.stdout, /exhausted/);
    const claimed = run(c.root, ["claim", "--title", "x"]);
    assert.equal(claimed.status, 2);
  } finally { c.cleanup(); }
});

test("generate in scan mode still prints Next id", () => {
  const c = claimRepo({ idAllocation: "scan" });
  try {
    const r = run(c.root, ["generate"]);
    assert.match(r.stdout, /Next id: DEMO0001/);
  } finally { c.cleanup(); }
});

test("the readme script in ledger mode refuses a dangling README before rendering", { skip: process.platform === "win32" }, () => {
  const c = claimRepo();
  try {
    assert.equal(run(c.root, ["claim", "--seed"]).status, 0);
    const link = join(c.root, "trellis/README.md");
    rmSync(link);
    symlinkSync(join(c.root, "nowhere.md"), link);
    const r = spawnSync(process.execPath, [join(sourceRoot, "scripts/backlog-readme.mjs"), "--target", c.root], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /README\.md is a symlink/);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(existsSync(join(c.root, "nowhere.md")), false);
  } finally { c.cleanup(); }
});

for (const dangling of [false, true]) {
  test(`generate in ledger mode refuses a symlinked backlog.json (${dangling ? "dangling" : "live"}) and init does too`, { skip: process.platform === "win32" }, () => {
    const c = claimRepo();
    try {
      assert.equal(run(c.root, ["claim", "--seed"]).status, 0);
      const before = refTip(c.root);
      const link = join(c.root, "trellis/backlog.json");
      const real = join(c.root, "real.json");
      if (dangling) rmSync(link); else renameSync(link, real);
      symlinkSync(real, link);
      const r = run(c.root, ["generate"]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /backlog\.json/);
      const i = run(dirname(c.root), ["init", c.root]);
      assert.equal(i.status, 2, i.stderr);
      assert.match(i.stderr, /backlog\.json/);
      assert.equal(refTip(c.root), before);
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(existsSync(real), !dangling, "nothing was written through the link");
    } finally { c.cleanup(); }
  });
}
