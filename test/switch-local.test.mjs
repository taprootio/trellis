// Tests for `trellis init --switch-to-local` (TRL0038): the preflight, the edits, the
// printed removal commands, recovery and the migration order end to end. Each case builds
// a committed-mode repo in a throwaway git work tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync, symlinkSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold, shouldPromptVocab, DEFAULTS } from "../src/init.mjs";
import { switchToLocal, testSeams } from "../src/switch-local.mjs";
import { OutputRefused, ignoreLineFor } from "../src/local-output.mjs";
import { initRefFormat } from "./git-support.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const initScript = join(sourceRoot, "scripts", "trellis-init.mjs");
const readmeScript = join(sourceRoot, "scripts", "backlog-readme.mjs");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
const cli = (root, args, script = initScript) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: GIT_ENV });
const runSwitch = (root, extra = []) => cli(root, [root, "--switch-to-local", ...extra]);
const GEN = ["index.md", "completed.md", "removed.md", "backlog.json"];

const AUTHORED_COMPLETED = "# Completed\n\nHand-written notes, no markers.\n";
const ITEM = `---\nid: TAP0001\ntitle: First task\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 3\ndepends_on: []\nsummary: Summary.\n---\n\nBody.\n`;

// A committed-mode repo, committed and clean. The README has authored prose around its
// generated block, completed/index.md is hand-written with no markers, and removed/index.md
// is generated only (exactly what init made). `tasksDir` and `cfg` shape the config;
// `ignore` is the .gitignore text (default: the right line; null writes none); `inGit`
// false leaves it outside any work tree.
function fixture({ tasksDir, cfg = {}, inGit = true, ignore, commit = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trellis-switch-")));
  mkdirSync(join(root, "trellis"), { recursive: true });
  const config = { specVersion: "2.5", idPrefix: "TAP", idWidth: DEFAULTS.idWidth, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort, ...(tasksDir ? { tasksDir } : {}), ...cfg };
  writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(config, null, 2) + "\n");
  const dir = tasksDir ? tasksDir.replace(/^\.\//, "").replace(/\/$/, "") : "trellis";
  mkdirSync(join(root, dir, "active"), { recursive: true });
  writeFileSync(join(root, dir, "active", "TAP0001.md"), ITEM);
  const { summary } = applyScaffold(root, {}, {}, sourceRoot);
  assert.deepEqual(summary.errors, []);
  const readme = join(root, dir, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replace("# Backlog\n", "# Backlog\n\nIntro prose.\n") + "\n## Notes\n\nAuthored after the block.\n");
  writeFileSync(join(root, dir, "completed", "index.md"), AUTHORED_COMPLETED);
  const ignoreText = ignore === undefined ? ignoreLineFor(dir) + "\n" : ignore;
  if (ignoreText !== null) writeFileSync(join(root, ".gitignore"), ignoreText);
  if (inGit) {
    git(root, "init", "-q", ...initRefFormat, "-b", "main");
    git(root, "config", "user.name", "Tester");
    git(root, "config", "user.email", "tester@example.com");
    git(root, "config", "commit.gpgsign", "false");
    if (commit) { git(root, "add", "-A"); git(root, "commit", "-q", "-m", "fixture"); }
  }
  const T = (...p) => join(root, dir, ...p);
  return { root, dir, T, commit: (msg = "edit") => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", msg); }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Every file and folder with its bytes (and the .git/index bytes), so "unchanged" is exact.
function tree(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const key = relative(root, abs);
      if (key === ".git") { if (existsSync(join(abs, "index"))) out[".git/index"] = readFileSync(join(abs, "index")).toString("hex"); continue; }
      if (e.isDirectory()) { out[key] = "<dir>"; walk(abs); }
      else out[key] = lstatSync(abs).isSymbolicLink() ? "<link>" : readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}
const commandsOf = (stdout) => stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git -C "));
const runCommands = (root, stdout, cwd = root) => { for (const c of commandsOf(stdout)) assert.equal(spawnSync("sh", ["-c", c], { cwd, env: GIT_ENV }).status, 0, c); };
const rm = (root, path) => `git -C '${root}' --literal-pathspecs rm -- '${path}'`;
const tracked = (root) => git(root, "ls-files").split("\n").filter(Boolean);
const refusedWith = (root, re, args = []) => {
  const before = tree(root);
  const r = runSwitch(root, args);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, re);
  assert.deepEqual(tree(root), before, "a refusal changes nothing");
  return r;
};

// ------------------------------------------------------------ migration
test("the migration order ends with check passing, keeps authored text and is a no-op on rerun", () => {
  const f = fixture();
  try {
    const removedBefore = readFileSync(f.T("removed", "index.md"), "utf8");
    // Step 1 (the ignore line) is in the fixture; step 2 is the switch.
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(f.root, "trellis", "backlog.config.json"), "utf8"));
    assert.equal(cfg.generatedArtifacts, "local");
    // README: block and markers stripped, prose kept. Hand-written index kept as is.
    const readme = readFileSync(f.T("README.md"), "utf8");
    assert.doesNotMatch(readme, /GENERATED/);
    assert.match(readme, /Intro prose\./);
    assert.match(readme, /Authored after the block\./);
    assert.equal(readFileSync(f.T("completed", "index.md"), "utf8"), AUTHORED_COMPLETED);
    // The generated-only file is untouched and reported; so is the legacy backlog.json.
    assert.equal(readFileSync(f.T("removed", "index.md"), "utf8"), removedBefore);
    assert.deepEqual(commandsOf(r.stdout), [rm(f.root, "trellis/removed/index.md"), rm(f.root, "trellis/backlog.json")]);
    assert.deepEqual(git(f.root, "diff", "--cached", "--name-only").trim(), "", "nothing staged");
    // Step 3: run the printed commands, which delete both files.
    runCommands(f.root, r.stdout);
    assert.equal(existsSync(f.T("removed", "index.md")), false);
    assert.equal(existsSync(f.T("backlog.json")), false);
    assert.ok(!tracked(f.root).includes("trellis/backlog.json"));
    // Steps 4 and 5: init (no --force), generate, check.
    assert.equal(cli(f.root, [f.root]).status, 0);
    assert.equal(cli(f.root, [], readmeScript).status, 0);
    const check = cli(f.root, ["--check"], readmeScript);
    assert.equal(check.status, 0, check.stderr);
    for (const n of GEN) assert.ok(existsSync(f.T(".generated", n)), n);
    assert.equal(git(f.root, "status", "--porcelain", "--", "trellis/.generated").trim(), "", ".generated/ is ignored");
    // The completed index is still the author's own text.
    assert.equal(readFileSync(f.T("completed", "index.md"), "utf8"), AUTHORED_COMPLETED);
    // A rerun changes nothing.
    const before = tree(f.root);
    const again = runSwitch(f.root);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(commandsOf(again.stdout).length, 0);
    assert.deepEqual(tree(f.root), before);
  } finally { f.cleanup(); }
});

