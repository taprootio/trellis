// Behavior tests for live reload (src/viewer/watch.mjs through the server's /events stream,
// TRL0005). Live tests wait on the real completion signal: an SSE message, then the API's own
// answer. The plan and event-filter tests run on a stand-in for fs.watch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/backlog.mjs";
import { claim, seed } from "../src/ledger.mjs";
import { createBacklog } from "../src/viewer/backlogs.mjs";
import { startViewer } from "../src/viewer/server.mjs";
import { createWatchers, watchPlan } from "../src/viewer/watch.mjs";
import { ledgerTest } from "./git-support.mjs";
import { BASE_CFG, FIXTURE_DIST, getJson, makeRepo, openEvents } from "./viewer-support.mjs";

const posixOnly = process.platform === "win32" ? { skip: "needs POSIX symlinks" } : {};
const STAMP = 1_700_000_000;
const stamp = (file) => utimesSync(file, STAMP, STAMP);

// A live viewer over `repos` ({ id: repo }) with an event stream; stops everything afterwards.
async function live(repos, fn) {
  const entries = Object.entries(repos).map(([id, repo]) => ({ id, name: id, path: repo.root }));
  const viewer = await startViewer({ entries, port: 0, distDir: FIXTURE_DIST, watch: true });
  const events = await openEvents(viewer.port);
  try { return await fn({ port: viewer.port, events, viewer }); } finally { events.close(); await viewer.close(); }
}

// Re-reads /api/backlogs/<id> until `ok(record)`, waiting for one message between reads.
async function until({ port, events }, id, ok) {
  for (;;) {
    const { json } = await getJson(port, `/api/backlogs/${id}`);
    if (ok(json)) return json;
    await events.next(id);
  }
}
const titles = (json) => (json.tasks || []).map((t) => t.title).join();

test("editing a task title in the main worktree sends a message naming only that backlog", async () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "Before" } }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" }, items: [{ status: "active", id: "OTH0001", fm: { title: "Other" } }] });
  try {
    await live({ a, b }, async (ctx) => {
      writeFileSync(a.itemPath("active", "DEMO0001"), readFileSync(a.itemPath("active", "DEMO0001"), "utf8").replace("Before", "After!"));
      await until(ctx, "a", (j) => titles(j) === "After!");
      // The sentinel edit proves the stream works for b; nothing before it named b.
      assert.ok(ctx.events.seen.every((m) => m.backlog === "a"));
      writeFileSync(b.itemPath("active", "OTH0001"), readFileSync(b.itemPath("active", "OTH0001"), "utf8").replace("Other", "Changed"));
      await until(ctx, "b", (j) => titles(j) === "Changed");
    });
  } finally { a.cleanup(); b.cleanup(); }
});

test("changing a backlog's tasksDir in its config, then editing a task under the new root, sends a message", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "Old root" } }] });
  try {
    await live({ demo: repo }, async (ctx) => {
      repo.write("trellis/backlog.config.json", JSON.stringify({ ...BASE_CFG, tasksDir: "docs/tasks" }));
      await until(ctx, "demo", (j) => j.counts.active === 0);
      repo.tasksDir = "docs/tasks";
      repo.add("active", "DEMO0002", { title: "New root" });
      await until(ctx, "demo", (j) => titles(j) === "New root");
      writeFileSync(repo.itemPath("active", "DEMO0002"), readFileSync(repo.itemPath("active", "DEMO0002"), "utf8").replace("New root", "Edited!!"));
      await until(ctx, "demo", (j) => titles(j) === "Edited!!");
    });
  } finally { repo.cleanup(); }
});

