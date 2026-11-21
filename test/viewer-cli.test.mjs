// Behavior tests for `trellis serve` (scripts/trellis-serve.mjs, TRL0005): in-process through
// runServe with a fixture dist, and through the real dispatcher in a temporary package copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HELP, runServe } from "../scripts/trellis-serve.mjs";
import { DEFAULT_PORT } from "../src/viewer/config.mjs";
import { BASE_CFG, FIXTURE_DIST, PACKAGE_ROOT, getJson, makeRepo, request, tmp } from "./viewer-support.mjs";

// Output sinks and a clean environment, so nothing reads the developer's real config.
function sandbox() {
  const dir = tmp("cli");
  const out = [];
  const err = [];
  const base = {
    distDir: FIXTURE_DIST, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    cwd: dir, env: {}, homedir: join(dir, "home"), watch: false,
  };
  return { dir, out: () => out.join(""), err: () => err.join(""), base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Runs `runServe`, hands the handle to `fn`, and stops the server.
async function serving(sb, argv, fn, overrides = {}) {
  const result = await runServe(argv, { ...sb.base, ...overrides });
  assert.equal(typeof result, "object", `expected a server, got exit ${result}: ${sb.err()}`);
  try { return await fn(result); } finally { await result.close(); }
}

test("usage mistakes return exit 2 with a message and start nothing", async () => {
  const sb = sandbox();
  try {
    const cases = [
      [["--bogus"], /Unknown flag: --bogus/],
      [["extra"], /Unexpected argument/],
      [["--port"], /--port requires a value/],
      [["--port", "abc"], /--port must be/],
      [["--port", "70000"], /--port must be/],
      [["--repo", "x", "--config", "y"], /--repo and --config cannot be combined/],
      [["--target", "x", "--config", "y"], /--repo and --config cannot be combined/],
      [["--repo", "a", "--target", "b"], /once/],
      [["--allow-host", "bad host"], /bare host name/],
      [["--bind"], /requires a value/],
    ];
    for (const [argv, pattern] of cases) {
      const err0 = sb.err().length;
      assert.equal(await runServe(argv, sb.base), 2, argv.join(" "));
      assert.match(sb.err().slice(err0), pattern);
    }
    assert.equal(sb.out(), "");
  } finally { sb.cleanup(); }
});

test("--help prints the help, which states the restart rule and the git floors", async () => {
  const sb = sandbox();
  try {
    assert.equal(await runServe(["--help"], sb.base), 0);
    assert.equal(sb.out(), HELP);
    assert.match(HELP, /restart/);
    assert.match(HELP, /git 2\.36/);
    assert.match(HELP, /2\.45\.1/);
  } finally { sb.cleanup(); }
});

test("config mistakes return exit 1 naming the key: unknown key, duplicate id, bad id, missing file", async () => {
  const sb = sandbox();
  try {
    const entry = { id: "a", name: "A", path: "/abs/a" };
    const cases = [
      [{ backlogs: [entry], typo: 1 }, /`typo`/],
      [{ backlogs: [entry, entry] }, /duplicate `id` "a"/],
      [{ backlogs: [{ ...entry, id: "Bad_Id" }] }, /`id`/],
      [{ backlogs: [] }, /`backlogs`/],
    ];
    for (const [config, pattern] of cases) {
      const file = join(sb.dir, "viewer.json");
      writeFileSync(file, JSON.stringify(config));
      const before = sb.err().length;
      assert.equal(await runServe(["--config", file], sb.base), 1);
      assert.match(sb.err().slice(before), pattern);
    }
    assert.equal(await runServe(["--config", join(sb.dir, "missing.json")], sb.base), 1);
    assert.equal(await runServe([], { ...sb.base, env: { TRELLIS_VIEWER_CONFIG: join(sb.dir, "missing.json") } }), 1);
    assert.match(sb.err(), /TRELLIS_VIEWER_CONFIG/);
  } finally { sb.cleanup(); }
});

test("without flags or a config file, serve serves the current directory's repo", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const sb = sandbox();
  try {
    await serving(sb, ["--port", "0"], async (v) => {
      const { json } = await getJson(v.port, "/api/backlogs");
      assert.deepEqual(json.map((b) => [b.path, b.counts.active]), [[repo.root, 1]]);
      assert.match(sb.out(), new RegExp(`trellis viewer: http://127\\.0\\.0\\.1:${v.port}\\n`));
      assert.match(sb.out(), new RegExp(`no config file; serving ${repo.root}\\n`));
      assert.equal(sb.err(), "");
    }, { cwd: repo.root });
  } finally { repo.cleanup(); sb.cleanup(); }
});

test("TRELLIS_VIEWER_CONFIG names the file to read, and XDG_CONFIG_HOME and ~/.config come after it", async () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" } });
  const sb = sandbox();
  try {
    const file = join(sb.dir, "env.json");
    writeFileSync(file, JSON.stringify({ backlogs: [{ id: "b", name: "B", path: b.root }, { id: "a", name: "A", path: a.root }], port: 0 }));
    await serving(sb, [], async (v) => {
      assert.deepEqual((await getJson(v.port, "/api/backlogs")).json.map((x) => x.id), ["b", "a"]);
      assert.match(sb.out(), new RegExp(`config: ${file}\\n`));
    }, { env: { TRELLIS_VIEWER_CONFIG: file } });
    const xdg = join(sb.dir, "xdg");
    mkdirSync(join(xdg, "trellis"), { recursive: true });
    writeFileSync(join(xdg, "trellis", "viewer.json"), JSON.stringify({ backlogs: [{ id: "x", name: "X", path: a.root }], port: 0 }));
    await serving(sb, [], async (v) => {
      assert.deepEqual((await getJson(v.port, "/api/backlogs")).json.map((x) => x.id), ["x"]);
    }, { env: { XDG_CONFIG_HOME: xdg } });
  } finally { a.cleanup(); b.cleanup(); sb.cleanup(); }
});