test("the switch is idempotent: a second run changes nothing, and reprints commands while the files remain", () => {
  const f = fixture();
  try {
    assert.equal(runSwitch(f.root).status, 0);
    const before = tree(f.root);
    const again = runSwitch(f.root);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(tree(f.root), before);
    assert.equal(commandsOf(again.stdout).length, 2);
  } finally { f.cleanup(); }
});

test("a tracked, markerless, blank index file is author-owned: kept, with no removal command", () => {
  const f = fixture();
  try {
    writeFileSync(f.T("removed", "index.md"), "");
    f.commit();
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(f.T("removed", "index.md"), "utf8"), "");
    assert.deepEqual(commandsOf(r.stdout), [rm(f.root, "trellis/backlog.json")]);
  } finally { f.cleanup(); }
});

test("an already-local uncommitted config keeps its bytes, and the switch still strips the markers", () => {
  const f = fixture();
  try {
    const cfgPath = join(f.root, "trellis", "backlog.config.json");
    // Written compactly on purpose: a rewrite through JSON.stringify would change these bytes.
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), generatedArtifacts: "local" }) + "\n");
    const bytes = readFileSync(cfgPath, "utf8");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(cfgPath, "utf8"), bytes);
    assert.doesNotMatch(readFileSync(f.T("README.md"), "utf8"), /GENERATED/);
  } finally { f.cleanup(); }
});