test("removing and recreating completed/tasks keeps reload working", async () => {
  const repo = makeRepo({ items: [{ status: "completed", id: "DEMO0002", fm: { title: "First" } }] });
  const other = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" } });
  try {
    await live({ demo: repo, other }, async (ctx) => {
      rmSync(repo.folder("completed"), { recursive: true });
      await until(ctx, "demo", (j) => j.counts.completed === 0);
      repo.add("completed", "DEMO0002", { title: "Second" });
      await until(ctx, "demo", (j) => titles(j) === "Second");
      writeFileSync(repo.itemPath("completed", "DEMO0002"), readFileSync(repo.itemPath("completed", "DEMO0002"), "utf8").replace("Second", "Third!"));
      await until(ctx, "demo", (j) => titles(j) === "Third!");
      assert.ok(ctx.events.seen.every((m) => m.backlog === "demo"), "no message named the other backlog");
    });
  } finally { repo.cleanup(); other.cleanup(); }
});

test("removing and restoring a nested docs/tasks, then editing a title, each send a message", async () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, tasksDir: "docs/tasks" }, items: [{ status: "active", id: "DEMO0001", fm: { title: "Nested" } }] });
  try {
    await live({ demo: repo }, async (ctx) => {
      rmSync(join(repo.root, "docs"), { recursive: true });
      await until(ctx, "demo", (j) => j.counts.active === 0);
      repo.add("active", "DEMO0001", { title: "Restored" });
      await until(ctx, "demo", (j) => titles(j) === "Restored");
      writeFileSync(repo.itemPath("active", "DEMO0001"), readFileSync(repo.itemPath("active", "DEMO0001"), "utf8").replace("Restored", "Retitled"));
      await until(ctx, "demo", (j) => titles(j) === "Retitled");
    });
  } finally { repo.cleanup(); }
});

test("a timestamp-preserving replacement of an item refreshes its title", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "AAAAA" } }] });
  try {
    const file = repo.itemPath("active", "DEMO0001");
    stamp(file);
    await live({ demo: repo }, async (ctx) => {
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "AAAAA");
      writeFileSync(file, readFileSync(file, "utf8").replace("AAAAA", "BBBBB"));
      stamp(file);
      await until(ctx, "demo", (j) => titles(j) === "BBBBB");
    });
  } finally { repo.cleanup(); }
});

test("replacing a watched directory with same-path, same-size, same-mtime files but different titles refreshes them", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "AAAAA" } }, { status: "active", id: "DEMO0002", fm: { title: "CCCCC" } }] });
  try {
    for (const id of ["DEMO0001", "DEMO0002"]) stamp(repo.itemPath("active", id));
    await live({ demo: repo }, async (ctx) => {
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "AAAAA,CCCCC");
      const old = readFileSync(repo.itemPath("active", "DEMO0001"), "utf8");
      const old2 = readFileSync(repo.itemPath("active", "DEMO0002"), "utf8");
      rmSync(repo.folder("active"), { recursive: true });
      mkdirSync(repo.folder("active"));
      writeFileSync(repo.itemPath("active", "DEMO0001"), old.replace("AAAAA", "BBBBB"));
      writeFileSync(repo.itemPath("active", "DEMO0002"), old2.replace("CCCCC", "DDDDD"));
      for (const id of ["DEMO0001", "DEMO0002"]) stamp(repo.itemPath("active", id));
      await until(ctx, "demo", (j) => titles(j) === "BBBBB,DDDDD");
    });
  } finally { repo.cleanup(); }
});

test("a subtree holding a symlinked task's target, replaced outside the task folders, is re-read", posixOnly, async () => {
  const repo = makeRepo();
  try {
    repo.add("active", "DEMO0001", { title: "AAAAA" });
    const link = repo.itemPath("active", "DEMO0001");
    const original = readFileSync(link, "utf8");
    const target = join(repo.root, "docs", "pool", "deep", "real.md");
    rmSync(link);
    mkdirSync(join(repo.root, "docs", "pool", "deep"), { recursive: true });
    writeFileSync(target, original);
    stamp(target);
    symlinkSync(target, link);
    await live({ demo: repo }, async (ctx) => {
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "AAAAA");
      rmSync(join(repo.root, "docs", "pool"), { recursive: true });
      mkdirSync(join(repo.root, "docs", "pool", "deep"), { recursive: true });
      writeFileSync(target, original.replace("AAAAA", "ZZZZZ"));
      stamp(target);
      await until(ctx, "demo", (j) => titles(j) === "ZZZZZ");
    });
  } finally { repo.cleanup(); }
});

