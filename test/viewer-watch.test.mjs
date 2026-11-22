// Behavior tests for live reload (src/viewer/watch.mjs through the server's /events stream,
// TRL0005). Live tests wait on the real completion signal: an SSE message, then the API's own
// answer. The plan and event-filter tests run on a stand-in for fs.watch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadConfig } from "../src/backlog.mjs";
import { claim, seed } from "../src/ledger.mjs";
import { createBacklog, recordOf } from "../src/viewer/backlogs.mjs";
import { startViewer } from "../src/viewer/server.mjs";
import { createWatchers, watchPlan } from "../src/viewer/watch.mjs";
import { ledgerTest } from "./git-support.mjs";
import { BASE_CFG, FIXTURE_DIST, getJson, makeRepo, openEvents } from "./viewer-support.mjs";

const posixOnly = process.platform === "win32" ? { skip: "needs POSIX symlinks" } : {};
const STAMP = 1_700_000_000;
const stamp = (file) => utimesSync(file, STAMP, STAMP);

// A live viewer over `repos` ({ id: repo }) with an event stream; stops everything afterwards.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// fs.watch on macOS can miss changes made in the first moments after it attaches (seen when
// the whole suite loads the disk). Before a test edits anything, poke each backlog with a
// probe file until a message proves its watchers deliver, then wait for the stream to go
// quiet so no probe message is mistaken for the test's own.
async function warmUp(repos, events) {
  for (const [id, repo] of Object.entries(repos)) {
    const dir = existsSync(repo.folder("active")) ? repo.folder("active") : join(repo.root, repo.tasksDir ?? "trellis");
    const probe = join(dir, ".watch-probe");
    for (let n = 0; !events.seen.some((m) => m.backlog === id); n++) {
      if (n > 40) throw new Error(`watchers for ${id} never delivered a change`);
      writeFileSync(probe, String(n));
      await pause(250);
    }
    rmSync(probe, { force: true });
  }
  for (let quiet = 0, last = events.seen.length; quiet < 4; ) {
    await pause(250);
    if (events.seen.length === last) quiet++; else { quiet = 0; last = events.seen.length; }
  }
}

async function live(repos, fn) {
  const entries = Object.entries(repos).map(([id, repo]) => ({ id, name: id, path: repo.root }));
  const viewer = await startViewer({ entries, port: 0, distDir: FIXTURE_DIST, watch: true });
  const events = await openEvents(viewer.port);
  try {
    await warmUp(repos, events);
    // Drop what the warm-up left queued, and skip any probe message that still arrives late,
    // so a direct `next` or `until` can only be satisfied by the test's own edit.
    events.drain();
    const warm = events.seen.length;
    const next = async (id) => {
      for (;;) {
        const msg = await events.next(id);
        if (events.seen.indexOf(msg) >= warm) return msg;
      }
    };
    // Tests read `seen` from here on, so the probe's messages never count.
    const view = { ...events, get seen() { return events.seen.slice(warm); }, next, close: () => events.close() };
    return await fn({ port: viewer.port, events: view, viewer });
  } finally { events.close(); await viewer.close(); }
}

// Called right after an edit. Waits for a message sent after that edit before each read, so a
// watcher that never broadcasts fails the test instead of being papered over by the API's own read.
// Accepts only messages that arrived after the previous successful wait, so the edit's
// own message counts even when it lands before this call (the edit happens first).
async function until(ctx, id, ok) {
  const { port, events } = ctx;
  const mark = ctx.consumed ?? 0;
  for (;;) {
    const msg = await events.next(id);
    if (events.seen.indexOf(msg) < mark) continue;
    const { json } = await getJson(port, `/api/backlogs/${id}`);
    if (ok(json)) { ctx.consumed = events.seen.length; return json; }
  }
}
const titles = (json) => (json.tasks || []).map((t) => t.title).join();

test("editing a task title in the main worktree sends a message for that backlog while another is served", async () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "Before" } }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" }, items: [{ status: "active", id: "OTH0001", fm: { title: "Other" } }] });
  try {
    await live({ a, b }, async (ctx) => {
      writeFileSync(a.itemPath("active", "DEMO0001"), readFileSync(a.itemPath("active", "DEMO0001"), "utf8").replace("Before", "After!"));
      await until(ctx, "a", (j) => titles(j) === "After!");
      // That a's edit names a alone is checked deterministically by "an event in one backlog's
      // directory notifies that backlog only"; live timing cannot prove an absence.
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
      // Which backlog is named is covered by "an event in one backlog's directory notifies that backlog only".
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
      // That first read armed the watchers on the target's folders, which sends its own message.
      // Take it now, so it cannot satisfy the wait for the replacement below.
      await ctx.events.next("demo");
      rmSync(join(repo.root, "docs", "pool"), { recursive: true });
      mkdirSync(join(repo.root, "docs", "pool", "deep"), { recursive: true });
      writeFileSync(target, original.replace("AAAAA", "ZZZZZ"));
      stamp(target);
      await until(ctx, "demo", (j) => titles(j) === "ZZZZZ");
    });
  } finally { repo.cleanup(); }
});