test("the switch raises a 2.4 config to 2.5 and preserves every other key exactly", () => {
  const extra = { tasksDir: "./planning/", nextIdFloor: 1000, "x-custom": { list: [1, null, "é", { deep: true }], empty: {} }, effortImage: "assets/effort.png" };
  const f = fixture({ tasksDir: "./planning/", cfg: { specVersion: "2.4", nextIdFloor: 1000, "x-custom": extra["x-custom"], effortImage: "assets/effort.png" } });
  try {
    const cfgPath = join(f.root, "trellis", "backlog.config.json");
    const before = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(before.specVersion, "2.4");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(cfgPath, "utf8");
    assert.deepEqual(JSON.parse(after), { ...before, specVersion: "2.5", generatedArtifacts: "local" });
    assert.equal(after, JSON.stringify(JSON.parse(after), null, 2) + "\n");
    assert.equal(Object.keys(JSON.parse(after)).at(-1), "generatedArtifacts");
  } finally { f.cleanup(); }
});

// ----------------------------------------------------------- AGENTS.md
test("AGENTS.md: the bullet becomes the local text, a customized gates row survives, no marker lines remain", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("`npx @taprootio/trellis check` (plus this repo's tests/lint)", "`npm test && npx @taprootio/trellis check`"));
    f.commit();
    assert.equal(runSwitch(f.root).status, 0);
    const text = readFileSync(path, "utf8");
    assert.match(text, /trellis\/\.generated\//);
    assert.match(text, /`npm test && npx @taprootio\/trellis check`/);
    assert.doesNotMatch(text, /^<!-- (BEGIN|END) GENERATED/m);
    assert.doesNotMatch(text, /BEGIN\/END GENERATED/);
  } finally { f.cleanup(); }
});

test("a customized last line of the artifact bullet makes the switch warn and leave AGENTS.md byte-identical", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("`BEGIN/END GENERATED` markers.", "`BEGIN/END GENERATED` markers (see the wiki)."));
    f.commit();
    const before = readFileSync(path, "utf8");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(r.stderr, /AGENTS\.md: the generated-files bullet/);
  } finally { f.cleanup(); }
});

test("an artifact bullet with text appended after its final period warns and leaves AGENTS.md alone", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("`BEGIN/END GENERATED` markers.", "`BEGIN/END GENERATED` markers. Ask the owner."));
    f.commit();
    const before = readFileSync(path, "utf8");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(r.stderr, /AGENTS\.md: the generated-files bullet/);
  } finally { f.cleanup(); }
});

test("stripping the block keeps every other byte, including an indented code block after it", () => {
  const f = fixture();
  try {
    writeFileSync(f.T("README.md"), `# B\n\n${README_PAIR}\n    indented code\n\n\nTail.`);
    f.commit();
    assert.equal(runSwitch(f.root).status, 0);
    assert.equal(readFileSync(f.T("README.md"), "utf8"), "# B\n\n    indented code\n\n\nTail.");
  } finally { f.cleanup(); }
});

test("a printed removal command, run from the git root, removes only the nested target's file", { skip: process.platform === "win32" }, () => {
  const f = fixture({ inGit: false });
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "trellis-outer-")));
  try {
    const pkg = join(outer, "pkg");
    renameSync(f.root, pkg);
    mkdirSync(join(outer, "trellis"));
    writeFileSync(join(outer, "trellis", "backlog.json"), "{}\n");
    git(outer, "init", "-q", ...initRefFormat, "-b", "main");
    git(outer, "config", "user.name", "Tester");
    git(outer, "config", "user.email", "tester@example.com");
    git(outer, "config", "commit.gpgsign", "false");
    git(outer, "add", "-A");
    git(outer, "commit", "-q", "-m", "fixture");
    const r = runSwitch(pkg);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(commandsOf(r.stdout).length, 2);
    runCommands(pkg, r.stdout, outer);
    assert.equal(existsSync(join(pkg, "trellis", "backlog.json")), false);
    assert.ok(tracked(outer).includes("trellis/backlog.json"), "the root-level file is untouched");
  } finally { rmSync(outer, { recursive: true, force: true }); f.cleanup(); }
});