test("the default port is 4747 and --port overrides the config; --port 0 picks a free one", async (t) => {
  const repo = makeRepo();
  const sb = sandbox();
  try {
    assert.equal(DEFAULT_PORT, 4747);
    const first = await runServe(["--repo", repo.root], sb.base);
    if (typeof first === "number") t.diagnostic("port 4747 is busy here; the default itself is covered by DEFAULT_PORT");
    else { assert.equal(first.port, 4747); await first.close(); }
    await serving(sb, ["--repo", repo.root, "--port", "0"], async (v) => {
      assert.notEqual(v.port, 0);
      const file = join(sb.dir, "viewer.json");
      writeFileSync(file, JSON.stringify({ backlogs: [{ id: "a", name: "A", path: repo.root }], port: v.port }));
      assert.equal(await runServe(["--config", file], sb.base), 1, "the config's port is taken");
      assert.match(sb.err(), /cannot listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
      await serving(sb, ["--config", file, "--port", "0"], async (w) => assert.notEqual(w.port, v.port));
    });
  } finally { repo.cleanup(); sb.cleanup(); }
});

test("a non-loopback bind prints the warning, a loopback one does not, and the printed URL is served", async (t) => {
  const repo = makeRepo();
  const sb = sandbox();
  try {
    await serving(sb, ["--repo", repo.root, "--port", "0", "--bind", "127.0.0.1"], async (v) => {
      assert.equal(sb.err(), "");
      assert.equal(v.server.address().address, "127.0.0.1");
    });
    await serving(sb, ["--repo", repo.root, "--port", "0", "--bind", "0.0.0.0"], async (v) => {
      assert.match(sb.err(), /warning: .*exposed beyond this machine/);
      assert.match(sb.out(), new RegExp(`trellis viewer: http://127\\.0\\.0\\.1:${v.port}\\n`));
      assert.equal((await request(v.port, { path: "/" })).status, 200);
    });
    const file = join(sb.dir, "viewer.json");
    writeFileSync(file, JSON.stringify({ backlogs: [{ id: "a", name: "A", path: repo.root }], bind: "0.0.0.0", port: 0 }));
    const before = sb.err().length;
    await serving(sb, ["--config", file], async () => assert.match(sb.err().slice(before), /exposed beyond this machine/));
    const v6 = await runServe(["--repo", repo.root, "--port", "0", "--bind", "::1"], sb.base);
    if (typeof v6 === "number") t.diagnostic("IPv6 loopback unavailable here");
    else {
      try {
        assert.match(sb.out(), new RegExp(`trellis viewer: http://\\[::1\\]:${v6.port}\\n`));
        assert.equal((await request(v6.port, { hostname: "::1", host: `[::1]:${v6.port}`, path: "/" })).status, 200);
      } finally { await v6.close(); }
    }
    const alias = await runServe(["--repo", repo.root, "--port", "0", "--bind", "127.0.0.2"], sb.base);
    if (typeof alias === "number") t.diagnostic("127.0.0.2 unavailable here");
    else {
      try {
        assert.match(sb.out(), new RegExp(`trellis viewer: http://127\\.0\\.0\\.2:${alias.port}\\n`));
        assert.equal((await request(alias.port, { hostname: "127.0.0.2", host: `127.0.0.2:${alias.port}`, path: "/" })).status, 200);
      } finally { await alias.close(); }
    }
  } finally { repo.cleanup(); sb.cleanup(); }
});

test("--allow-host adds a name without a config key, and joins the config's allowedHosts", async () => {
  const repo = makeRepo();
  const sb = sandbox();
  try {
    await serving(sb, ["--repo", repo.root, "--port", "0", "--allow-host", "trellis.test"], async (v) => {
      for (const host of ["trellis.test", "trellis.test:443"]) assert.equal((await request(v.port, { path: "/api/backlogs", host })).status, 200, host);
      assert.equal((await request(v.port, { path: "/api/backlogs", host: "evil.example" })).status, 403);
    });
    const file = join(sb.dir, "viewer.json");
    writeFileSync(file, JSON.stringify({ backlogs: [{ id: "a", name: "A", path: repo.root }], port: 0, allowedHosts: ["one.test"] }));
    await serving(sb, ["--config", file, "--allow-host", "two.test"], async (v) => {
      for (const host of ["one.test", "two.test"]) assert.equal((await request(v.port, { path: "/", host })).status, 200, host);
    });
  } finally { repo.cleanup(); sb.cleanup(); }
});

test("a dist directory without a built viewer exits 1 naming the build command", async () => {
  const repo = makeRepo();
  const sb = sandbox();
  try {
    const empty = join(sb.dir, "empty");
    mkdirSync(empty);
    assert.equal(await runServe(["--repo", repo.root, "--port", "0"], { ...sb.base, distDir: empty }), 1);
    assert.match(sb.err(), /npm run build:viewer/);
  } finally { repo.cleanup(); sb.cleanup(); }
});

test("a backlog with a bad path still lets the viewer start, with that backlog in error", async () => {
  const good = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const sb = sandbox();
  try {
    const file = join(sb.dir, "viewer.json");
    writeFileSync(file, JSON.stringify({ backlogs: [{ id: "gone", name: "Gone", path: join(sb.dir, "missing") }, { id: "good", name: "Good", path: good.root }], port: 0 }));
    await serving(sb, ["--config", file], async (v) => {
      const { json } = await getJson(v.port, "/api/backlogs");
      assert.deepEqual(json.map((b) => b.status), ["error", "ok"]);
    });
  } finally { good.cleanup(); sb.cleanup(); }
});

// ---------------------------------------------------- the real dispatcher
// A temporary package copy with its own fixture dist, so nothing reads the repository's
// viewer/dist/ (which the package test builds in parallel).
function packageCopy() {
  const dir = tmp("pkg");
  for (const entry of ["package.json", "scripts", "src"]) cpSync(join(PACKAGE_ROOT, entry), join(dir, entry), { recursive: true });
  cpSync(FIXTURE_DIST, join(dir, "viewer", "dist"), { recursive: true });
  return { dir, bin: join(dir, "scripts", "trellis.mjs"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const trellis = (pkg, args, cwd, extraEnv = {}) => spawnSync(process.execPath, [pkg.bin, ...args], {
  encoding: "utf8", cwd, env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: "", TRELLIS_VIEWER_CONFIG: "", ...extraEnv },
});

test("through `trellis serve`: help, usage error, config error and a missing dist keep their exit codes", () => {
  const pkg = packageCopy();
  const cwd = tmp("cwd");
  try {
    assert.match(trellis(pkg, ["--help"], cwd).stdout, /serve\s+serve a local, read-only viewer/);
    const help = trellis(pkg, ["serve", "--help"], cwd);
    assert.deepEqual([help.status, help.stdout], [0, HELP]);
    const usage = trellis(pkg, ["serve", "--repo", cwd, "--config", join(cwd, "c.json")], cwd);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /cannot be combined/);
    const unknown = trellis(pkg, ["serve", "--nope"], cwd);
    assert.deepEqual([unknown.status, /Unknown flag/.test(unknown.stderr)], [2, true]);
    writeFileSync(join(cwd, "c.json"), JSON.stringify({ backlogs: [{ id: "a", name: "A", path: "/abs" }], typo: true }));
    const config = trellis(pkg, ["serve", "--config", join(cwd, "c.json")], cwd);
    assert.equal(config.status, 1);
    assert.match(config.stderr, /`typo`/);
    rmSync(join(pkg.dir, "viewer", "dist"), { recursive: true });
    const noDist = trellis(pkg, ["serve", "--repo", cwd, "--port", "0"], cwd);
    assert.equal(noDist.status, 1);
    assert.match(noDist.stderr, /npm run build:viewer/);
  } finally { pkg.cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});

test("through `trellis serve`, from an unrelated directory, the shell and its bundle are served and SIGTERM stops it", async () => {
  const pkg = packageCopy();
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const cwd = tmp("cwd");
  try {
    const child = spawn(process.execPath, [pkg.bin, "serve", "--repo", repo.root, "--port", "0"], { cwd, env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: "", TRELLIS_VIEWER_CONFIG: "" } });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let stdout = "";
    const url = await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => { stdout += d; const m = /trellis viewer: (http:\/\/\S+)/.exec(stdout); if (m) resolve(m[1]); });
      child.on("exit", () => reject(new Error("exited before printing the URL")));
    });
    try {
      const port = Number(new URL(url).port);
      const shell = await request(port, { path: "/b/demo/task/DEMO0001" });
      assert.equal(shell.status, 200);
      assert.match(shell.text, /\/app\/app-test\.js/);
      assert.equal((await request(port, { path: "/app/app-test.js" })).status, 200);
      assert.equal((await request(port, { path: "/app/esp-reset.css" })).status, 200);
      assert.equal((await getJson(port, "/api/backlogs")).json[0].counts.active, 1);
    } finally { child.kill("SIGTERM"); }
    assert.equal((await exited).code, 0);
  } finally { pkg.cleanup(); repo.cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});

test("importing the entry file starts nothing", async () => {
  const mod = await import("../scripts/trellis-serve.mjs");
  assert.equal(typeof mod.runServe, "function");
});
