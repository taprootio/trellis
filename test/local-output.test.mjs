// Tests for the local-mode output helpers (TRL0038): the ignore-line formatter,
// the preflight every writer runs, the ledger preview and the rollback writer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerTest, initRefFormat } from "./git-support.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig } from "../src/backlog.mjs";
import { gitEnv, seed } from "../src/ledger.mjs";
import {
  OutputRefused, outputPreflight, previewNextId, writeArtifactFiles, ignoreLineFor, verifyOutputPaths, discoverGit, gitPrefix, testSeams,
} from "../src/local-output.mjs";

const BASE = { specVersion: "2.5", idPrefix: "DEMO", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3], generatedArtifacts: "local" };
const OUTPUTS = ["index.md", "completed.md", "removed.md", "backlog.json"];

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A local-mode repo with the config and (unless `ignore` is false) the ignore line.
// `inGit: false` leaves it outside any work tree.
function localRepo({ cfg = {}, ignore = true, inGit = true, tasksDir } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trellis-local-")));
  const config = { ...BASE, ...cfg, ...(tasksDir ? { tasksDir } : {}) };
  mkdirSync(join(root, "trellis"), { recursive: true });
  writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(config, null, 2) + "\n");
  if (inGit) git(root, "init", "-q", ...initRefFormat, "-b", "main");
  const loaded = loadConfig(root);
  assert.deepEqual(loaded.errors, []);
  if (ignore) writeFileSync(join(root, ".gitignore"), ignoreLineFor(loaded.cfg.tasksDir) + "\n");
  return { root, cfg: loaded.cfg, dir: join(root, loaded.cfg.tasksDir || "trellis", ".generated"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A `git` first on PATH that fails the commands `when` matches and runs real git for the rest.
function withGitShim(when, body, fn) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "trellis-shim-")));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${when}" ]; then\n${body}\n  fi\ndone\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try { return fn(); } finally { process.env.PATH = oldPath; rmSync(bin, { recursive: true, force: true }); }
}

const refused = (fn, re) => assert.throws(fn, (e) => e instanceof OutputRefused && e.exitCode === 2 && e.code === "invalid_request" && re.test(e.message), `expected a refusal matching ${re}`);
const MODES = [["scan", {}], ["ledger", { idAllocation: "ledger" }]];

// ------------------------------------------------------------ ignore line
test("ignoreLineFor escapes gitignore metacharacters and edge spaces", () => {
  assert.equal(ignoreLineFor("trellis"), "trellis/.generated/");
  assert.equal(ignoreLineFor("docs/planning/"), "docs/planning/.generated/");
  assert.equal(ignoreLineFor("./planning"), "planning/.generated/");
  assert.equal(ignoreLineFor(undefined), "trellis/.generated/");
  assert.equal(ignoreLineFor("planning*"), "planning\\*/.generated/");
  assert.equal(ignoreLineFor("planning[old]"), "planning\\[old\\]/.generated/");
  assert.equal(ignoreLineFor("a?b!c#d\\e"), "a\\?b\\!c\\#d\\\\e/.generated/");
  assert.equal(ignoreLineFor(" lead"), "\\ lead/.generated/");
  assert.equal(ignoreLineFor("trail "), "trail\\ /.generated/");
});

for (const [name, decoy] of [["planning[old]", "planningo"], ["planning*", "planning-old"]]) {
  test(`git check-ignore agrees with the line for ${name}`, () => {
    const c = localRepo({ tasksDir: name });
    try {
      const ignored = (rel) => spawnSync("git", ["-C", c.root, "check-ignore", "-q", "--no-index", "--", `./${rel}`], { env: gitEnv() }).status;
      for (const out of OUTPUTS) assert.equal(ignored(`${name}/.generated/${out}`), 0, out);
      assert.equal(ignored(`${decoy}/.generated/index.md`), 1, "the metacharacters are literal");
      outputPreflight(c.root, c.cfg);
    } finally { c.cleanup(); }
  });
}