test("a repo with no TRELLIS block keeps AGENTS.md byte-identical", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "AGENTS.md"), "# AGENTS\n\nPlain guidance, no block.\n");
    f.commit();
    assert.equal(runSwitch(f.root).status, 0);
    assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), "# AGENTS\n\nPlain guidance, no block.\n");
  } finally { f.cleanup(); }
});

// --------------------------------------------------------------- refusals
const README_PAIR = "<!-- BEGIN GENERATED:MILESTONES -->\n<!-- END GENERATED:MILESTONES -->";
const refusals = {
  "an output that is not ignored": { re: /trellis\/\.generated\/\s*$/m, fixtureOpts: { ignore: null } },
  "an unpaired README marker": { setup: (f) => { writeFileSync(f.T("README.md"), "# B\n\n<!-- BEGIN GENERATED:MILESTONES -->\nprose\n"); f.commit(); }, re: /unpaired/ },
  "an inline marker pair": { setup: (f) => { writeFileSync(f.T("README.md"), "# B\n\ntext <!-- BEGIN GENERATED:MILESTONES --> x <!-- END GENERATED:MILESTONES -->\n"); f.commit(); }, re: /shares its line/ },
  "a second marker pair inside a fenced example": { setup: (f) => { writeFileSync(f.T("README.md"), `# B\n\n${README_PAIR}\n\nExample:\n\n\`\`\`\n${README_PAIR}\n\`\`\`\n`); f.commit(); }, re: /more than once/ },
  "a marker that belongs to another file": { setup: (f) => { writeFileSync(f.T("README.md"), `# B\n\n${README_PAIR}\n<!-- BEGIN GENERATED:COMPLETED -->\n<!-- END GENERATED:COMPLETED -->\n`); f.commit(); }, re: /belongs to another file/ },
  "an untracked README with markers": { setup: (f) => git(f.root, "rm", "-q", "--cached", "trellis/README.md"), re: /trellis\/README\.md is untracked/ },
  "an untracked index file with markers": { setup: (f) => git(f.root, "rm", "-q", "--cached", "trellis/removed/index.md"), re: /removed\/index\.md is untracked/ },
  "a dirty README with markers": { setup: (f) => writeFileSync(f.T("README.md"), readFileSync(f.T("README.md"), "utf8") + "\nmore\n"), re: /README\.md has uncommitted changes/ },
  "a dirty generated-only index file": { setup: (f) => writeFileSync(f.T("removed", "index.md"), readFileSync(f.T("removed", "index.md"), "utf8") + "\n"), re: /removed\/index\.md has uncommitted changes/ },
  "a dirty tracked backlog.json": { setup: (f) => writeFileSync(f.T("backlog.json"), readFileSync(f.T("backlog.json"), "utf8") + " "), re: /backlog\.json has uncommitted changes/ },
  "an untracked legacy backlog.json": { setup: (f) => git(f.root, "rm", "-q", "--cached", "trellis/backlog.json"), re: /backlog\.json exists but is not tracked/ },
  "a tracked .generated/ output": { setup: (f) => { mkdirSync(f.T(".generated"), { recursive: true }); writeFileSync(f.T(".generated", "index.md"), "x\n"); git(f.root, "add", "-f", "trellis/.generated/index.md"); }, re: /\.generated\/index\.md is tracked/ },
  "a tracked extra child of .generated/ while the four outputs are ignored and untracked": { setup: (f) => { mkdirSync(f.T(".generated"), { recursive: true }); writeFileSync(f.T(".generated", "old.txt"), "x\n"); git(f.root, "add", "-f", "trellis/.generated/old.txt"); }, re: /\.generated\/old\.txt is tracked/ },
  "a .gitignore negation exposing a later output": { fixtureOpts: { ignore: "trellis/.generated/*\n!trellis/.generated/backlog.json\n" }, re: /backlog\.json is not ignored[^]*trellis\/\.generated\/\s*$/m },
  "an ignored directory at .generated/index.md": { setup: (f) => mkdirSync(f.T(".generated", "index.md"), { recursive: true }), re: /index\.md is not a regular file/ },
  "a symlinked .generated/": { setup: (f) => { mkdirSync(join(f.root, "elsewhere")); symlinkSync(join(f.root, "elsewhere"), f.T(".generated")); }, re: /\.generated is a symlink/ },
  "a regular file at .generated": { setup: (f) => writeFileSync(f.T(".generated"), "x\n"), re: /\.generated is not a directory/ },
  "an unstaged deletion of the tracked legacy backlog.json": { setup: (f) => rmSync(f.T("backlog.json")), re: /backlog\.json has uncommitted changes/ },
  "a README marked assume-unchanged": { setup: (f) => { git(f.root, "update-index", "--assume-unchanged", "trellis/README.md"); writeFileSync(f.T("README.md"), readFileSync(f.T("README.md"), "utf8") + "\nhidden\n"); }, re: /README\.md is marked assume-unchanged or skip-worktree/ },
  "a legacy backlog.json marked skip-worktree": { setup: (f) => git(f.root, "update-index", "--skip-worktree", "trellis/backlog.json"), re: /backlog\.json is marked assume-unchanged or skip-worktree/ },
  "a tracked README symlink": { setup: (f) => { rmSync(f.T("README.md")); writeFileSync(join(f.root, "real-readme.md"), "# Real\n"); symlinkSync(join(f.root, "real-readme.md"), f.T("README.md")); f.commit(); }, re: /README\.md is a symlink/ },
};
for (const [name, c] of Object.entries(refusals)) {
  test(`the switch refuses ${name}, changing nothing`, { skip: process.platform === "win32" }, () => {
    const f = fixture(c.fixtureOpts || {});
    try {
      if (c.setup) c.setup(f);
      refusedWith(f.root, c.re);
    } finally { f.cleanup(); }
  });
}