test("retargeting a middle link of a two-hop chain is reported, though its folder is no ancestor of the final target", posixOnly, async () => {
  const repo = makeRepo();
  try {
    repo.add("active", "DEMO0001", { title: "AAAAA" });
    const link = repo.itemPath("active", "DEMO0001");
    const original = readFileSync(link, "utf8");
    const first = join(repo.root, "docs", "pool", "first.md");
    const second = join(repo.root, "docs", "pool", "second.md");
    const middle = join(repo.root, "hop", "middle.md");
    rmSync(link);
    mkdirSync(join(repo.root, "docs", "pool"), { recursive: true });
    mkdirSync(join(repo.root, "hop"));
    writeFileSync(first, original);
    writeFileSync(second, original.replace("AAAAA", "ZZZZZ"));
    symlinkSync(first, middle);
    symlinkSync(middle, link);
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    b.build();
    assert.ok(rel(repo, planOf(b)).includes("hop"), "the middle link's folder is planned");
    await live({ demo: repo }, async (ctx) => {
      assert.equal(titles((await getJson(ctx.port, "/api/backlogs/demo")).json), "AAAAA");
      await ctx.events.next("demo");
      rmSync(middle);
      symlinkSync(second, middle);
      await until(ctx, "demo", (j) => titles(j) === "ZZZZZ");
    });
  } finally { repo.cleanup(); }
});

test("a link target with .. after a symlinked directory is followed through that directory, so the real hop folders are planned", posixOnly, () => {
  const repo = makeRepo();
  try {
    repo.add("active", "DEMO0001", { title: "AAAAA" });
    const link = repo.itemPath("active", "DEMO0001");
    const original = readFileSync(link, "utf8");
    rmSync(link);
    mkdirSync(join(repo.root, "a"));
    mkdirSync(join(repo.root, "b", "c"), { recursive: true });
    mkdirSync(join(repo.root, "docs"));
    writeFileSync(join(repo.root, "docs", "x.md"), original);
    symlinkSync(join(repo.root, "b", "c"), join(repo.root, "a", "alias"));
    symlinkSync(join(repo.root, "docs", "x.md"), join(repo.root, "b", "middle.md"));
    // OS resolution: a/alias -> b/c, then .. -> b, so middle.md is b/middle.md. Collapsing the
    // text first would look for a/middle.md, which does not exist.
    symlinkSync("../../a/alias/../middle.md", link);
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    b.build();
    const dirs = rel(repo, planOf(b));
    assert.ok(dirs.includes("b"), `the real folder of the middle link is planned: ${dirs}`);
    assert.ok(dirs.includes("a"), "the folder holding the alias is planned");
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
      // Which backlog is named is covered by "an event in one backlog's directory notifies that backlog only".
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
// Paths relative to a base, written with "/" so the expectations read the same on every platform.
const relTo = (base, d) => relative(base, d).split(sep).join("/") || ".";
const rel = (repo, dirs) => dirs.map((d) => relTo(repo.root, d)).sort();
const planOf = (backlog) => [...watchPlan(backlog).keys()];

test("the plan names the tasks root, status directories and config home, or the nearest existing ancestor", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    assert.deepEqual(rel(repo, planOf(b)), [".", "trellis", "trellis/active"], "directories that do not exist yet are covered by trellis/");
    mkdirSync(repo.folder("completed"), { recursive: true });
    mkdirSync(repo.folder("removed"));
    assert.deepEqual(rel(repo, planOf(b)), [".", "trellis", "trellis/active", "trellis/completed", "trellis/completed/tasks", "trellis/removed"]);
    // A nested tasks root that is missing is watched through its nearest existing ancestor.
    repo.write("trellis/backlog.config.json", JSON.stringify({ ...BASE_CFG, tasksDir: "docs/tasks" }));
    assert.deepEqual(rel(repo, planOf(b)), [".", "trellis"]);
    mkdirSync(join(repo.root, "docs"));
    assert.deepEqual(rel(repo, planOf(b)), [".", "docs", "trellis"]);
    mkdirSync(join(repo.root, "docs", "tasks", "active"), { recursive: true });
    assert.deepEqual(rel(repo, planOf(b)), [".", "docs", "docs/tasks", "docs/tasks/active", "trellis"]);
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
    assert.deepEqual(rel(repo, fake.live()), [".", "trellis", "trellis/active"]);
    repo.write("trellis/backlog.config.json", JSON.stringify({ ...BASE_CFG, tasksDir: "docs/tasks" }));
    watchers.reconcile(b);
    assert.deepEqual(rel(repo, fake.live()), [".", "docs", "docs/tasks", "docs/tasks/active", "trellis"]);
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
    assert.deepEqual(rel(repo, fake.live()), [".", "trellis"]);
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
    assert.deepEqual(rel(repo, planOf(b)), [".", "trellis", "trellis/active"]);
    // A target accepted earlier whose directory has since become a link out of the worktree is dropped.
    rmSync(link);
    symlinkSync(target, link);
    b.build();
    const outside = join(repo.dir, "elsewhere");
    mkdirSync(join(outside, "deep"), { recursive: true });
    writeFileSync(join(outside, "deep", "real.md"), "x");
    rmSync(join(repo.root, "docs", "pool"), { recursive: true });
    symlinkSync(outside, join(repo.root, "docs", "pool"));
    const dirs = planOf(b);
    assert.ok(dirs.every((d) => { const r = relative(repo.root, d); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); }), `nothing outside the worktree: ${dirs}`);
    assert.ok(!dirs.some((d) => d.includes("pool")));
  } finally { repo.cleanup(); }
});