test("a symlinked task whose target is deleted, then restored, is picked up again", { ...posixOnly, timeout: 15000 }, async () => {
  const repo = makeRepo();
  try {
    repo.add("active", "DEMO0001", { title: "AAAAA" });
    const link = repo.itemPath("active", "DEMO0001");
    const original = readFileSync(link, "utf8");
    const target = join(repo.root, "docs", "pool", "real.md");
    rmSync(link);
    mkdirSync(join(repo.root, "docs", "pool"), { recursive: true });
    writeFileSync(target, original);
    symlinkSync(target, link);
    await live({ demo: repo }, async (ctx) => {
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "AAAAA");
      rmSync(target);
      await ctx.events.next("demo"); // the deletion's own message, so it cannot be mistaken for the restore's
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "");
      // The rebuild above saw a dangling link. Restoring the target must send its own message
      // (not just be found by the next request), so wait for one beyond those already seen.
      const before = ctx.events.seen.length;
      writeFileSync(target, original.replace("AAAAA", "ZZZZZ"));
      do { await ctx.events.next("demo"); } while (ctx.events.seen.length <= before);
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "ZZZZZ");
    });
  } finally { repo.cleanup(); }
});

ledgerTest("creating the ledger ref, then two claims in a row with no task edits, each send a message", async () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const cfg = loadConfig(repo.root).cfg;
    await live({ demo: repo }, async (ctx) => {
      assert.equal((await getJson(ctx.port, "/api/backlogs/demo")).json.nextId, null);
      seed(repo.root, cfg);
      await until(ctx, "demo", (j) => j.nextId === "DEMO0002");
      claim(repo.root, cfg, { title: "one" });
      await until(ctx, "demo", (j) => j.nextId === "DEMO0003");
      claim(repo.root, cfg, { title: "two" });
      await until(ctx, "demo", (j) => j.nextId === "DEMO0004");
      assert.ok(ctx.events.seen.every((m) => m.backlog === "demo"));
    });
  } finally { repo.cleanup(); }
});

// ------------------------------------------------------- plan and filters
// A stand-in for fs.watch that records every watch and its callback.
function fakeWatch() {
  const calls = [];
  const watch = (dir, _opts, cb) => {
    const call = { dir, cb, closed: false, watcher: { on() {}, close() { call.closed = true; } } };
    calls.push(call);
    return call.watcher;
  };
  return { calls, watch, live: () => calls.filter((c) => !c.closed).map((c) => c.dir).sort() };
}
const rel = (repo, dirs) => dirs.map((d) => d.replace(repo.root, "").replace(/^\//, "") || ".").sort();
const planOf = (backlog) => [...watchPlan(backlog).keys()];

test("the plan names the tasks root, status directories and config home, or the nearest existing ancestor", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    assert.deepEqual(rel(repo, planOf(b)), ["trellis", "trellis/active"], "directories that do not exist yet are covered by trellis/");
    mkdirSync(repo.folder("completed"), { recursive: true });
    mkdirSync(repo.folder("removed"));
    assert.deepEqual(rel(repo, planOf(b)), ["trellis", "trellis/active", "trellis/completed", "trellis/completed/tasks", "trellis/removed"]);
    // A nested tasks root that is missing is watched through its nearest existing ancestor.
    repo.write("trellis/backlog.config.json", JSON.stringify({ ...BASE_CFG, tasksDir: "docs/tasks" }));
    assert.deepEqual(rel(repo, planOf(b)), [".", "trellis"]);
    mkdirSync(join(repo.root, "docs"));
    assert.deepEqual(rel(repo, planOf(b)), ["docs", "trellis"]);
    mkdirSync(join(repo.root, "docs", "tasks", "active"), { recursive: true });
    assert.deepEqual(rel(repo, planOf(b)), ["docs", "docs/tasks", "docs/tasks/active", "trellis"]);
  } finally { repo.cleanup(); }
});