test("a tracked README symlink leaves the link and its target unchanged", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    rmSync(f.T("README.md"));
    writeFileSync(join(f.root, "real-readme.md"), `# Real\n\n${README_PAIR}\n`);
    symlinkSync(join(f.root, "real-readme.md"), f.T("README.md"));
    f.commit();
    refusedWith(f.root, /README\.md is a symlink/);
    assert.equal(lstatSync(f.T("README.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(f.root, "real-readme.md"), "utf8"), `# Real\n\n${README_PAIR}\n`);
  } finally { f.cleanup(); }
});

test("the switch refuses a non-git directory and never edits .gitignore on a refusal", () => {
  const plain = fixture({ inGit: false });
  try {
    refusedWith(plain.root, /not inside a git work tree/);
  } finally { plain.cleanup(); }
  const f = fixture({ ignore: "trellis/.generated/*\n!trellis/.generated/backlog.json\n" });
  try {
    const bytes = readFileSync(join(f.root, ".gitignore"), "utf8");
    refusedWith(f.root, /trellis\/\.generated\//);
    assert.equal(readFileSync(join(f.root, ".gitignore"), "utf8"), bytes);
  } finally { f.cleanup(); }
});

test("a forced git discovery error makes the switch refuse with the tree unchanged", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "trellis-shim-")));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--show-prefix" ]; then echo "fatal: detected dubious ownership" >&2; exit 128; fi\ndone\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  try {
    const before = tree(f.root);
    const r = spawnSync(process.execPath, [initScript, f.root, "--switch-to-local"], { encoding: "utf8", env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /dubious ownership/);
    assert.deepEqual(tree(f.root), before);
  } finally { rmSync(bin, { recursive: true, force: true }); f.cleanup(); }
});

test("an inherited GIT_INDEX_FILE pointing at an empty index does not hide a tracked .generated/ file", () => {
  const f = fixture();
  const empty = join(f.root, "..", `empty-index-${process.pid}`);
  const old = process.env.GIT_INDEX_FILE;
  try {
    mkdirSync(f.T(".generated"), { recursive: true });
    writeFileSync(f.T(".generated", "old.txt"), "x\n");
    git(f.root, "add", "-f", "trellis/.generated/old.txt");
    writeFileSync(empty, "");
    process.env.GIT_INDEX_FILE = empty;
    assert.throws(() => switchToLocal(f.root), (e) => e instanceof OutputRefused && /old\.txt is tracked/.test(e.message));
  } finally {
    if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old;
    rmSync(empty, { force: true });
    f.cleanup();
  }
});

