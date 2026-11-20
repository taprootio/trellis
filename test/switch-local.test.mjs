// Tests for `trellis init --switch-to-local` (TRL0038): the preflight, the edits, the
// printed removal commands, recovery and the migration order end to end. Each case builds
// a committed-mode repo in a throwaway git work tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync, symlinkSync, realpathSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold, shouldPromptVocab, DEFAULTS, completedSkeleton, artifactBullet, agentsBlock, compactBlock, AGENTS_MARKERS } from "../src/init.mjs";
import { switchToLocal, testSeams } from "../src/switch-local.mjs";
import { OutputRefused, ignoreLineFor, testSeams as outputSeams } from "../src/local-output.mjs";
import { initRefFormat, ledgerTest } from "./git-support.mjs";

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
// `goodAgent` seeds the detection marker, and `skip` is passed to the scaffold (TRL0040).
function fixture({ tasksDir, cfg = {}, inGit = true, ignore, commit = true, goodAgent = false, skip } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trellis-switch-")));
  mkdirSync(join(root, "trellis"), { recursive: true });
  const config = { specVersion: "2.5", idPrefix: "TAP", idWidth: DEFAULTS.idWidth, milestones: DEFAULTS.milestones, priorities: DEFAULTS.priorities, effort: DEFAULTS.effort, ...(tasksDir ? { tasksDir } : {}), ...cfg };
  writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(config, null, 2) + "\n");
  const dir = tasksDir ? tasksDir.replace(/^\.\//, "").replace(/\/$/, "") : "trellis";
  mkdirSync(join(root, dir, "active"), { recursive: true });
  writeFileSync(join(root, dir, "active", "TAP0001.md"), ITEM);
  if (goodAgent) writeFileSync(join(root, "good-agent.config.json"), "{}\n");
  const { summary } = applyScaffold(root, skip ? { skip } : {}, {}, sourceRoot);
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

test("an index whose scaffold heading is indented into a code block is author-owned: edited, with no removal command", () => {
  const f = fixture();
  try {
    writeFileSync(f.T("completed", "index.md"), completedSkeleton().replace("# Completed tasks", "    # Completed tasks"));
    f.commit();
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(f.T("completed", "index.md"), "utf8");
    assert.match(text, /^    # Completed tasks$/m);
    assert.doesNotMatch(text, /GENERATED/);
    assert.equal(commandsOf(r.stdout).some((c) => c.includes("completed/index.md")), false);
  } finally { f.cleanup(); }
});

test("a whitespace-only index file is blank, so it is author-owned and kept", () => {
  const f = fixture();
  try {
    writeFileSync(f.T("removed", "index.md"), "  \n\n");
    f.commit();
    assert.equal(runSwitch(f.root).status, 0);
    assert.equal(readFileSync(f.T("removed", "index.md"), "utf8"), "  \n\n");
  } finally { f.cleanup(); }
});

test("the printed removal commands come with a note to run them without GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE or GIT_INDEX_FILE", () => {
  const f = fixture();
  try {
    assert.match(runSwitch(f.root).stdout, /no GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE or GIT_INDEX_FILE set/);
  } finally { f.cleanup(); }
});

test("the bullet replacement hits the exact line, not an earlier customized copy of its text", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    const committed = artifactBullet("trellis", "committed");
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(committed));
    const custom = `${committed} Ask the owner.\n`;
    writeFileSync(path, text.replace(committed, () => custom + committed));
    f.commit();
    assert.equal(runSwitch(f.root).status, 0);
    const after = readFileSync(path, "utf8");
    assert.ok(after.includes(custom), "the customized copy is untouched");
    assert.ok(after.includes(artifactBullet("trellis", "local")));
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

test("a stock-text copy inside a fenced code block never matches: the customized real bullet warns and AGENTS.md stays", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    const stock = artifactBullet(f.dir, "committed");
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(stock));
    const custom = text.replace(stock, `${stock.slice(0, -1)} (see the wiki).`);
    const end = custom.indexOf("<!-- END TRELLIS");
    const withFence = end === -1 ? null : custom.slice(0, end) + "```md\n" + stock + "\n- next bullet\n```\n" + custom.slice(end);
    assert.ok(withFence, "the block has an end marker");
    writeFileSync(path, withFence);
    f.commit();
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), withFence);
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