test("a config change rebuilds the plan: the new root is watched and the old directories are released", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    mkdirSync(join(repo.root, "docs", "tasks", "active"), { recursive: true });
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const fake = fakeWatch();
    const watchers = createWatchers([b], () => {}, { watch: fake.watch });
    watchers.start();
    assert.deepEqual(rel(repo, fake.live()), ["trellis", "trellis/active"]);
    repo.write("trellis/backlog.config.json", JSON.stringify({ ...BASE_CFG, tasksDir: "docs/tasks" }));
    watchers.reconcile(b);
    assert.deepEqual(rel(repo, fake.live()), ["docs", "docs/tasks", "docs/tasks/active", "trellis"]);
    watchers.close();
  } finally { repo.cleanup(); }
});

test("a directory replaced at the same path is re-armed, and a vanished one is released", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const fake = fakeWatch();
    const watchers = createWatchers([b], () => {}, { watch: fake.watch });
    watchers.start();
    const first = fake.calls.find((c) => c.dir === repo.folder("active"));
    watchers.reconcile(b);
    assert.equal(fake.calls.filter((c) => c.dir === repo.folder("active")).length, 1, "an unchanged directory is not re-armed");
    rmSync(repo.folder("active"), { recursive: true });
    mkdirSync(repo.folder("active"));
    watchers.reconcile(b);
    const second = fake.calls.filter((c) => c.dir === repo.folder("active"));
    assert.equal(second.length, 2);
    assert.ok(first.closed && !second[1].closed);
    rmSync(repo.folder("active"), { recursive: true });
    watchers.reconcile(b);
    assert.deepEqual(rel(repo, fake.live()), ["trellis"]);
    watchers.close();
  } finally { repo.cleanup(); }
});

test("an accepted symlink target's directory and its ancestors up to the worktree are planned", posixOnly, () => {
  const repo = makeRepo();
  try {
    repo.add("active", "DEMO0001");
    const link = repo.itemPath("active", "DEMO0001");
    const target = join(repo.root, "docs", "pool", "deep", "real.md");
    mkdirSync(join(repo.root, "docs", "pool", "deep"), { recursive: true });
    writeFileSync(target, readFileSync(link, "utf8"));
    rmSync(link);
    symlinkSync(target, link);
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    b.build();
    assert.deepEqual(rel(repo, planOf(b)), [".", "docs", "docs/pool", "docs/pool/deep", "trellis", "trellis/active"]);
    // A link the reader rejected is never watched.
    rmSync(link);
    writeFileSync(join(repo.dir, "outside.md"), "x");
    symlinkSync(join(repo.dir, "outside.md"), link);
    b.build();
    assert.deepEqual(rel(repo, planOf(b)), ["trellis", "trellis/active"]);
  } finally { repo.cleanup(); }
});

ledgerTest("a ledger backlog also watches the directories that hold the ref's file and packed-refs", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const gitDir = join(repo.root, ".git");
    const dirs = () => planOf(b).map((d) => d.replace(gitDir, "<git>")).filter((d) => d.startsWith("<git>")).sort();
    assert.deepEqual(dirs(), ["<git>", "<git>/refs"], "the ref's own directory is missing, so its nearest ancestor is watched");
    assert.deepEqual([...watchPlan(b).get(join(gitDir, "refs"))], ["trellis"]);
    assert.deepEqual([...watchPlan(b).get(gitDir)], ["packed-refs"]);
    seed(repo.root, loadConfig(repo.root).cfg);
    assert.deepEqual(dirs(), ["<git>", "<git>/refs/trellis"]);
    assert.deepEqual([...watchPlan(b).get(join(gitDir, "refs", "trellis"))], ["ids"]);
  } finally { repo.cleanup(); }
});