// ------------------------------------------------------------ pathspecs
test("with tasksDir planning*, a tracked planning-old/backlog.json is left alone and no command names it", () => {
  const f = fixture({ tasksDir: "planning*" });
  try {
    mkdirSync(join(f.root, "planning-old"));
    writeFileSync(join(f.root, "planning-old", "backlog.json"), "{}\n");
    f.commit();
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(commandsOf(r.stdout), [rm(f.root, "planning*/removed/index.md"), rm(f.root, "planning*/backlog.json")]);
    assert.doesNotMatch(r.stdout, /planning-old/);
    assert.ok(tracked(f.root).includes("planning-old/backlog.json"));
    // Running the printed commands removes only the targets.
    runCommands(f.root, r.stdout);
    assert.ok(tracked(f.root).includes("planning-old/backlog.json"));
    assert.equal(existsSync(join(f.root, "planning-old", "backlog.json")), true);
    assert.equal(existsSync(join(f.root, "planning*", "backlog.json")), false);
  } finally { f.cleanup(); }
});

test("with tasksDir planning[old], the printed ignore line works", () => {
  const f = fixture({ tasksDir: "planning[old]", ignore: null });
  try {
    const r = refusedWith(f.root, /planning\\\[old\\\]\/\.generated\//);
    const line = r.stderr.split("\n").map((l) => l.trim()).find((l) => l.endsWith("/.generated/") && l.startsWith("planning"));
    writeFileSync(join(f.root, ".gitignore"), line + "\n");
    git(f.root, "add", ".gitignore");
    git(f.root, "commit", "-q", "-m", "ignore");
    assert.equal(runSwitch(f.root).status, 0);
  } finally { f.cleanup(); }
});

// ----------------------------------------------------------- dry run, flags
test("--dry-run lists the edits and commands, writes nothing, leaves the git index bytes, and never runs an fsmonitor command", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const sentinel = join(f.root, "..", `fsmonitor-${process.pid}`);
    git(f.root, "config", "core.fsmonitor", `touch ${sentinel}; echo`);
    git(f.root, "status", "--porcelain");
    rmSync(sentinel, { force: true });
    const before = tree(f.root);
    const r = runSwitch(f.root, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /trellis\/README\.md/);
    assert.match(r.stdout, /trellis\/backlog\.json/);
    assert.equal(commandsOf(r.stdout).length, 2);
    assert.deepEqual(tree(f.root), before, "files and .git/index are unchanged");
    assert.equal(existsSync(sentinel), false, "the fsmonitor command did not run");
  } finally { f.cleanup(); }
});

test("--switch-to-local with --import, --retire-source or --force is a usage error", () => {
  const f = fixture();
  try {
    for (const extra of [["--import", "x"], ["--retire-source", "x"], ["--force"], ["--prefix", "ZZ"]]) {
      const before = tree(f.root);
      const r = runSwitch(f.root, extra);
      assert.equal(r.status, 2, extra.join(" "));
      assert.match(r.stderr, /--switch-to-local takes only --dry-run/);
      assert.deepEqual(tree(f.root), before);
    }
  } finally { f.cleanup(); }
});

test("the switch never prompts for vocabulary", () => {
  assert.equal(shouldPromptVocab({}, true), true, "plain init would prompt");
  assert.equal(shouldPromptVocab({ switchToLocal: true }, true), false);
});

// -------------------------------------------------------------- recovery
test("a forced failure after the edits restores every edited file and the config", () => {
  for (const arm of ["beforeConfig", "afterAll"]) {
    const f = fixture();
    try {
      const before = tree(f.root);
      if (arm === "beforeConfig") testSeams.beforeWrite = (path) => { if (path.endsWith("backlog.config.json")) throw new Error("forced failure"); };
      else testSeams.afterWrites = () => { throw new Error("forced failure"); };
      assert.throws(() => switchToLocal(f.root), /every edited file was restored: forced failure/);
      assert.deepEqual(tree(f.root), before, arm);
      testSeams.beforeWrite = null;
      testSeams.afterWrites = null;
      assert.equal(switchToLocal(f.root).edits.length, 3, "a rerun starts clean");
    } finally { testSeams.beforeWrite = null; testSeams.afterWrites = null; f.cleanup(); }
  }
});