test("an artifact bullet followed by a continuation line warns and leaves AGENTS.md alone", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("`BEGIN/END GENERATED` markers.\n", "`BEGIN/END GENERATED` markers.\n  Ask the owner first.\n"));
    f.commit();
    const before = readFileSync(path, "utf8");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(r.stderr, /AGENTS\.md: the generated-files bullet/);
  } finally { f.cleanup(); }
});

test("an artifact bullet followed by a blank line and an indented paragraph warns and leaves AGENTS.md alone", () => {
  const f = fixture();
  try {
    const path = join(f.root, "AGENTS.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("`BEGIN/END GENERATED` markers.\n", "`BEGIN/END GENERATED` markers.\n\n  Ask the owner first.\n"));
    f.commit();
    const before = readFileSync(path, "utf8");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(r.stderr, /AGENTS\.md: the generated-files bullet/);
  } finally { f.cleanup(); }
});

test("many tracked files under the tasks folder do not change the outcome", () => {
  const f = fixture();
  try {
    mkdirSync(f.T("notes"));
    for (let i = 0; i < 300; i++) writeFileSync(f.T("notes", `n${i}.md`), `note ${i}\n`);
    f.commit();
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(commandsOf(r.stdout).length, 2);
    assert.equal(tracked(f.root).filter((p) => p.startsWith("trellis/notes/")).length, 300);
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
  "a tracked README deleted from the work tree": { setup: (f) => rmSync(f.T("README.md")), re: /trellis\/README\.md is tracked by git but missing from the work tree/ },
  "a tracked index file skipped by sparse checkout": { setup: (f) => { git(f.root, "update-index", "--skip-worktree", "trellis/completed/index.md"); rmSync(f.T("completed", "index.md")); }, re: /trellis\/completed\/index\.md is tracked by git but missing from the work tree/ },
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
test("with tasksDir planning*, a tracked planning-old/backlog.json is left alone and no command names it", { skip: process.platform === "win32" }, () => {
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

test("a failure after the first install puts every original back and leaves no stage or backup file", () => {
  const f = fixture();
  try {
    const before = tree(f.root);
    testSeams.beforeWrite = (path, i) => { if (i === 1) throw new Error("forced failure"); };
    assert.throws(() => switchToLocal(f.root), /every edited file was restored: forced failure/);
    assert.deepEqual(tree(f.root), before);
  } finally { testSeams.beforeWrite = null; f.cleanup(); }
});

// ------------------------------------------------- external review round 3
const foldsOnDisk = (() => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "trellis-case-")));
  try { writeFileSync(join(d, "a"), ""); return existsSync(join(d, "A")); } finally { rmSync(d, { recursive: true, force: true }); }
})();

test("tracked children under a differently cased tasks folder refuse the switch", { skip: !foldsOnDisk && "case-sensitive filesystem" }, () => {
  const f = fixture();
  try {
    git(f.root, "config", "core.ignorecase", "true");
    const sha = execFileSync("git", ["-C", f.root, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8", env: GIT_ENV }).trim();
    git(f.root, "update-index", "--add", "--cacheinfo", `100644,${sha},TRELLIS/.GENERATED/index.md`);
    refusedWith(f.root, /tracked by git/);
  } finally { f.cleanup(); }
});

test("a file that is not valid UTF-8 refuses the switch before any edit, naming the file", () => {
  for (const [name, rel] of [["README", "trellis/README.md"], ["AGENTS", "AGENTS.md"]]) {
    const f = fixture();
    try {
      const path = join(f.root, rel);
      const before = readFileSync(path);
      // Windows-1252 prose: 0xE9 is "e acute" there and an invalid byte in UTF-8.
      writeFileSync(path, Buffer.concat([before, Buffer.from([0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a])]));
      f.commit("latin prose");
      const snapshot = readFileSync(path);
      const r = refusedWith(f.root, /not valid UTF-8/);
      assert.match(r.stderr, new RegExp(rel.replace(".", "\\.")), name);
      assert.deepEqual(readFileSync(path), snapshot, "bytes untouched");
    } finally { f.cleanup(); }
  }
});

test("a failed original-to-backup copy records no backup, so the restore reports a clean rollback", () => {
  const f = fixture();
  try {
    const before = tree(f.root);
    outputSeams.copy = () => { throw new Error("copy refused"); };
    assert.throws(() => switchToLocal(f.root), /every edited file was restored: copy refused/);
    assert.deepEqual(tree(f.root), before);
  } finally { outputSeams.copy = null; f.cleanup(); }
});

// ------------------------------------------------------------ round 5
test("a non-ASCII tasksDir is refused with the config error and nothing changes", () => {
  const f = fixture({ tasksDir: "planningé" });
  try {
    refusedWith(f.root, /tasksDir.*ASCII/);
  } finally { f.cleanup(); }
});

test("a legacy backlog goes through the local migration with blank cells and nulls under .generated/", () => {
  // `legacy` is in the committed config before the switch, which refuses uncommitted config changes.
  const f = fixture({ cfg: { legacy: { through: "TAP0004", closedBefore: "2026-11-19" } } });
  try {
    cpSync(join(sourceRoot, "test", "fixtures", "legacy-adoption"), join(f.root, f.dir), { recursive: true });
    f.commit("add legacy items");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    runCommands(f.root, r.stdout);
    assert.equal(cli(f.root, [f.root]).status, 0);
    assert.equal(cli(f.root, [], readmeScript).status, 0);
    const check = cli(f.root, ["--check"], readmeScript);
    assert.equal(check.status, 0, check.stderr);
    assert.match(readFileSync(f.T(".generated", "completed.md"), "utf8"), /\| Old completed item \|  \| 2026-06-01 \|/);
    assert.match(readFileSync(f.T(".generated", "removed.md"), "utf8"), /\| Old removed item \|  \| 2026-06-01 \|/);
    const json = JSON.parse(readFileSync(f.T(".generated", "backlog.json"), "utf8"));
    for (const t of json.tasks.filter((x) => x.status !== "active")) {
      for (const k of ["summary", "milestone", "priority", "effort"]) assert.equal(t[k], null, `${t.id} ${k}`);
    }
  } finally { f.cleanup(); }
});

// ---------------------------------------- block variants (TRL0040)
const TAP = { prefix: "TAP", idWidth: DEFAULTS.idWidth };
const GENERATED_MARKER_TEXTS = ["BEGIN/END GENERATED", "BEGIN GENERATED", "END GENERATED"];
// The marked TRELLIS block of AGENTS.md, delimiters included.
const blockOf = (root) => {
  const text = readFileSync(join(root, "AGENTS.md"), "utf8");
  const [begin, end] = AGENTS_MARKERS;
  const bi = text.indexOf(begin);
  return text.slice(bi, text.indexOf(end, bi) + end.length + 1);
};

test("a compact block switches to the .generated/ wording, keeps its variant and delimiters, and a rerun is quiet", () => {
  const f = fixture({ goodAgent: true });
  try {
    assert.equal(blockOf(f.root), compactBlock(TAP), "the fixture holds the compact block");
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes("warning"));
    const block = blockOf(f.root);
    assert.equal(block, compactBlock(TAP, "trellis", "local"));
    assert.ok(block.startsWith(AGENTS_MARKERS[0]) && block.endsWith(`${AGENTS_MARKERS[1]}\n`));
    for (const text of GENERATED_MARKER_TEXTS) assert.ok(!block.includes(text), text);
    assert.ok(Buffer.byteLength(block) < 1200);
    runCommands(f.root, r.stdout);
    f.commit();
    const before = tree(f.root);
    const again = runSwitch(f.root);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!again.stderr.includes("warning"));
    assert.deepEqual(tree(f.root), before);
  } finally { f.cleanup(); }
});

test("a full block made with --skip ci,branch-protection switches without getting those lines back", () => {
  const skip = ["ci", "branch-protection"];
  const f = fixture({ skip });
  try {
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    const block = blockOf(f.root);
    assert.equal(block, agentsBlock(TAP, "trellis", "local", { skip }));
    assert.ok(block.startsWith(AGENTS_MARKERS[0]) && block.endsWith(`${AGENTS_MARKERS[1]}\n`));
    for (const text of GENERATED_MARKER_TEXTS) assert.ok(!block.includes(text), text);
    assert.ok(!block.includes("`backlog` job") && !block.includes("branch-protection.md"));
  } finally { f.cleanup(); }
});

ledgerTest("a ledger-mode full block switches with its claim line untouched", () => {
  const f = fixture({ cfg: { idAllocation: "ledger" } });
  try {
    assert.equal(blockOf(f.root), agentsBlock(TAP, "trellis", "committed", { ledger: true }));
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(blockOf(f.root), agentsBlock(TAP, "trellis", "local", { ledger: true }));
  } finally { f.cleanup(); }
});

test("--switch-to-local with --with-playbooks is a usage error and changes nothing", () => {
  const f = fixture();
  try {
    const r = refusedWith(f.root, /--with-playbooks/, ["--with-playbooks"]);
    assert.ok(r.stderr.includes("--switch-to-local"));
  } finally { f.cleanup(); }
});

// ------------------------------------------------- size limit (TRL0040)
const LIMIT = 32768;
// Pads AGENTS.md after its block, byte-exactly, and commits it so the switch can edit it.
function padAgents(f, bytes) {
  const path = join(f.root, "AGENTS.md");
  const text = readFileSync(path, "utf8");
  const pad = bytes - Buffer.byteLength(text);
  assert.ok(pad > 1);
  writeFileSync(path, text + "é".repeat((pad - 1) / 2 | 0) + "x".repeat(pad - 2 * ((pad - 1) / 2 | 0)));
  assert.equal(readFileSync(path).length, bytes);
  f.commit("pad AGENTS.md");
}
// The edit grows a full block by the difference between the two bullets.
const GROWTH = Buffer.byteLength(artifactBullet("trellis", "local")) - Buffer.byteLength(artifactBullet("trellis", "committed"));

test("an AGENTS.md edit that would cross the limit refuses with nothing changed, even as a dry run", () => {
  const f = fixture();
  try {
    assert.ok(GROWTH > 0);
    padAgents(f, LIMIT);
    git(f.root, "--no-optional-locks", "status", "--porcelain");
    for (const extra of [[], ["--dry-run"]]) {
      const r = refusedWith(f.root, new RegExp(`${LIMIT + GROWTH} bytes.*${LIMIT}-byte`), extra);
      assert.equal(commandsOf(r.stdout).length, 0, "no removal commands");
      assert.match(r.stderr, /Trim AGENTS\.md/);
    }
  } finally { f.cleanup(); }
});

test("an edit that lands exactly on the limit proceeds", () => {
  const f = fixture();
  try {
    padAgents(f, LIMIT - GROWTH);
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(f.root, "AGENTS.md")).length, LIMIT);
  } finally { f.cleanup(); }
});

