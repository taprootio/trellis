// Behavior tests for per-backlog viewer state: the contained cached reader, canonical copies,
// records and errors (src/viewer/reader.mjs, src/viewer/backlogs.mjs, TRL0005).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, readBacklog } from "../src/backlog.mjs";
import { claim, seed } from "../src/ledger.mjs";
import { createBacklog, recordOf, summaryOf, taskDetailOf } from "../src/viewer/backlogs.mjs";
import { ledgerTest } from "./git-support.mjs";
import { BASE_CFG, FISH_CFG, TUNA_SVG, makeRepo, tmp } from "./viewer-support.mjs";

const posixOnly = process.platform === "win32" ? { skip: "needs POSIX FIFOs" } : {};
const open = (repo, id = "demo") => createBacklog({ id, name: id, path: repo.root });
const task = (b, id) => b.tasks.get(id).record;
const mkfifo = (path) => assert.equal(spawnSync("mkfifo", [path]).status, 0);

test("each backlog is read with its own prefix, milestones and counts", () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "active", id: "DEMO0002" }, { status: "completed", id: "DEMO0003" }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH", milestones: ["M1"], specVersion: "2.3" }, items: [{ status: "active", id: "OTH0001", fm: { milestone: "M1" } }] });
  try {
    const ra = recordOf(open(a, "a").build());
    const rb = recordOf(open(b, "b").build());
    assert.deepEqual([ra.prefix, ra.milestones, ra.counts, ra.nextId], ["DEMO", ["Alpha", "Beta"], { active: 2, completed: 1, removed: 0 }, "DEMO0004"]);
    assert.deepEqual([rb.prefix, rb.milestones, rb.counts, rb.nextId], ["OTH", ["M1"], { active: 1, completed: 0, removed: 0 }, "OTH0002"]);
    assert.deepEqual(ra.tasks.map((t) => t.id), ["DEMO0001", "DEMO0002", "DEMO0003"]);
    assert.deepEqual(summaryOf(open(a, "a").build()), { id: "a", name: "a", path: a.root, mainWorktree: a.root, status: "ok", errors: [], counts: ra.counts, nextId: "DEMO0004" });
  } finally { a.cleanup(); b.cleanup(); }
});

test("a path naming a linked worktree serves the main worktree only", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const lane = repo.lane("lane");
    mkdirSync(join(lane, "trellis", "active"), { recursive: true });
    writeFileSync(join(lane, "trellis", "active", "DEMO0002.md"), readFileSync(repo.itemPath("active", "DEMO0001"), "utf8").replaceAll("DEMO0001", "DEMO0002"));
    const b = createBacklog({ id: "demo", name: "Demo", path: lane });
    assert.equal(b.mainWorktree, repo.root);
    assert.deepEqual(b.build().order, ["DEMO0001"]);
    repo.add("active", "DEMO0003");
    assert.deepEqual(b.build().order, ["DEMO0001", "DEMO0003"]);
  } finally { repo.cleanup(); }
});

test("a missing path, a null config, a config without milestones and a bad idPrefix each fail only that backlog", () => {
  const good = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  const nullCfg = makeRepo({ rawConfig: "null" });
  const noMilestones = makeRepo({ cfg: { ...BASE_CFG, milestones: undefined } });
  const badPrefix = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "[" } });
  const noConfig = makeRepo({ rawConfig: "{}" });
  try {
    const entries = [
      createBacklog({ id: "gone", name: "Gone", path: join(good.dir, "missing") }),
      open(nullCfg, "nullcfg"), open(noMilestones, "nomilestones"), open(badPrefix, "badprefix"), open(noConfig, "empty"), open(good, "good"),
    ];
    const builds = entries.map((e) => e.build());
    assert.deepEqual(builds.map((x) => x.status), ["error", "error", "error", "error", "error", "ok"]);
    assert.match(builds[0].errors[0], /does not exist/);
    assert.match(builds[1].errors[0], /JSON object/);
    assert.match(builds[2].errors.join(), /milestones/);
    assert.match(builds[3].errors.join(), /idPrefix/);
    assert.deepEqual(recordOf(builds[1]), { id: "nullcfg", name: "nullcfg", status: "error", errors: builds[1].errors, diagnostics: [] });
    assert.deepEqual(summaryOf(builds[0]).counts, { active: 0, completed: 0, removed: 0 });
    assert.equal(summaryOf(builds[0]).nextId, null);
    assert.deepEqual(builds[5].order, ["DEMO0001"]);
  } finally { for (const r of [good, nullCfg, noMilestones, badPrefix, noConfig]) r.cleanup(); }
});

