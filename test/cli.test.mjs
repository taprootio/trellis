// Packaged CLI behavior tests. These exercise the npm-bin dispatcher from outside
// the Trellis source checkout so target repos are resolved from cwd / --target,
// while package assets still come from this checkout.

import { test } from "node:test";
import { ledgerTest, initRefFormat } from "./git-support.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, symlinkSync, renameSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  git(root, "init", "-q", ...initRefFormat, "-b", "main");
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

ledgerTest("claim: mode matrix and exit codes", () => {
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

ledgerTest("claim: --seed lists seed rows and works before the config switches", () => {
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

ledgerTest("claim: a tab or newline in --title exits 2 and writes nothing", () => {
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

ledgerTest("claim: two spawned processes get distinct, consecutive ids", async () => {
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

ledgerTest("claim: --seed --through on an existing ledger writes nothing and names claim --through", () => {
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

ledgerTest("claim: exits 1 when every retry loses the compare-and-swap", { skip: process.platform === "win32" }, () => {
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

ledgerTest("generate in ledger mode prints the claim note, never Next id", () => {
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

ledgerTest("generate in ledger mode names the exhaustion reason at the width limit", () => {
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

ledgerTest("the readme script in ledger mode refuses a dangling README before rendering", { skip: process.platform === "win32" }, () => {
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
  ledgerTest(`generate in ledger mode refuses a symlinked backlog.json (${dangling ? "dangling" : "live"}) and init does too`, { skip: process.platform === "win32" }, () => {
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

// ------------------------------------------ local generated artifacts (TRL0038)
const readmeScript = join(sourceRoot, "scripts", "backlog-readme.mjs");
const localOutputUrl = pathToFileURL(join(sourceRoot, "src", "local-output.mjs")).href;
const LOCAL_BASE = { specVersion: "2.5", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High", "Low"], effort: [1, 2, 3, 5], generatedArtifacts: "local" };
const ITEM = (id, extra = "") => `---\nid: ${id}\ntitle: Task ${id}\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 3\ndepends_on: []\nsummary: Summary.\n${extra}---\n\nBody.\n`;
const GEN = ["index.md", "completed.md", "removed.md", "backlog.json"];

// A local-mode repo with one active item and a marker-free README. `git: false`
// leaves it outside any work tree; `ignore: false` omits the ignore rule.
function localRepo({ cfg = {}, git: inGit = true, ignore = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trellis-local-cli-")));
  const t = join(root, "trellis");
  for (const d of ["active", "completed/tasks", "removed"]) mkdirSync(join(t, d), { recursive: true });
  writeFileSync(join(t, "backlog.config.json"), JSON.stringify({ ...LOCAL_BASE, ...cfg }, null, 2) + "\n");
  writeFileSync(join(t, "README.md"), "# Backlog\n\nAuthored prose.\n");
  writeFileSync(join(t, "active", "DEMO0001.md"), ITEM("DEMO0001"));
  if (inGit) {
    execFileSync("git", ["-C", root, "init", "-q", ...initRefFormat, "-b", "main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Tester"]);
    execFileSync("git", ["-C", root, "config", "user.email", "tester@example.com"]);
  }
  if (ignore) writeFileSync(join(root, ".gitignore"), "trellis/.generated/\n");
  return { root, gen: join(t, ".generated"), readme: join(t, "README.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const generate = (c, extra = {}) => run(c.root, ["generate"], extra);
const checkCmd = (c, extra = {}) => run(c.root, ["check"], extra);
// A tree snapshot (path and bytes) so "writes nothing" compares the whole repo, not a guess.
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name === ".git") continue;
      const p = join(dir, name.name);
      if (name.isDirectory()) { out[p.slice(root.length)] = "<dir>"; walk(p); }
      else out[p.slice(root.length)] = lstatSync(p).isSymbolicLink() ? "<link>" : readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}
// A `git` first on PATH that fails commands containing `when` (or only logs when null).
function shimPath(c, when, body) {
  const bin = join(c.root, "..", `shim-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const log = join(bin, "calls.log");
  const guard = when ? `for a in "$@"; do\n  if [ "$a" = "${when}" ]; then\n${body}\n  fi\ndone\n` : "";
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\n${guard}exec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log, cleanup: () => rmSync(bin, { recursive: true, force: true }) };
}
// Runs backlog-readme.mjs in-process with the writer's test seam failing write `n`.
function generateFailingAt(root, n) {
  const code = `import { testSeams } from ${JSON.stringify(localOutputUrl)};
testSeams.beforeWrite = (_path, i) => { if (i === ${n}) throw new Error("forced failure"); };
process.argv = [process.argv[0], ${JSON.stringify(readmeScript)}, "--target", ${JSON.stringify(root)}];
await import(${JSON.stringify(pathToFileURL(readmeScript).href)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
}

test("local generate writes four files under .generated/ and leaves README byte-identical", () => {
  const c = localRepo();
  try {
    const readme = readFileSync(c.readme, "utf8");
    const r = generate(c);
    assert.equal(r.status, 0, r.stderr);
    for (const n of GEN) assert.ok(existsSync(join(c.gen, n)), n);
    assert.equal(readFileSync(c.readme, "utf8"), readme);
    assert.equal(existsSync(join(c.root, "trellis", "backlog.json")), false, "no committed backlog.json");
    assert.match(readFileSync(join(c.gen, "index.md"), "utf8"), /\[DEMO0001\]\(\.\.\/active\/DEMO0001\.md\)/);
    assert.match(r.stdout, /Backlog OK: 1 active, 0 completed, 0 removed\. Next id: DEMO0002/);
    assert.equal(JSON.parse(readFileSync(join(c.gen, "backlog.json"), "utf8")).nextId, "DEMO0002");
  } finally { c.cleanup(); }
});

test("local check passes with no .generated/ folder and fails on a README marker line", () => {
  const c = localRepo();
  try {
    assert.equal(existsSync(c.gen), false);
    const ok = checkCmd(c);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Backlog check OK/);
    writeFileSync(c.readme, "# Backlog\n\n<!-- BEGIN GENERATED:MILESTONES -->\n<!-- END GENERATED:MILESTONES -->\n");
    const bad = checkCmd(c);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /trellis\/README\.md: holds the generated marker line <!-- BEGIN GENERATED:MILESTONES -->/);
    assert.match(bad.stderr, /END GENERATED:MILESTONES/);
  } finally { c.cleanup(); }
});

test("local check never runs git: it passes outside a work tree and with a bad .generated", { skip: process.platform === "win32" }, () => {
  const plain = localRepo({ git: false, ignore: false });
  try { assert.equal(checkCmd(plain).status, 0); } finally { plain.cleanup(); }
  const c = localRepo({ ignore: false });
  const shim = shimPath(c, null);
  try {
    symlinkSync(join(c.root, "nowhere"), c.gen);
    const r = checkCmd(c, { env: shim.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(shim.log), false, "git was never invoked");
    // The same shim does see git when generate runs, so the assertion can fail.
    rmSync(c.gen);
    assert.equal(generate(c, { env: shim.env }).status, 2);
    assert.equal(existsSync(shim.log), true);
  } finally { shim.cleanup(); c.cleanup(); }
});

test("committed-mode generate and check are unchanged by the local branch", () => {
  const root = tempRepo();
  try {
    applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
    const g = run(root, ["generate"]);
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /Next id: DEMO0001/);
    assert.equal(existsSync(join(root, "trellis", ".generated")), false);
    assert.match(readFileSync(join(root, "trellis", "README.md"), "utf8"), /BEGIN GENERATED:MILESTONES/);
    assert.match(run(root, ["check"]).stdout, /Backlog check OK/);
    writeFileSync(join(root, "trellis", "backlog.json"), "{}\n");
    const stale = run(root, ["check"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /trellis\/backlog\.json is stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local generate refuses a leftover marker, an unignored output and a tracked output, writing nothing", () => {
  const marker = localRepo();
  try {
    writeFileSync(marker.readme, "# Backlog\n<!-- BEGIN GENERATED:COMPLETED -->\n");
    const before = snapshot(marker.root);
    const r = generate(marker);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /holds the generated marker line/);
    assert.deepEqual(snapshot(marker.root), before);
  } finally { marker.cleanup(); }

  const unignored = localRepo({ ignore: false });
  try {
    const before = snapshot(unignored.root);
    const r = generate(unignored);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not ignored by git[^]*trellis\/\.generated\//);
    assert.deepEqual(snapshot(unignored.root), before);
  } finally { unignored.cleanup(); }

  const tracked = localRepo();
  try {
    mkdirSync(tracked.gen);
    writeFileSync(join(tracked.gen, "index.md"), "# Backlog\n");
    execFileSync("git", ["-C", tracked.root, "add", "-f", "trellis/.generated/index.md"]);
    const before = snapshot(tracked.root);
    const r = generate(tracked);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /index\.md is tracked/);
    assert.deepEqual(snapshot(tracked.root), before);
  } finally { tracked.cleanup(); }
});

for (const [mode, cfg] of [["scan", {}], ["ledger", { idAllocation: "ledger" }]]) {
  ledgerTest(`local generate refuses a bad .generated or output path before any write (${mode})`, { skip: process.platform === "win32" }, () => {
    const c = localRepo({ cfg });
    try {
      if (mode === "ledger") assert.equal(run(c.root, ["claim", "--seed"]).status, 0);
      const tip = refTip(c.root);
      const elsewhere = join(c.root, "elsewhere");
      mkdirSync(elsewhere);
      const cases = [
        ["symlinked .generated", () => symlinkSync(elsewhere, c.gen), () => rmSync(c.gen)],
        ["file at .generated", () => writeFileSync(c.gen, "x\n"), () => rmSync(c.gen)],
        ["symlinked output", () => { mkdirSync(c.gen); symlinkSync(join(c.root, "nowhere"), join(c.gen, "backlog.json")); }, () => rmSync(c.gen, { recursive: true })],
        ["directory output", () => { mkdirSync(c.gen); mkdirSync(join(c.gen, "completed.md")); }, () => rmSync(c.gen, { recursive: true })],
      ];
      for (const [name, setup, undo] of cases) {
        setup();
        const before = snapshot(c.root);
        const r = generate(c);
        assert.equal(r.status, 2, `${name}: ${r.stderr}`);
        assert.deepEqual(snapshot(c.root), before, name);
        assert.equal(refTip(c.root), tip);
        undo();
      }
      assert.deepEqual(readdirSync(elsewhere), [], "nothing was written through a link");
    } finally { c.cleanup(); }
  });
}

test("local generate succeeds outside a git work tree", () => {
  const c = localRepo({ git: false, ignore: false });
  try {
    const r = generate(c);
    assert.equal(r.status, 0, r.stderr);
    for (const n of GEN) assert.ok(existsSync(join(c.gen, n)), n);
  } finally { c.cleanup(); }
});

ledgerTest("local ledger generate writes the preview with the ref present and null without it", () => {
  const c = localRepo({ cfg: { idAllocation: "ledger" } });
  try {
    const nextId = () => JSON.parse(readFileSync(join(c.gen, "backlog.json"), "utf8")).nextId;
    let r = generate(c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(nextId(), null);
    assert.match(r.stdout, /claim --seed/);
    assert.equal(run(c.root, ["claim", "--seed"]).status, 0);
    r = generate(c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(nextId(), "DEMO0002", "the preview follows the ref, past the existing item");
    assert.doesNotMatch(r.stdout, /Next id:/);
  } finally { c.cleanup(); }
});

test("the local check prints errors in order for a malformed item and a stray marker", () => {
  const c = localRepo();
  try {
    writeFileSync(join(c.root, "trellis", "active", "DEMO0001.md"), ITEM("DEMO0001").replace("milestone: Alpha", "milestone: Nope"));
    writeFileSync(c.readme, "# Backlog\n<!-- END GENERATED:REMOVED -->\n");
    const r = checkCmd(c);
    assert.equal(r.status, 1);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines[0], "Backlog validation failed:");
    assert.match(lines[1], /^  - active\/DEMO0001\.md: milestone must be one of Alpha$/);
    assert.match(lines[2], /^  - trellis\/README\.md: holds the generated marker line <!-- END GENERATED:REMOVED -->/);
    assert.equal(lines.length, 3);
  } finally { c.cleanup(); }
});

test("a forced write failure in local generate leaves no partial set and no empty .generated/", { skip: process.platform === "win32" }, () => {
  for (const n of [0, 2, 3]) {
    const c = localRepo();
    try {
      const before = snapshot(c.root);
      const r = generateFailingAt(c.root, n);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /forced failure/);
      assert.deepEqual(snapshot(c.root), before, `failure at write ${n}`);
    } finally { c.cleanup(); }
  }
  // A folder that already holds older outputs gets them back.
  const c = localRepo();
  try {
    assert.equal(generate(c).status, 0);
    writeFileSync(join(c.root, "trellis", "active", "DEMO0002.md"), ITEM("DEMO0002"));
    const before = snapshot(c.root);
    const r = generateFailingAt(c.root, 3);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(snapshot(c.root), before);
  } finally { c.cleanup(); }
});

ledgerTest("a forced git discovery error makes local generate refuse with files and the ledger tip unchanged", { skip: process.platform === "win32" }, () => {
  const c = localRepo({ cfg: { idAllocation: "ledger" } });
  const shim = shimPath(c, "--show-prefix", '    echo "fatal: detected dubious ownership in repository" >&2\n    exit 128');
  try {
    assert.equal(run(c.root, ["claim", "--seed"]).status, 0);
    const tip = refTip(c.root);
    const before = snapshot(c.root);
    const r = generate(c, { env: shim.env });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /dubious ownership/);
    assert.deepEqual(snapshot(c.root), before);
    assert.equal(refTip(c.root), tip);
  } finally { shim.cleanup(); c.cleanup(); }
});

test("local generate with GIT_LITERAL_PATHSPECS set still recognizes an ignored output", () => {
  const c = localRepo();
  try {
    const r = generate(c, { env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(c.gen, "backlog.json")));
  } finally { c.cleanup(); }
});

test("a scan-mode generate in a worktree subdirectory runs the ignore and tracking checks despite an inherited ceiling", () => {
  const c = localRepo({ git: false, ignore: false });
  try {
    // The target is a subdirectory of the repo; the parent repo is its inherited ceiling.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "trellis-ceiling-")));
    execFileSync("git", ["-C", parent, "init", "-q", ...initRefFormat, "-b", "main"]);
    const sub = join(parent, "sub");
    renameSync(c.root, sub);
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: parent };
    try {
      const refused = run(sub, ["generate"], { env });
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /not ignored by git/);
      writeFileSync(join(sub, ".gitignore"), "trellis/.generated/\n");
      const ok = run(sub, ["generate"], { env });
      assert.equal(ok.status, 0, ok.stderr);
      execFileSync("git", ["-C", parent, "add", "-f", "sub/trellis/.generated/index.md"]);
      const tracked = run(sub, ["generate"], { env });
      assert.equal(tracked.status, 2, tracked.stderr);
      assert.match(tracked.stderr, /is tracked/);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});