// -------------------------------------------------------------- preflight
for (const [mode, over] of MODES) {
  test(`preflight passes a clean local repo (${mode})`, () => {
    const c = localRepo({ cfg: over });
    try { outputPreflight(c.root, c.cfg); } finally { c.cleanup(); }
  });

  test(`preflight refuses an unignored output and prints the line to add (${mode})`, () => {
    const c = localRepo({ cfg: over, ignore: false });
    try {
      refused(() => outputPreflight(c.root, c.cfg), /not ignored by git[^]*trellis\/\.generated\//);
      // A negation that exposes only a later output still refuses and names it.
      writeFileSync(join(c.root, ".gitignore"), "trellis/.generated/*\n!trellis/.generated/backlog.json\n");
      refused(() => outputPreflight(c.root, c.cfg), /trellis\/\.generated\/backlog\.json is not ignored/);
    } finally { c.cleanup(); }
  });

  test(`preflight refuses a tracked output (${mode})`, () => {
    const c = localRepo({ cfg: over });
    try {
      mkdirSync(c.dir);
      writeFileSync(join(c.dir, "index.md"), "# Backlog\n");
      git(c.root, "add", "-f", "trellis/.generated/index.md");
      refused(() => outputPreflight(c.root, c.cfg), /trellis\/\.generated\/index\.md is tracked/);
    } finally { c.cleanup(); }
  });

  test(`preflight refuses a leftover marker (${mode})`, () => {
    const c = localRepo({ cfg: over });
    try {
      writeFileSync(join(c.root, "trellis", "README.md"), "<!-- BEGIN GENERATED:MILESTONES -->\n");
      refused(() => outputPreflight(c.root, c.cfg), /README\.md: holds the generated marker line/);
    } finally { c.cleanup(); }
  });

  test(`preflight refuses a symlinked or non-directory .generated and any non-regular output (${mode})`, { skip: process.platform === "win32" }, () => {
    const c = localRepo({ cfg: over });
    try {
      const elsewhere = join(c.root, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, c.dir);
      refused(() => outputPreflight(c.root, c.cfg), /\.generated is a symlink/);
      rmSync(c.dir);
      writeFileSync(c.dir, "a file\n");
      refused(() => outputPreflight(c.root, c.cfg), /\.generated is not a directory/);
      rmSync(c.dir);

      mkdirSync(c.dir);
      mkdirSync(join(c.dir, "index.md"));
      refused(() => outputPreflight(c.root, c.cfg), /index\.md is not a regular file/);
      rmSync(join(c.dir, "index.md"), { recursive: true });
      symlinkSync(join(c.root, "nowhere"), join(c.dir, "backlog.json"));
      refused(() => outputPreflight(c.root, c.cfg), /backlog\.json is a symlink/);
    } finally { c.cleanup(); }
  });

  test(`preflight skips the git half outside a work tree but still checks file types (${mode})`, { skip: process.platform === "win32" }, () => {
    const c = localRepo({ cfg: over, inGit: false, ignore: false });
    try {
      assert.equal(discoverGit(c.root), "skip");
      assert.deepEqual(verifyOutputPaths(c.root, c.cfg), { inside: false, unignored: [], tracked: [] });
      outputPreflight(c.root, c.cfg);
      mkdirSync(c.dir);
      mkdirSync(join(c.dir, "removed.md"));
      refused(() => outputPreflight(c.root, c.cfg), /removed\.md is not a regular file/);
    } finally { c.cleanup(); }
  });
}

test("preflight does nothing in committed mode", () => {
  const c = localRepo({ cfg: { generatedArtifacts: "committed" }, ignore: false });
  try { outputPreflight(c.root, c.cfg); } finally { c.cleanup(); }
});

// ------------------------------------------------------------ git outcomes
test("the verifier reports a git check-ignore exit of 128 as a git error", { skip: process.platform === "win32" }, () => {
  const c = localRepo();
  try {
    withGitShim("check-ignore", '    echo "fatal: boom" >&2\n    exit 128', () => {
      refused(() => verifyOutputPaths(c.root, c.cfg), /check-ignore failed for trellis\/\.generated\/index\.md: fatal: boom/);
      refused(() => outputPreflight(c.root, c.cfg), /fatal: boom/);
    });
  } finally { c.cleanup(); }
});

test("git absent skips the git half, and any other discovery failure refuses", { skip: process.platform === "win32" }, () => {
  const c = localRepo({ ignore: false });
  try {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "trellis-nopath-")));
    const oldPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      assert.equal(discoverGit(c.root), "skip");
      outputPreflight(c.root, c.cfg);
    } finally { process.env.PATH = oldPath; rmSync(empty, { recursive: true, force: true }); }

    withGitShim("--show-prefix", '    echo "fatal: detected dubious ownership in repository at x" >&2\n    exit 128', () => {
      refused(() => discoverGit(c.root), /dubious ownership/);
      refused(() => outputPreflight(c.root, c.cfg), /dubious ownership/);
    });
    // The failure wrote nothing.
    assert.equal(existsSync(c.dir), false);
  } finally { c.cleanup(); }
});

test("an inherited GIT_INDEX_FILE does not hide an output tracked in the real index", () => {
  const c = localRepo();
  try {
    mkdirSync(c.dir);
    writeFileSync(join(c.dir, "index.md"), "# Backlog\n");
    git(c.root, "add", "-f", "trellis/.generated/index.md");
    const alt = join(c.root, "alt-index");
    execFileSync("git", ["-C", c.root, "read-tree", "--empty"], { env: { ...process.env, GIT_INDEX_FILE: alt } });
    const old = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = alt;
    try {
      refused(() => outputPreflight(c.root, c.cfg), /index\.md is tracked/);
    } finally {
      if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old;
    }
  } finally { c.cleanup(); }
});