test("a first worktree that is another repository's checkout fails that backlog", () => {
  const a = makeRepo();
  try {
    const fake = (_cwd, args) => (args[0] === "worktree"
      ? { status: 0, stdout: `worktree ${tmp("other")}\0\0`, stderr: "" }
      : { status: 1, stdout: "", stderr: "fatal" });
    const b = createBacklog({ id: "x", name: "X", path: a.root }, { git: fake });
    assert.equal(b.build().status, "error");
    assert.match(b.build().errors[0], /unsupported layout/);
  } finally { a.cleanup(); }
});

test("a legacy completed item with null fields is completed and never needs attention", () => {
  const repo = makeRepo({
    cfg: { ...BASE_CFG, legacy: { through: "DEMO0001", closedBefore: "2026-06-01" } },
    items: [{ status: "completed", id: "DEMO0001", fm: { summary: undefined, milestone: undefined, priority: undefined, effort: undefined } }],
  });
  try {
    const t = task(open(repo).build(), "DEMO0001");
    assert.deepEqual([t.status, t.milestone, t.priority, t.effort, t.summary, t.needsAttention, t.validationErrors], ["completed", null, null, null, null, false, []]);
    assert.deepEqual(t.effortDisplay, { label: null, value: null, emoji: null, imageUrl: null, text: "" });
  } finally { repo.cleanup(); }
});

test("an active item with no milestone or an unknown one needs attention", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { milestone: undefined } }, { status: "active", id: "DEMO0002", fm: { milestone: "Nope" } }, { status: "active", id: "DEMO0003" }] });
  try {
    const b = open(repo).build();
    assert.deepEqual(["DEMO0001", "DEMO0002", "DEMO0003"].map((id) => task(b, id).needsAttention), [true, true, false]);
    assert.ok(task(b, "DEMO0002").validationErrors.some((e) => /milestone must be one of/.test(e)));
  } finally { repo.cleanup(); }
});

test("an id in two status folders returns the most closed copy and lists the other path", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "completed", id: "DEMO0001" }, { status: "removed", id: "DEMO0002" }, { status: "completed", id: "DEMO0002" }] });
  try {
    const b = open(repo).build();
    assert.deepEqual([task(b, "DEMO0001").status, task(b, "DEMO0002").status], ["completed", "removed"]);
    assert.deepEqual(b.counts, { active: 0, completed: 1, removed: 1 });
    assert.ok(b.diagnostics.some((d) => d.path === "active/DEMO0001.md" && /canonical copy is completed\/tasks\/DEMO0001\.md/.test(d.message)));
    assert.ok(task(b, "DEMO0001").validationErrors.every((e) => !e.startsWith("active/")));
  } finally { repo.cleanup(); }
});

const BROKEN = "---\nid: DEMO0001\ntitle: Broken\nstatus: completed\nthis line is not a key\n---\n\nBody\n";

test("a valid active copy beside a completed copy with a front-matter syntax error stays active, also on rebuild", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    repo.write("trellis/completed/tasks/DEMO0001.md", BROKEN);
    const b = open(repo);
    for (let i = 0; i < 2; i++) {
      const out = b.build();
      assert.equal(task(out, "DEMO0001").status, "active");
      assert.ok(out.diagnostics.some((d) => d.path === "completed/tasks/DEMO0001.md" && /cannot parse front-matter line/.test(d.message)), "syntax diagnostic replays from the cache");
      assert.ok(out.diagnostics.some((d) => d.path === "completed/tasks/DEMO0001.md" && /duplicate of DEMO0001/.test(d.message)));
    }
  } finally { repo.cleanup(); }
});