test("the worktree root is watched for the tasks root's top entry, so replacing a rejected symlinked root with a real one is reported", posixOnly, () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    assert.deepEqual([...watchPlan(b).get(repo.root)], ["trellis"], "even the default root is watched through its parent");
    // Send the whole backlog outside the worktree, which the reader rejects.
    const outside = join(repo.dir, "outside-trellis");
    renameSync(join(repo.root, "trellis"), outside);
    symlinkSync(outside, join(repo.root, "trellis"));
    const fake = fakeWatch();
    const changed = [];
    const watchers = createWatchers([b], (id) => changed.push(id), { watch: fake.watch, debounceMs: 5 });
    watchers.start();
    assert.deepEqual(rel(repo, fake.live()), ["."], "nothing outside is watched, only the contained parent");
    const rootWatch = fake.calls.find((c) => c.dir === repo.root);
    const invalidated = [];
    b.reader.invalidate = (p) => invalidated.push(p);
    rootWatch.cb("rename", "unrelated");
    assert.deepEqual(invalidated, [], "other names in the worktree root are ignored");
    rootWatch.cb("rename", "trellis");
    assert.deepEqual(invalidated, [join(repo.root, "trellis")]);
    watchers.close();
  } finally { repo.cleanup(); }
});

ledgerTest("a ledger backlog also watches the directories that hold the ref's file and packed-refs", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    const gitDir = join(repo.root, ".git");
    const dirs = () => planOf(b).map((d) => [d, relTo(gitDir, d)]).filter(([, r]) => !r.startsWith("..") && !isAbsolute(r))
      .map(([, r]) => (r === "." ? "<git>" : `<git>/${r}`)).sort();
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

test("an event in one backlog's directory notifies that backlog only", async () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" }, items: [{ status: "active", id: "OTH0001" }] });
  try {
    const ba = createBacklog({ id: "a", name: "A", path: a.root });
    const bb = createBacklog({ id: "b", name: "B", path: b.root });
    ba.build(); bb.build();
    const fake = fakeWatch();
    const changed = [];
    let done;
    const settled = new Promise((r) => { done = r; });
    const watchers = createWatchers([ba, bb], (id) => { changed.push(id); done(); }, { watch: fake.watch, debounceMs: 5 });
    watchers.start();
    fake.calls.find((c) => c.dir === a.folder("active")).cb("change", "DEMO0001.md");
    // The debounce timer is unref'd, so hold the event loop open until it fires.
    const keepAlive = setTimeout(() => {}, 10_000);
    try { await settled; } finally { clearTimeout(keepAlive); }
    assert.deepEqual(changed, ["a"]);
    watchers.close();
  } finally { a.cleanup(); b.cleanup(); }
});

test("the sweep re-arms a planned directory whose creation event was missed", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    b.build();
    const fake = fakeWatch();
    let done;
    const changed = new Promise((r) => { done = r; });
    const watchers = createWatchers([b], () => done(), { watch: fake.watch, debounceMs: 5, sweepMs: 20 });
    watchers.start();
    // completed/tasks appears with no event reaching the watcher (the fake never fires one).
    mkdirSync(repo.folder("completed"), { recursive: true });
    const keepAlive = setTimeout(() => {}, 10_000);
    try { await changed; } finally { clearTimeout(keepAlive); }
    assert.ok(fake.live().includes(repo.folder("completed")), "the sweep armed the new directory");
    watchers.close();
  } finally { repo.cleanup(); }
});

test("the sweep reports an edit whose change event was missed", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "Before" } }] });
  try {
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root });
    b.build();
    const fake = fakeWatch();
    const changed = [];
    let done;
    const got = new Promise((r) => { done = r; });
    const watchers = createWatchers([b], (id) => { changed.push(id); done(); }, { watch: fake.watch, debounceMs: 5, sweepMs: 20 });
    watchers.start();
    // Let one sweep record the starting signature, then edit with no event delivered.
    const first = new Promise((r) => setTimeout(r, 60));
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
      await first;
      const file = repo.itemPath("active", "DEMO0001");
      writeFileSync(file, readFileSync(file, "utf8").replace("Before", "After, longer"));
      await got;
    } finally { clearTimeout(keepAlive); }
    assert.deepEqual(changed, ["demo"]);
    assert.equal(recordOf(b.build()).tasks[0].title, "After, longer");
    watchers.close();
  } finally { repo.cleanup(); }
});