test("the git environment cleanup drops literal-pathspec and ceiling overrides", () => {
  const saved = { a: process.env.GIT_LITERAL_PATHSPECS, b: process.env.GIT_CEILING_DIRECTORIES };
  process.env.GIT_LITERAL_PATHSPECS = "1";
  process.env.GIT_CEILING_DIRECTORIES = "/";
  try {
    const env = gitEnv();
    assert.equal("GIT_LITERAL_PATHSPECS" in env, false);
    assert.equal("GIT_CEILING_DIRECTORIES" in env, false);
    assert.equal(env.GIT_OPTIONAL_LOCKS, undefined);
    assert.equal(gitEnv({ GIT_OPTIONAL_LOCKS: "0" }).GIT_OPTIONAL_LOCKS, "0");
  } finally {
    for (const [k, v] of [["GIT_LITERAL_PATHSPECS", saved.a], ["GIT_CEILING_DIRECTORIES", saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// -------------------------------------------------------------- preview
ledgerTest("previewNextId is the ledger preview, null without the ref, undefined in scan mode", () => {
  const c = localRepo({ cfg: { idAllocation: "ledger" } });
  try {
    assert.equal(previewNextId(c.root, c.cfg), null, "no ref");
    seed(c.root, c.cfg);
    assert.equal(previewNextId(c.root, c.cfg), "DEMO0001");
  } finally { c.cleanup(); }
  const scan = localRepo();
  try { assert.equal(previewNextId(scan.root, scan.cfg), undefined); } finally { scan.cleanup(); }
  const committed = localRepo({ cfg: { idAllocation: "ledger", generatedArtifacts: "committed" } });
  try { assert.equal(previewNextId(committed.root, committed.cfg), undefined); } finally { committed.cleanup(); }
});

// -------------------------------------------------------------- writing
function failAt(n) {
  testSeams.beforeWrite = (_path, i) => { if (i === n) throw new Error("boom"); };
}

test("writeArtifactFiles makes .generated/, and a failure removes the one it created", () => {
  const c = localRepo();
  try {
    const files = OUTPUTS.map((n, i) => ({ path: join(c.dir, n), content: `content ${i}\n` }));
    for (const n of [0, 2, 3]) {
      failAt(n);
      assert.throws(() => writeArtifactFiles(files), /boom/);
      assert.equal(existsSync(c.dir), false, `failure at write ${n} leaves no .generated/`);
    }
    testSeams.beforeWrite = null;
    const changed = writeArtifactFiles(files);
    assert.equal(changed.length, 4);
    assert.equal(readFileSync(join(c.dir, "removed.md"), "utf8"), "content 2\n");
    assert.deepEqual(writeArtifactFiles(files), [], "an identical rerun changes nothing");
  } finally { testSeams.beforeWrite = null; c.cleanup(); }
});

test("writeArtifactFiles keeps an existing .generated/ and restores changed and new files", () => {
  const c = localRepo();
  try {
    mkdirSync(c.dir);
    writeFileSync(join(c.dir, "index.md"), "old index\n");
    const files = OUTPUTS.map((n, i) => ({ path: join(c.dir, n), content: `new ${i}\n` }));
    failAt(3);
    assert.throws(() => writeArtifactFiles(files), /boom/);
    assert.equal(readFileSync(join(c.dir, "index.md"), "utf8"), "old index\n", "changed file restored");
    assert.equal(existsSync(join(c.dir, "completed.md")), false, "new file removed");
    assert.equal(existsSync(c.dir), true, "the folder was not created by the call, so it stays");
  } finally { testSeams.beforeWrite = null; c.cleanup(); }
});

test("the printed ignore line carries the git-root prefix and satisfies the preflight at the repo root", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "trellis-sub-")));
  try {
    git(top, "init", "-q", ...initRefFormat, "-b", "main");
    const root = join(top, "pkg [one]");
    mkdirSync(join(root, "trellis"), { recursive: true });
    writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(BASE, null, 2) + "\n");
    const loaded = loadConfig(root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(gitPrefix(root), "pkg [one]/");
    let message = "";
    try { outputPreflight(root, loaded.cfg); } catch (e) { message = e.message; }
    assert.match(message, /\.gitignore at the repository root/);
    const line = message.split("\n").pop().trim();
    assert.equal(line, "pkg \\[one\\]/trellis/.generated/");
    writeFileSync(join(top, ".gitignore"), line + "\n");
    outputPreflight(root, loaded.cfg);
  } finally { rmSync(top, { recursive: true, force: true }); }
});