test("a valid active copy beside an unreadable completed copy stays active, with a diagnostic", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "completed", id: "DEMO0001" }] });
  try {
    chmodSync(repo.itemPath("completed", "DEMO0001"), 0o000);
    const out = open(repo).build();
    assert.equal(task(out, "DEMO0001").status, "active");
    assert.ok(out.diagnostics.some((d) => d.path === "completed/tasks/DEMO0001.md" && /cannot open/.test(d.message)));
  } finally { chmodSync(repo.itemPath("completed", "DEMO0001"), 0o644); repo.cleanup(); }
});

test("unterminated front matter is a diagnostic, and an authored id that differs from the filename is returned under the filename", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0006", fm: { id: "DEMO0099" } }] });
  try {
    repo.write("trellis/active/DEMO0007.md", "---\nid: DEMO0007\ntitle: Never closed\n\nBody\n");
    const out = open(repo).build();
    assert.deepEqual(out.order, ["DEMO0006"]);
    assert.ok(out.diagnostics.some((d) => d.path === "active/DEMO0007.md" && /unterminated/.test(d.message)));
    assert.ok(task(out, "DEMO0006").validationErrors.some((e) => /does not match filename/.test(e)));
    assert.equal(taskDetailOf(out, "DEMO0006").frontMatter.id, "DEMO0099");
  } finally { repo.cleanup(); }
});

test("a task symlinked outside the worktree, or a FIFO, is skipped and listed without blocking", posixOnly, () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const outside = join(repo.dir, "outside.md");
    writeFileSync(outside, readFileSync(repo.itemPath("active", "DEMO0001"), "utf8").replaceAll("DEMO0001", "DEMO0002"));
    symlinkSync(outside, repo.itemPath("active", "DEMO0002"));
    mkfifo(repo.itemPath("active", "DEMO0003"));
    const out = open(repo).build();
    assert.deepEqual(out.order, ["DEMO0001"]);
    assert.ok(out.diagnostics.some((d) => d.path === "active/DEMO0002.md" && /outside the main worktree/.test(d.message)));
    assert.ok(out.diagnostics.some((d) => d.path === "active/DEMO0003.md" && /not a regular file/.test(d.message)));
  } finally { repo.cleanup(); }
});

test("a FIFO in place of the config or the roster is a config error instead of a hang", posixOnly, () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    rmSync(join(a.root, "trellis", "backlog.config.json"));
    mkfifo(join(a.root, "trellis", "backlog.config.json"));
    assert.match(open(a).build().errors[0], /was skipped \(not a regular file\)/);
    mkfifo(join(b.root, "trellis", "team.json"));
    const out = open(b).build();
    assert.equal(out.status, "error");
    assert.match(out.errors[0], /team\.json was skipped/);
  } finally { a.cleanup(); b.cleanup(); }
});

test("a scan backlog with idPrefix R+ shows the items `trellis check` accepts", () => {
  const cfg = { ...BASE_CFG, idPrefix: "R+" };
  const repo = makeRepo({ cfg, items: [{ status: "active", id: "RR0001" }, { status: "active", id: "RRR0002" }] });
  try {
    repo.write("trellis/active/R0003.md", "---\nid: R0003\n---\n");
    const expected = readBacklog(repo.root, loadConfig(repo.root).cfg).active.map((i) => i._file.replace(/\.md$/, ""));
    assert.deepEqual(open(repo).build().order, expected);
    assert.ok(expected.includes("RR0001"));
  } finally { repo.cleanup(); }
});