test("an AGENTS.md already over the limit warns and the switch proceeds", () => {
  const f = fixture();
  try {
    padAgents(f, LIMIT + 100);
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes("AGENTS.md") && r.stderr.includes(String(LIMIT)));
    assert.ok(r.stderr.includes(String(LIMIT + 100)));
    assert.ok(readFileSync(join(f.root, "AGENTS.md"), "utf8").includes(artifactBullet("trellis", "local")), "the bullet was still switched");
  } finally { f.cleanup(); }
});

test("the closing message says to repeat the --skip flags", () => {
  const f = fixture({ skip: ["ci"] });
  try {
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("--skip"));
  } finally { f.cleanup(); }
});

test("a file just over the limit that the edit shrinks back within it gets an advisory with the new size", () => {
  const f = fixture({ goodAgent: true });
  try {
    // The compact block's local text is shorter, so the edit shrinks the file.
    padAgents(f, LIMIT + 50);
    const r = runSwitch(f.root);
    assert.equal(r.status, 0, r.stderr);
    const size = readFileSync(join(f.root, "AGENTS.md")).length;
    assert.ok(size <= LIMIT);
    assert.ok(r.stderr.includes(String(LIMIT + 50)) && r.stderr.includes(String(size)));
  } finally { f.cleanup(); }
});