test("events invalidate the named path or directory; generated files and unrelated ref names are ignored", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }, { status: "completed", id: "DEMO0002" }, { status: "removed", id: "DEMO0003" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const invalidated = [];
    b.reader.invalidate = (p) => invalidated.push(p);
    const fake = fakeWatch();
    const changed = [];
    const watchers = createWatchers([b], (id) => changed.push(id), { watch: fake.watch, debounceMs: 5 });
    watchers.start();
    const at = (dir) => fake.calls.find((c) => c.dir === dir);
    const tasks = join(repo.root, "trellis");
    for (const name of ["README.md", "backlog.json", "history.json"]) at(tasks).cb("change", name);
    at(join(tasks, "completed")).cb("change", "index.md");
    at(join(tasks, "removed")).cb("change", "index.md");
    assert.deepEqual(invalidated, [], "the backlog's own generated files are ignored");
    // The same names elsewhere are not generated files: a task folder, or any non-artifact path.
    at(repo.folder("active")).cb("change", "README.md");
    at(tasks).cb("change", "index.md");
    assert.deepEqual(invalidated, [join(repo.folder("active"), "README.md"), join(tasks, "index.md")]);
    invalidated.length = 0;
    const active = at(repo.folder("active"));
    active.cb("rename", "DEMO0001.md");
    active.cb("rename", null);
    assert.deepEqual(invalidated, [join(repo.folder("active"), "DEMO0001.md"), repo.folder("active")]);
    const git = at(join(repo.root, ".git"));
    git.cb("rename", "index");
    git.cb("rename", "HEAD.lock");
    assert.equal(invalidated.length, 2, "only packed-refs matters in the git directory");
    git.cb("rename", "packed-refs");
    assert.equal(invalidated.length, 3);
    watchers.close();
  } finally { repo.cleanup(); }
});

test("a ledger ref whose file is named like an artifact still refreshes", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger", idLedgerRef: "refs/trellis/index.md" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    mkdirSync(join(repo.root, ".git", "refs", "trellis"), { recursive: true });
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const invalidated = [];
    b.reader.invalidate = (p) => invalidated.push(p);
    const fake = fakeWatch();
    const watchers = createWatchers([b], () => {}, { watch: fake.watch, debounceMs: 5 });
    watchers.start();
    const holder = fake.calls.find((c) => c.dir === join(repo.root, ".git", "refs", "trellis"));
    assert.ok(holder, "the ref's folder is watched");
    holder.cb("change", "index.md");
    assert.equal(invalidated.length, 1);
    watchers.close();
  } finally { repo.cleanup(); }
});

test("a config with errors is not trusted for watch paths: a numeric idLedgerRef does not throw, and the config folder stays watched", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger", idLedgerRef: 5 }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const plan = [...watchPlan(b).keys()];
    assert.ok(plan.includes(join(repo.root, "trellis")));
    const fake = fakeWatch();
    const watchers = createWatchers([b], () => {}, { watch: fake.watch, debounceMs: 5 });
    watchers.start();
    watchers.close();
  } finally { repo.cleanup(); }
});

test("an event batch is reported once per backlog after the debounce", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const fake = fakeWatch();
    const reported = [];
    let report;
    const first = new Promise((resolve) => { report = resolve; });
    const watchers = createWatchers([b], (id) => { reported.push(id); report(); }, { watch: fake.watch, debounceMs: 20 });
    watchers.start();
    const active = fake.calls.find((c) => c.dir === repo.folder("active"));
    for (let i = 0; i < 5; i++) active.cb("change", "DEMO0001.md");
    assert.deepEqual(reported, [], "nothing is reported before the debounce");
    // The debounce timer is unref'd (the server keeps the process alive), so hold the loop open.
    const hold = setInterval(() => {}, 1000);
    try { await first; } finally { clearInterval(hold); }
    assert.deepEqual(reported, ["demo"]);
    watchers.close();
  } finally { repo.cleanup(); }
});