test("effort display: label · N with emoji or the scale's image under a nested tasksDir, and the bare number on the identity scale", () => {
  const repo = makeRepo({
    cfg: { ...FISH_CFG, tasksDir: "docs/tasks" },
    items: [
      { status: "active", id: "DEMO0001", fm: { effort: 3 } },
      { status: "active", id: "DEMO0002", fm: { effort: "tuna" } },
      { status: "active", id: "DEMO0003", fm: { effort: 3, _effortImage: "assets/effort/evil.svg", _effortLabel: "Fake" } },
      { status: "completed", id: "DEMO0004", fm: { effort: "Retired" } },
    ],
  });
  const plain = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }, { status: "active", id: "DEMO0002", fm: { title: 404 } }, { status: "active", id: "DEMO0003", fm: { title: undefined } }] });
  try {
    const b = open(repo).build();
    assert.deepEqual(task(b, "DEMO0001").effortDisplay, { label: "Trout", value: 3, emoji: "🐡", imageUrl: null, text: "Trout · 3" });
    assert.deepEqual(task(b, "DEMO0002").effortDisplay, { label: "Tuna", value: 5, emoji: null, imageUrl: "/assets/demo/effort/tuna.svg", text: "Tuna · 5" });
    assert.equal(task(b, "DEMO0002").effortImage, "assets/effort/tuna.svg");
    const authored = task(b, "DEMO0003");
    assert.deepEqual([authored.effortDisplay.imageUrl, authored.effortImage, authored.effortLabel], [null, undefined, "Trout"]);
    assert.deepEqual(task(b, "DEMO0004").effortDisplay.text, "");
    assert.deepEqual(task(b, "DEMO0004").validationErrors, [], "a retired label on a completed task is valid");
    assert.deepEqual([...b.assets], ["effort/tuna.svg"]);
    const rec = recordOf(b);
    assert.deepEqual(rec.config.effortScale.values[3], { value: 5, label: "Tuna", emoji: null, imageUrl: "/assets/demo/effort/tuna.svg" });
    assert.equal(rec.config.effortScale.name, "fish");

    const p = open(plain).build();
    assert.deepEqual(task(p, "DEMO0001").effortDisplay, { label: "5", value: 5, emoji: null, imageUrl: null, text: "5" });
    assert.equal(task(p, "DEMO0001").effortLabel, undefined);
    assert.equal(recordOf(p).config.effortScale.name, null);
    assert.equal(task(p, "DEMO0002").title, 404);
    assert.equal("title" in task(p, "DEMO0003"), false);
  } finally { repo.cleanup(); plain.cleanup(); }
});

test("a task with no depends_on key says so, and one with an empty list does not", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { depends_on: undefined } }, { status: "active", id: "DEMO0002" }] });
  try {
    const b = open(repo).build();
    assert.deepEqual([task(b, "DEMO0001").dependsOnMissing, task(b, "DEMO0001").depends_on], [true, []]);
    assert.equal("dependsOnMissing" in task(b, "DEMO0002"), false);
  } finally { repo.cleanup(); }
});

test("a status directory symlinked outside the worktree contributes no items and no next id", posixOnly, () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const outside = join(repo.dir, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "DEMO0099.md"), readFileSync(repo.itemPath("active", "DEMO0001"), "utf8").replaceAll("DEMO0001", "DEMO0099").replace("status: active", "status: removed"));
    symlinkSync(outside, join(repo.root, "trellis", "removed"));
    const out = open(repo).build();
    assert.deepEqual([out.order, out.nextId], [["DEMO0001"], "DEMO0002"]);
    assert.ok(out.diagnostics.some((d) => d.path === "removed" && /outside the main worktree/.test(d.message)));
  } finally { repo.cleanup(); }
});

test("a status directory removed during a rebuild is skipped with a diagnostic, and its ids add nothing", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "completed", id: "DEMO0009" }] });
  try {
    const dir = repo.folder("completed");
    let removed = false;
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root }, { hooks: { afterList(d) { if (d === dir && !removed) { removed = true; rmSync(dir, { recursive: true }); } } } });
    const out = b.build();
    assert.ok(removed);
    assert.deepEqual([out.status, out.order, out.nextId], ["ok", ["DEMO0001"], "DEMO0002"]);
    assert.ok(out.diagnostics.some((d) => d.path === "completed/tasks" && /vanished/.test(d.message)));
  } finally { repo.cleanup(); }
});

