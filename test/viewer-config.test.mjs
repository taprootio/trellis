// Behavior tests for the viewer config and main-worktree resolution
// (src/viewer/config.mjs, src/viewer/worktree.mjs, TRL0005).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_PORT, ViewerConfigError, findConfigFile, isLoopbackBind, loadViewerConfig, parseViewerConfig, singleRepoConfig,
} from "../src/viewer/config.mjs";
import { LayoutError, firstWorktree, resolveMainWorktree } from "../src/viewer/worktree.mjs";
import { git, makeRepo, tmp } from "./viewer-support.mjs";
import { initRefFormat } from "./git-support.mjs";

const ENTRY = { id: "taproot", name: "Taproot", path: "/abs/taproot" };
const parseError = (raw) => { try { parseViewerConfig(raw, { homedir: "/home/me" }); } catch (e) { return e; } return null; };

test("config lookup order: TRELLIS_VIEWER_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
  const dir = tmp("cfg");
  try {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    const envFile = join(dir, "env.json");
    mkdirSync(join(home, ".config", "trellis"), { recursive: true });
    mkdirSync(join(xdg, "trellis"), { recursive: true });
    writeFileSync(join(home, ".config", "trellis", "viewer.json"), "{}");
    assert.equal(findConfigFile({ cwd: dir, env: {}, homedir: home }), join(home, ".config", "trellis", "viewer.json"));
    writeFileSync(join(xdg, "trellis", "viewer.json"), "{}");
    assert.equal(findConfigFile({ cwd: dir, env: { XDG_CONFIG_HOME: xdg }, homedir: home }), join(xdg, "trellis", "viewer.json"));
    writeFileSync(envFile, "{}");
    assert.equal(findConfigFile({ cwd: dir, env: { XDG_CONFIG_HOME: xdg, TRELLIS_VIEWER_CONFIG: "env.json" }, homedir: home }), envFile);
    assert.throws(() => findConfigFile({ cwd: dir, env: { TRELLIS_VIEWER_CONFIG: "missing.json" }, homedir: home }), ViewerConfigError);
    assert.equal(findConfigFile({ cwd: dir, env: { XDG_CONFIG_HOME: join(dir, "none") }, homedir: join(dir, "nohome") }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a valid config keeps order, expands ~/, and lower-cases allowed hosts", () => {
  const cfg = parseViewerConfig({
    backlogs: [ENTRY, { id: "espalier", name: "Espalier", path: "~/code/espalier" }], port: 0, bind: "::1", allowedHosts: ["Trellis.TEST", "[::1]"],
  }, { homedir: "/home/me" });
  assert.deepEqual(cfg.backlogs.map((b) => [b.id, b.path]), [["taproot", "/abs/taproot"], ["espalier", "/home/me/code/espalier"]]);
  assert.deepEqual([cfg.port, cfg.bind, cfg.allowedHosts], [0, "::1", ["trellis.test", "[::1]"]]);
  assert.deepEqual([DEFAULT_PORT, parseViewerConfig({ backlogs: [ENTRY] }).port], [4747, null]);
});

test("every config mistake is a startup error naming the key", () => {
  const cases = [
    [null, /JSON object/],
    [[], /JSON object/],
    [{}, /`backlogs`/],
    [{ backlogs: [] }, /`backlogs`/],
    [{ backlogs: [ENTRY], extra: 1 }, /unknown key `extra`/],
    [{ backlogs: [{ ...ENTRY, color: "red" }] }, /unknown key `color`/],
    [{ backlogs: [ENTRY, ENTRY] }, /duplicate `id` "taproot"/],
    [{ backlogs: [{ ...ENTRY, id: "Bad Id" }] }, /`id`/],
    [{ backlogs: [{ ...ENTRY, id: "-lead" }] }, /`id`/],
    [{ backlogs: [{ ...ENTRY, id: "a".repeat(41) }] }, /`id`/],
    [{ backlogs: [{ ...ENTRY, name: " " }] }, /`name`/],
    [{ backlogs: [{ ...ENTRY, path: "relative/path" }] }, /`path`/],
    [{ backlogs: [{ ...ENTRY, path: 5 }] }, /`path`/],
    [{ backlogs: [ENTRY], port: "4747" }, /`port`/],
    [{ backlogs: [ENTRY], port: 70000 }, /`port`/],
    [{ backlogs: [ENTRY], bind: 5 }, /`bind`/],
    [{ backlogs: [ENTRY], allowedHosts: "x.test" }, /`allowedHosts`/],
    [{ backlogs: [ENTRY], allowedHosts: ["x.test:80"] }, /allowedHosts\[0\]/],
  ];
  for (const [raw, pattern] of cases) {
    const e = parseError(raw);
    assert.ok(e instanceof ViewerConfigError, JSON.stringify(raw));
    assert.match(e.message, pattern);
  }
});

test("loadViewerConfig reports unreadable and invalid files with the file name", () => {
  const dir = tmp("cfgfile");
  try {
    const file = join(dir, "viewer.json");
    assert.throws(() => loadViewerConfig(file), /cannot read/);
    writeFileSync(file, "{nope");
    assert.throws(() => loadViewerConfig(file), /not valid JSON/);
    writeFileSync(file, JSON.stringify({ backlogs: [ENTRY], typo: true }));
    assert.throws(() => loadViewerConfig(file), (e) => e.message.includes(file) && e.message.includes("`typo`"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--repo becomes a one-entry config whose id obeys the id rule", () => {
  const c = singleRepoConfig("My Repo_Name", { cwd: "/work" });
  assert.deepEqual(c.backlogs, [{ id: "my-repo-name", name: "My Repo_Name", path: "/work/My Repo_Name" }]);
  assert.equal(singleRepoConfig("/", { cwd: "/work" }).backlogs[0].id, "repo");
});

test("loopback binds are recognized", () => {
  for (const b of ["127.0.0.1", "127.0.0.2", "::1", "localhost", "LOCALHOST"]) assert.ok(isLoopbackBind(b), b);
  for (const b of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) assert.ok(!isLoopbackBind(b), b);
});

// ---------------------------------------------------------- main worktree
test("a main checkout resolves to itself, and a linked worktree to the main one", () => {
  const repo = makeRepo();
  try {
    assert.equal(resolveMainWorktree(repo.root).mainWorktree, repo.root);
    const lane = repo.lane("lane");
    const r = resolveMainWorktree(lane);
    assert.equal(r.mainWorktree, repo.root);
    assert.equal(r.gitDir, join(repo.root, ".git"));
  } finally { repo.cleanup(); }
});

test("a missing path, a non-repository and a bare repository are that backlog's layout error", () => {
  const dir = tmp("layout");
  try {
    assert.throws(() => resolveMainWorktree(join(dir, "nope")), LayoutError);
    mkdirSync(join(dir, "plain"));
    assert.throws(() => resolveMainWorktree(join(dir, "plain")), /not inside a git repository/);
    execFileSync("git", ["init", "-q", "--bare", ...initRefFormat, join(dir, "bare.git")]);
    assert.throws(() => resolveMainWorktree(join(dir, "bare.git")), /bare/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a --separate-git-dir clone is an unsupported layout", () => {
  const dir = tmp("sep");
  try {
    mkdirSync(join(dir, "work"));
    execFileSync("git", ["init", "-q", ...initRefFormat, "--separate-git-dir", join(dir, "meta"), join(dir, "work")], { stdio: "ignore" });
    git(join(dir, "work"), "config", "user.name", "T");
    git(join(dir, "work"), "config", "user.email", "t@example.com");
    writeFileSync(join(dir, "work", "f"), "x");
    git(join(dir, "work"), "add", "-A");
    git(join(dir, "work"), "commit", "-q", "-m", "init");
    assert.throws(() => resolveMainWorktree(join(dir, "work")), /unsupported layout/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a first entry that is a different repository's checkout is an unsupported layout", () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    // Stand in for a clone whose `worktree list` names another clone's checkout first.
    const fake = (cwd, args) => {
      if (args[0] === "worktree") return { status: 0, stdout: `worktree ${b.root}\0HEAD 0000\0branch refs/heads/main\0\0`, stderr: "" };
      return execFileSyncResult(cwd, args);
    };
    assert.throws(() => resolveMainWorktree(a.root, { git: fake }), /different repository/);
  } finally { a.cleanup(); b.cleanup(); }
});

function execFileSyncResult(cwd, args) {
  try {
    return { status: 0, stdout: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e) { return { status: e.status, stdout: "", stderr: String(e.stderr) }; }
}

test("an old git that rejects `worktree list -z` names the 2.36 floor", () => {
  const repo = makeRepo();
  try {
    const old = () => ({ status: 129, stdout: "", stderr: "error: unknown switch `z'\nusage: git worktree list" });
    assert.throws(() => resolveMainWorktree(repo.root, { git: old }), /git 2\.36/);
  } finally { repo.cleanup(); }
});

test("firstWorktree reads the first NUL-separated entry", () => {
  const out = "worktree /a b\0HEAD 1\0branch refs/heads/main\0\0worktree /c\0HEAD 2\0detached\0\0";
  assert.deepEqual(firstWorktree(out), { path: "/a b", bare: false });
  assert.deepEqual(firstWorktree("worktree /x\0bare\0\0"), { path: "/x", bare: true });
});