test("a task removed between listing and reading is skipped, and a task swapped for a FIFO after the path check does not block", posixOnly, () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "active", id: "DEMO0002" }, { status: "active", id: "DEMO0003" }] });
  try {
    const gone = repo.itemPath("active", "DEMO0002");
    const swapped = repo.itemPath("active", "DEMO0003");
    const b = createBacklog({ id: "demo", name: "Demo", path: repo.root }, {
      hooks: { beforeOpen(p) { if (p === gone) unlinkSync(p); if (p === swapped) { unlinkSync(p); mkfifo(p); } } },
    });
    const out = b.build();
    assert.deepEqual(out.order, ["DEMO0001"]);
    assert.ok(out.diagnostics.some((d) => d.path === "active/DEMO0002.md" && /vanished/.test(d.message)));
    assert.ok(out.diagnostics.some((d) => d.path === "active/DEMO0003.md" && /not a regular file/.test(d.message)));
  } finally { repo.cleanup(); }
});

// Whole-second times survive utimes exactly, so a replacement can keep the very same mtime.
const STAMP = 1_700_000_000;
const stamp = (file) => utimesSync(file, STAMP, STAMP);
function replaceKeepingStamp(file, text) {
  writeFileSync(file, text);
  stamp(file);
}

test("the cache replays by path, size and mtime; a named path or directory re-reads", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { title: "AAAAA" } }] });
  try {
    const b = open(repo);
    const file = repo.itemPath("active", "DEMO0001");
    stamp(file);
    assert.equal(task(b.build(), "DEMO0001").title, "AAAAA");
    replaceKeepingStamp(file, readFileSync(file, "utf8").replace("AAAAA", "BBBBB"));
    assert.equal(task(b.build(), "DEMO0001").title, "AAAAA", "same size and mtime hits the cache");
    b.reader.invalidate(file);
    assert.equal(task(b.build(), "DEMO0001").title, "BBBBB");
    // A directory event covers everything beneath it.
    replaceKeepingStamp(file, readFileSync(file, "utf8").replace("BBBBB", "CCCCC"));
    b.reader.invalidate(dirname(file));
    assert.equal(task(b.build(), "DEMO0001").title, "CCCCC");
  } finally { repo.cleanup(); }
});

test("a symlinked task whose target sits in a replaced subtree is re-read when that subtree is named", posixOnly, () => {
  const repo = makeRepo();
  try {
    const target = (dir) => join(repo.root, "docs", dir, "pool", "real.md");
    repo.add("active", "DEMO0001", { title: "AAAAA" });
    const original = readFileSync(repo.itemPath("active", "DEMO0001"), "utf8");
    rmSync(repo.itemPath("active", "DEMO0001"));
    mkdirSync(dirname(target("v")), { recursive: true });
    writeFileSync(target("v"), original);
    stamp(target("v"));
    symlinkSync(target("v"), repo.itemPath("active", "DEMO0001"));
    const b = open(repo);
    assert.equal(task(b.build(), "DEMO0001").title, "AAAAA");
    assert.deepEqual(b.reader.symlinkTargets().map((t) => t.replace(repo.root, "")), ["/docs/v/pool/real.md"]);
    // Replace the whole subtree, keeping size and mtime, then name the subtree's directory.
    rmSync(join(repo.root, "docs", "v"), { recursive: true });
    mkdirSync(dirname(target("v")), { recursive: true });
    replaceKeepingStamp(target("v"), original.replace("AAAAA", "ZZZZZ"));
    assert.equal(task(b.build(), "DEMO0001").title, "AAAAA");
    b.reader.invalidate(join(repo.root, "docs", "v"));
    assert.equal(task(b.build(), "DEMO0001").title, "ZZZZZ");
  } finally { repo.cleanup(); }
});

test("an effort image is read only from inside the asset root", posixOnly, () => {
  const repo = makeRepo({ cfg: FISH_CFG, items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }] });
  try {
    repo.write("trellis/assets/effort/tuna.svg", TUNA_SVG);
    writeFileSync(join(repo.dir, "secret.svg"), "secret");
    symlinkSync(join(repo.dir, "secret.svg"), join(repo.root, "trellis", "assets", "effort", "escape.svg"));
    mkfifo(join(repo.root, "trellis", "assets", "effort", "pipe.svg"));
    const b = open(repo);
    const out = b.build();
    const root = out.assetRoot;
    assert.equal(b.reader.readBinary(join(root, "effort", "tuna.svg"), root).toString(), TUNA_SVG);
    assert.equal(b.reader.readBinary(join(root, "effort", "escape.svg"), root), null);
    assert.equal(b.reader.readBinary(join(root, "effort", "pipe.svg"), root), null);
    assert.equal(b.reader.readBinary(join(root, "..", "backlog.config.json"), root), null);
  } finally { repo.cleanup(); }
});

test("task detail renders bodyHtml inert and links same-backlog task files, under a nested tasksDir too", () => {
  const repo = makeRepo({
    cfg: { ...BASE_CFG, tasksDir: "docs/tasks" },
    items: [
      { status: "active", id: "DEMO0001" },
      { status: "completed", id: "DEMO0002", body: "<script>alert(1)</script>\n\n[dep](../../active/DEMO0001.md#top) [read](../../../../README.md) [js](javascript:alert(1)) [net](//evil.example) [net2](/\\evil.example)\n" },
    ],
  });
  try {
    const out = open(repo).build();
    const detail = taskDetailOf(out, "DEMO0002");
    assert.doesNotMatch(detail.bodyHtml, /<script/);
    assert.equal(detail.bodyHtml.match(/<a /g).length, 1);
    assert.match(detail.bodyHtml, /<a href="\/b\/demo\/task\/DEMO0001">dep<\/a>/);
    assert.equal(detail.frontMatter.title, "Title DEMO0002");
    assert.equal(detail.id, "DEMO0002");
    for (const bad of ["DEMO9999", "../README", "demo0001", "DEMO001", ""]) assert.equal(taskDetailOf(out, bad), null, bad);
  } finally { repo.cleanup(); }
});

ledgerTest("a ledger backlog's next id is null without a ref, follows a claim with no task file touched, and ignores nothing a lane holds", () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = open(repo);
    const before = b.build();
    assert.equal(before.nextId, null);
    assert.match(recordOf(before).nextIdReason, /ledger/);
    const cfg = loadConfig(repo.root).cfg;
    seed(repo.root, cfg);
    assert.equal(b.build().nextId, "DEMO0002");
    assert.equal(recordOf(b.build()).nextIdReason, undefined);
    claim(repo.root, cfg, { title: "x" });
    assert.equal(b.build().nextId, "DEMO0003");
    // A task that exists only in a linked worktree: no card, but the id moves past it.
    const lane = repo.lane("lane");
    mkdirSync(join(lane, "trellis", "active"), { recursive: true });
    writeFileSync(join(lane, "trellis", "active", "DEMO0050.md"), readFileSync(repo.itemPath("active", "DEMO0001"), "utf8").replaceAll("DEMO0001", "DEMO0050"));
    const out = b.build();
    assert.deepEqual(out.order, ["DEMO0001"]);
    assert.equal(out.nextId, "DEMO0051");
  } finally { repo.cleanup(); }
});

test("renaming a task directory away and back is read fresh each time", () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const b = open(repo);
    assert.equal(b.build().order.length, 1);
    renameSync(repo.folder("active"), join(repo.dir, "parked"));
    assert.equal(b.build().order.length, 0);
    renameSync(join(repo.dir, "parked"), repo.folder("active"));
    assert.equal(b.build().order.length, 1);
  } finally { repo.cleanup(); }
});
