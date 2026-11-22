// Behavior tests for the viewer HTTP server (src/viewer/server.mjs, TRL0005). Servers run on
// 127.0.0.1 with port 0, watchers off, and the fixture dist; responses are matched against the
// variants in test/fixtures/viewer-api/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Server } from "node:http";
import { loadConfig } from "../src/backlog.mjs";
import { claim, seed } from "../src/ledger.mjs";
import { ViewerConfigError, normalizeHost } from "../src/viewer/config.mjs";
import { MAX_STREAM_BUFFER, cacheControlFor, hostAllowed, parseHost, printedHostFor, pushEvent, startViewer } from "../src/viewer/server.mjs";
import { ledgerTest } from "./git-support.mjs";
import { BASE_CFG, FISH_CFG, FIXTURE_DIST, TUNA_SVG, getJson, loadVariant, makeRepo, openEvents, request, shapeProblems, tmp } from "./viewer-support.mjs";

const posixOnly = process.platform === "win32" ? { skip: "needs POSIX FIFOs" } : {};

// Runs `fn(viewer, port)` against a server for `entries`, then stops it.
async function withViewer(entries, fn, options = {}) {
  const viewer = await startViewer({ entries, port: 0, distDir: FIXTURE_DIST, watch: false, ...options });
  try { return await fn(viewer, viewer.port); } finally { await viewer.close(); }
}
const entry = (repo, id = "demo", name = "Demo") => ({ id, name, path: repo.root });

function assertShape(response, file, variant) {
  assert.deepEqual(shapeProblems(response, loadVariant(file, variant)), [], `${file}.json variant ${variant}`);
}

// ------------------------------------------------------------ API shapes
test("GET /api/backlogs lists every backlog in config order and matches the fixture", async () => {
  const a = makeRepo({ items: [{ status: "active", id: "DEMO0001" }, { status: "completed", id: "DEMO0002" }] });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH", milestones: ["M1"] }, items: [{ status: "active", id: "OTH0001", fm: { milestone: "M1" } }] });
  const broken = makeRepo({ rawConfig: "null" });
  try {
    await withViewer([entry(b, "other", "Other"), entry(a), entry(broken, "broken", "Broken")], async (_v, port) => {
      const { status, json } = await getJson(port, "/api/backlogs");
      assert.equal(status, 200);
      assert.deepEqual(json.map((x) => [x.id, x.status]), [["other", "ok"], ["demo", "ok"], ["broken", "error"]]);
      assert.deepEqual(json[1].counts, { active: 1, completed: 1, removed: 0 });
      assert.deepEqual([json[0].path, json[0].mainWorktree, json[0].nextId], [b.root, b.root, "OTH0002"]);
      assert.deepEqual(json[2].counts, { active: 0, completed: 0, removed: 0 });
      assertShape(json, "backlogs", "ok-and-error");
      const own = await getJson(port, "/api/backlogs/other");
      assert.deepEqual([own.json.prefix, own.json.milestones], ["OTH", ["M1"]]);
      assert.equal((await getJson(port, "/api/backlogs/demo")).json.prefix, "DEMO");
      assertShape((await getJson(port, "/api/backlogs/broken")).json, "backlog", "error-backlog");
      assert.equal((await getJson(port, "/api/backlogs/nope")).status, 404);
    });
  } finally { a.cleanup(); b.cleanup(); broken.cleanup(); }
});

test("the backlog record matches its fixture variant for each scale and task shape", async () => {
  const fish = makeRepo({
    cfg: { ...FISH_CFG, tasksDir: "docs/tasks" },
    items: [{ status: "active", id: "DEMO0001", fm: { effort: 3 } }, { status: "active", id: "DEMO0002", fm: { effort: 5, milestone: "Beta", priority: "Low" } }],
  });
  const plain = makeRepo({ items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }] });
  const legacy = makeRepo({ cfg: { ...BASE_CFG, legacy: { through: "DEMO0001", closedBefore: "2026-06-01" } }, items: [{ status: "completed", id: "DEMO0001", fm: { summary: undefined, milestone: undefined, priority: undefined, effort: undefined } }] });
  const retired = makeRepo({ cfg: FISH_CFG, items: [{ status: "completed", id: "DEMO0004", fm: { effort: "Medium" } }] });
  const removed = makeRepo({ cfg: FISH_CFG, items: [{ status: "removed", id: "DEMO0008", fm: { effort: 1, priority: "Low" } }] });
  const numeric = makeRepo({ items: [{ status: "active", id: "DEMO0003", fm: { title: 404 } }] });
  const noTitle = makeRepo({ items: [{ status: "active", id: "DEMO0005", fm: { title: undefined, milestone: undefined } }] });
  const ledger = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  const cases = [
    [fish, "custom-scale-active"], [plain, "identity-scale"], [legacy, "legacy-completed-nulls"], [retired, "completed-retired-label"],
    [removed, "removed-task"], [numeric, "numeric-title"], [noTitle, "active-missing-title-and-milestone"], [ledger, "ledger-null-next-id"],
  ];
  try {
    for (const [repo, variant] of cases) {
      await withViewer([entry(repo)], async (_v, port) => {
        const { json } = await getJson(port, "/api/backlogs/demo");
        assertShape(json, "backlog", variant);
      });
    }
    await withViewer([entry(ledger)], async (_v, port) => {
      const { json } = await getJson(port, "/api/backlogs/demo");
      assert.equal(json.nextId, null);
      assert.equal(typeof json.nextIdReason, "string");
    });
  } finally { for (const [repo] of cases) repo.cleanup(); }
});

test("GET /api/backlogs/<id>/tasks/<ID> returns the record with front matter and bodyHtml", async () => {
  const repo = makeRepo({
    cfg: FISH_CFG,
    items: [
      { status: "active", id: "DEMO0003", body: "# Heading\n\nText.\n" },
      { status: "active", id: "DEMO0006", fm: { id: "DEMO0099" } },
    ],
  });
  try {
    await withViewer([entry(repo)], async (_v, port) => {
      const ok = await getJson(port, "/api/backlogs/demo/tasks/DEMO0003");
      assert.equal(ok.status, 200);
      assertShape(ok.json, "task", "active-with-body");
      assert.equal(ok.json.bodyHtml, "<h1>Heading</h1>\n<p>Text.</p>\n");
      const differs = await getJson(port, "/api/backlogs/demo/tasks/DEMO0006");
      assert.deepEqual([differs.json.id, differs.json.frontMatter.id], ["DEMO0006", "DEMO0099"]);
      assertShape(differs.json, "task", "authored-id-differs");
      for (const bad of ["DEMO0404", "demo0003", "DEMO03", "..", "%2e%2e"]) assert.equal((await getJson(port, `/api/backlogs/demo/tasks/${bad}`)).status, 404, bad);
      assert.equal((await getJson(port, "/api/backlogs/nope/tasks/DEMO0003")).status, 404);
    });
  } finally { repo.cleanup(); }
});

// ---------------------------------------------------------------- search
test("search ranks exact id, partial id, title, summary and body, one hit per task, over the named backlogs only", async () => {
  const a = makeRepo({
    items: [
      { status: "active", id: "DEMO0001", fm: { title: "Fix the widget", summary: "S." }, body: "first\nthe widget is broken\n" },
      { status: "active", id: "DEMO0002", fm: { title: "Other", summary: "About a widget" } },
      { status: "active", id: "DEMO0003", fm: { title: "Unrelated" }, body: "line one\nwidget here\n" },
      { status: "completed", id: "DEMO0010", fm: { title: "Id search" } },
      { status: "active", id: "DEMO0404", fm: { title: 404 } },
    ],
  });
  const b = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "OTH" }, items: [{ status: "active", id: "OTH0001", fm: { title: "Another widget" } }] });
  const broken = makeRepo({ rawConfig: "null" });
  try {
    a.write("trellis/active/DEMO0007.md", "---\nid: DEMO0007\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 3\ndepends_on: []\nsummary: S.\n---\n\nbody\n");
    await withViewer([entry(a, "a", "A"), entry(b, "b", "B"), entry(broken, "broken", "Broken")], async (_v, port) => {
      const s = async (query) => getJson(port, `/api/search?${query}`);
      const widget = (await s("q=widget&backlog=a&backlog=b")).json;
      assertShape(widget, "search", "hits-and-skipped");
      assert.deepEqual(widget.hits.map((h) => [h.backlog, h.id, h.field, h.line]), [
        ["a", "DEMO0001", "title", "Fix the widget"],
        ["b", "OTH0001", "title", "Another widget"],
        ["a", "DEMO0002", "summary", "About a widget"],
        ["a", "DEMO0003", "body", "widget here"],
      ]);
      assert.deepEqual((await s("q=widget&backlog=b")).json.hits.map((h) => h.id), ["OTH0001"]);
      assert.deepEqual((await s("q=demo0010&backlog=a")).json.hits, [{ backlog: "a", id: "DEMO0010", field: "id", line: "Id search" }]);
      assert.deepEqual((await s("q=404&backlog=a")).json.hits.map((h) => [h.id, h.field, h.line]), [["DEMO0404", "id", "404"]]);
      assert.deepEqual((await s("q=DEMO0007&backlog=a")).json.hits, [{ backlog: "a", id: "DEMO0007", field: "id", line: "" }]);
      const all = await s("q=widget");
      assert.deepEqual(all.json.skipped, ["broken"]);
      assert.equal(all.json.hits.length, 4);
      assertShape((await s("q=")).json, "search", "empty");
      assert.deepEqual((await s("q=%20%20&backlog=a")).json, { hits: [], skipped: [] });
      assert.equal((await s("q=x&backlog=nope")).status, 404);
      assert.equal((await s("q=&backlog=nope")).status, 404);
      assert.equal((await s("backlog=nope")).status, 404);
    });
  } finally { a.cleanup(); b.cleanup(); broken.cleanup(); }
});

// ------------------------------------------------------ host check and verbs
test("hostAllowed: loopback and printed hosts on the listener's port, allowed hosts on any port, port 80 may omit the port", () => {
  const opts = { port: 4747, printedHost: "127.0.0.2", allowedHosts: ["trellis.test"] };
  for (const h of ["127.0.0.1:4747", "localhost:4747", "LOCALHOST:4747", "127.0.0.2:4747", "trellis.test", "Trellis.Test:443", "trellis.test:4747"]) assert.ok(hostAllowed(h, opts), h);
  for (const h of ["evil.example", "127.0.0.1:80", "127.0.0.1", "localhost", "127.0.0.1:4748", "evil.trellis.test", "trellis.test.evil", "[::1]:4747", "", "a b"]) assert.ok(!hostAllowed(h, opts), h);
  assert.ok(!hostAllowed(undefined, opts));
  assert.ok(hostAllowed("[::1]:4747", { ...opts, printedHost: "[::1]" }));
});

test("hostAllowed: with no port in Host, a loopback or printed host passes only when the listener is on port 80", () => {
  const at80 = { port: 80, printedHost: "[::1]", allowedHosts: [] };
  for (const h of ["127.0.0.1", "localhost", "[::1]", "127.0.0.1:80"]) assert.ok(hostAllowed(h, at80), h);
  assert.ok(!hostAllowed("evil.example", at80));
  assert.ok(!hostAllowed("127.0.0.1", { ...at80, port: 4747 }));
  assert.deepEqual(parseHost("[::1]:80"), { host: "[::1]", port: 80 });
  assert.equal(parseHost("a/b"), null);
});

test("hostAllowed compares IPv6 literals by address, not spelling", () => {
  const opts = { port: 4747, printedHost: "[::ffff:127.0.0.1]", allowedHosts: [] };
  assert.ok(hostAllowed("[::ffff:7f00:1]:4747", opts));
  assert.ok(hostAllowed("[::FFFF:127.0.0.1]:4747", opts));
  assert.ok(hostAllowed("[0:0:0:0:0:0:0:1]:4747", { ...opts, printedHost: "[::1]" }));
  assert.ok(!hostAllowed("[::ffff:7f00:2]:4747", opts));
  assert.equal(printedHostFor("::ffff:127.0.0.1", "::ffff:127.0.0.1"), "[::ffff:7f00:1]");
  const compressed = { port: 4747, printedHost: "[::1]", allowedHosts: [normalizeHost("[0:0:0:0:0:0:0:2]")] };
  assert.ok(hostAllowed("[::2]:1", compressed), "an expanded allowedHosts entry matches the compressed Host");
});

test("printedHostFor follows the listener's address", () => {
  assert.deepEqual(
    [["127.0.0.1", "127.0.0.1"], ["0.0.0.0", "0.0.0.0"], ["::", "::"], ["::1", "::1"], ["localhost", "::1"], ["localhost", "127.0.0.1"], ["127.0.0.2", "127.0.0.2"]].map(([bind, addr]) => printedHostFor(bind, addr)),
    ["127.0.0.1", "127.0.0.1", "[::1]", "[::1]", "localhost", "localhost", "127.0.0.2"],
  );
});

test("a scoped IPv6 bind is refused with a config error before anything listens", async () => {
  const repo = makeRepo();
  try {
    await assert.rejects(startViewer({ entries: [entry(repo)], port: 0, bind: "fe80::1%lo0", distDir: FIXTURE_DIST, watch: false }), (e) => e instanceof ViewerConfigError && /scoped IPv6/.test(e.message));
  } finally { repo.cleanup(); }
});

test("a bind that resolves to a scoped address closes the listener it opened", async () => {
  const repo = makeRepo();
  const fakeAddress = Server.prototype.address;
  Server.prototype.address = function scoped() { const a = fakeAddress.call(this); return a && { ...a, address: "fe80::1%lo0" }; };
  let server;
  const fakeClose = Server.prototype.close;
  Server.prototype.close = function tracked(...args) { server = this; return fakeClose.apply(this, args); };
  try {
    await assert.rejects(startViewer({ entries: [entry(repo)], port: 0, distDir: FIXTURE_DIST, watch: false }), ViewerConfigError);
    assert.ok(server, "close was called");
    assert.equal(fakeAddress.call(server), null, "the listener is closed");
  } finally { Server.prototype.address = fakeAddress; Server.prototype.close = fakeClose; repo.cleanup(); }
});

test("an encoded backslash in a task id reaches the shell and detail routes but never a file route", posixOnly, async () => {
  // The scan pattern wraps the prefix unescaped, so `R.` matches a filename holding a literal backslash.
  const repo = makeRepo({ cfg: { ...BASE_CFG, idPrefix: "R." }, items: [{ status: "active", id: "R\\0001" }] });
  try {
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await getJson(port, "/api/backlogs/demo/tasks/R%5C0001")).json.id, "R\\0001");
      assert.equal((await request(port, { path: "/b/demo/task/R%5C0001" })).status, 200);
      for (const path of ["/assets/demo/a%5Cb", "/app/a%5Capp-test.js", "/assets/demo/a%2Fb", "/api/backlogs/demo/tasks/..", "/b/demo/task/%2E%2E"]) {
        assert.equal((await request(port, { path })).status, 404, path);
      }
    });
  } finally { repo.cleanup(); }
});

test("a wrong Host gets 403 before any other check; allowedHosts opens exactly that name; a write method gets 405", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    await withViewer([entry(repo)], async (_v, port) => {
      for (const path of ["/", "/api/backlogs", "/api/nope", "/app/app-test.js", "/events", "/assets/demo/x", "/missing"]) {
        assert.equal((await request(port, { path, host: "evil.example" })).status, 403, path);
      }
      assert.equal((await request(port, { method: "POST", path: "/api/backlogs", host: "evil.example" })).status, 403, "Host is checked before the verb");
      assert.equal((await request(port, { path: "/api/backlogs", host: "trellis.test" })).status, 403);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const path of ["/api/backlogs", "/", "/app/app-test.js", "/events", "/api/backlogs/demo/tasks/DEMO0001"]) {
          const r = await request(port, { method, path });
          assert.equal(r.status, 405, `${method} ${path}`);
          assert.equal(r.headers.allow, "GET, HEAD");
        }
      }
      assert.equal((await request(port, { method: "HEAD", path: "/api/backlogs" })).status, 200);
    });
    await withViewer([entry(repo)], async (_v, port) => {
      for (const host of ["trellis.test", "trellis.test:443", "TRELLIS.test:8080"]) assert.equal((await request(port, { path: "/api/backlogs", host })).status, 200, host);
      assert.equal((await request(port, { path: "/api/backlogs", host: "other.test" })).status, 403);
    }, { allowedHosts: ["trellis.test"] });
  } finally { repo.cleanup(); }
});

// --------------------------------------------------------------- bind and URL
async function tryStart(bind, entries) {
  try { return await startViewer({ entries, port: 0, bind, distDir: FIXTURE_DIST, watch: false }); } catch (e) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"].includes(e.code)) return null;
    throw e;
  }
}

test("the default listener is 127.0.0.1, and a 0.0.0.0 bind prints and serves 127.0.0.1", async () => {
  const repo = makeRepo();
  try {
    await withViewer([entry(repo)], async (v, port) => {
      assert.equal(v.server.address().address, "127.0.0.1");
      assert.equal(v.url, `http://127.0.0.1:${port}`);
    });
    const wide = await tryStart("0.0.0.0", [entry(repo)]);
    try {
      assert.equal(wide.url, `http://127.0.0.1:${wide.port}`);
      assert.equal((await request(wide.port, { path: "/api/backlogs" })).status, 200);
    } finally { await wide.close(); }
  } finally { repo.cleanup(); }
});

test("--bind ::1 prints http://[::1]:<port> and is served; 127.0.0.2 prints itself and is served", async (t) => {
  const repo = makeRepo();
  try {
    const v6 = await tryStart("::1", [entry(repo)]);
    if (!v6) t.diagnostic("IPv6 loopback unavailable here");
    else {
      try {
        assert.equal(v6.url, `http://[::1]:${v6.port}`);
        const r = await request(v6.port, { hostname: "::1", host: `[::1]:${v6.port}`, path: "/" });
        assert.equal(r.status, 200);
        assert.equal((await request(v6.port, { hostname: "::1", host: `evil.example:${v6.port}`, path: "/" })).status, 403);
      } finally { await v6.close(); }
    }
    const alias = await tryStart("127.0.0.2", [entry(repo)]);
    if (!alias) t.diagnostic("127.0.0.2 unavailable here");
    else {
      try {
        assert.equal(alias.url, `http://127.0.0.2:${alias.port}`);
        assert.equal((await request(alias.port, { hostname: "127.0.0.2", host: `127.0.0.2:${alias.port}`, path: "/" })).status, 200);
      } finally { await alias.close(); }
    }
    const named = await tryStart("localhost", [entry(repo)]);
    try {
      assert.equal(named.url, `http://localhost:${named.port}`);
      assert.equal((await request(named.port, { host: `localhost:${named.port}`, path: "/api/backlogs", hostname: named.server.address().address })).status, 200);
    } finally { await named.close(); }
  } finally { repo.cleanup(); }
});

// -------------------------------------------------------- shell and /app/
test("the app shell serves at / and the app's routes, and /app/ serves the built files", async () => {
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    await withViewer([entry(repo)], async (_v, port) => {
      const shell = readFileSync(join(FIXTURE_DIST, "index.html"), "utf8");
      for (const path of ["/", "/b/demo", "/b/anything/task/ANY0001"]) {
        const r = await request(port, { path });
        assert.equal(r.status, 200, path);
        assert.match(r.headers["content-type"], /^text\/html/);
        assert.equal(r.text, shell, "the shell has no task data in it");
      }
      for (const path of ["/b", "/b/demo/task", "/b/demo/task/DEMO0001/more", "/b/demo/other/DEMO0001", "/nope", "//evil.example"]) assert.equal((await request(port, { path })).status, 404, path);
      const js = await request(port, { path: "/app/app-test.js" });
      assert.deepEqual([js.status, js.headers["content-type"], js.text], [200, "text/javascript; charset=utf-8", readFileSync(join(FIXTURE_DIST, "app-test.js"), "utf8")]);
      const css = await request(port, { path: "/app/esp-reset.css" });
      assert.deepEqual([css.status, css.headers["content-type"]], [200, "text/css; charset=utf-8"]);
      assert.equal(css.headers["x-content-type-options"], "nosniff");
      for (const path of ["/app/missing.js", "/app", "/app/"]) assert.equal((await request(port, { path })).status, 404, path);
    });
  } finally { repo.cleanup(); }
});

test("/app/ serves only files the build manifest lists", async () => {
  const dist = tmp("dist");
  const repo = makeRepo({ items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const built = join(dist, "dist");
    cpSync(FIXTURE_DIST, built, { recursive: true });
    writeFileSync(join(built, "stray.js"), "stray");
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await request(port, { path: "/app/stray.js" })).status, 404, "a file the build did not list");
      assert.equal((await request(port, { path: "/app/files.json" })).status, 404, "the manifest itself");
      assert.equal((await request(port, { path: "/app/app-test.js" })).status, 200);
      assert.equal((await request(port, { path: "/" })).status, 200, "the shell does not need a listing");
    }, { distDir: built });
  } finally { repo.cleanup(); rmSync(dist, { recursive: true, force: true }); }
});

test("hashed built files cache for a year, others revalidate", () => {
  assert.equal(cacheControlFor("app-3f9a2c1d.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("esp-reset.css"), "no-cache");
  assert.equal(cacheControlFor("app-test.js"), "no-cache");
});

test("raw traversal paths are 404 even with a real file at the out-of-root location", async () => {
  const dist = tmp("dist");
  const repo = makeRepo({ cfg: { ...FISH_CFG, tasksDir: "docs/tasks" }, items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }], files: { "SPEC.md": "# spec\n", "package.json": "{}\n" } });
  try {
    const built = join(dist, "dist");
    cpSync(FIXTURE_DIST, built, { recursive: true });
    writeFileSync(join(dist, "package.json"), "{}\n");
    writeFileSync(join(dist, "secret.txt"), "secret");
    repo.write("docs/tasks/assets/effort/tuna.svg", TUNA_SVG);
    repo.write("docs/package.json", "{}\n");
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await request(port, { path: "/assets/demo/effort/tuna.svg" })).status, 200, "the image itself is served");
      const paths = [
        "/api/backlogs/demo/tasks/../SPEC.md", "/api/backlogs/demo/tasks/..%2fSPEC.md", "/api/backlogs/demo/tasks/%2e%2e/SPEC.md",
        "/assets/demo/../../package.json", "/assets/demo/effort/../../../../package.json", "/assets/demo/%2e%2e/%2e%2e/package.json", "/assets/demo/..%2f..%2fpackage.json",
        "/app/../package.json", "/app/%2e%2e/package.json", "/app/..%2fpackage.json", "/app/../secret.txt",
      ];
      for (const path of paths) assert.equal((await request(port, { path })).status, 404, path);
    }, { distDir: built });
  } finally { repo.cleanup(); rmSync(dist, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------- assets
test("effort images are served only when the scale names them, with a sandbox policy on SVG", async () => {
  const repo = makeRepo({ cfg: { ...FISH_CFG, tasksDir: "docs/tasks" }, items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }] });
  try {
    repo.write("docs/tasks/assets/effort/tuna.svg", TUNA_SVG);
    repo.write("docs/tasks/assets/effort/other.svg", TUNA_SVG);
    repo.write("docs/tasks/assets/notes.txt", "x");
    await withViewer([entry(repo)], async (_v, port) => {
      const { json } = await getJson(port, "/api/backlogs/demo");
      const url = json.tasks[0].effortDisplay.imageUrl;
      assert.equal(url, "/assets/demo/effort/tuna.svg");
      const img = await request(port, { path: url });
      assert.deepEqual([img.status, img.headers["content-type"], img.text], [200, "image/svg+xml", TUNA_SVG]);
      assert.equal(img.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      for (const path of ["/assets/demo/effort/other.svg", "/assets/demo/notes.txt", "/assets/demo/effort", "/assets/demo", "/assets/nope/effort/tuna.svg", "/assets/demo/effort/tuna.png"]) {
        assert.equal((await request(port, { path })).status, 404, path);
      }
    });
  } finally { repo.cleanup(); }
});

test("an asset symlink pointing outside the root, or a FIFO in place of an image, is 404", posixOnly, async () => {
  const repo = makeRepo({ cfg: FISH_CFG, items: [{ status: "active", id: "DEMO0001", fm: { effort: 5 } }] });
  try {
    const image = join(repo.root, "trellis", "assets", "effort", "tuna.svg");
    repo.write("trellis/assets/effort/tuna.svg", TUNA_SVG);
    writeFileSync(join(repo.dir, "outside.svg"), "<svg/>");
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await request(port, { path: "/assets/demo/effort/tuna.svg" })).status, 200);
      unlinkSync(image);
      symlinkSync(join(repo.dir, "outside.svg"), image);
      assert.equal((await request(port, { path: "/assets/demo/effort/tuna.svg" })).status, 404);
      unlinkSync(image);
      assert.equal(spawnSync("mkfifo", [image]).status, 0);
      assert.equal((await request(port, { path: "/assets/demo/effort/tuna.svg" })).status, 404);
    });
  } finally { repo.cleanup(); }
});

// ------------------------------------------------------------------------ SSE
test("/events streams the named backlog, stays up while a backlog is in error, and obeys the Host check", async () => {
  const good = makeRepo();
  const broken = makeRepo({ rawConfig: "null" });
  try {
    await withViewer([entry(good, "good", "Good"), entry(broken, "broken", "Broken")], async (v, port) => {
      const events = await openEvents(port);
      v.broadcast("broken");
      assert.deepEqual(await events.next("broken"), { backlog: "broken" });
      v.broadcast("good");
      assert.deepEqual(await events.next(), { backlog: "good" });
      events.close();
      assert.equal((await request(port, { path: "/events", host: "evil.example" })).status, 403);
    });
  } finally { good.cleanup(); broken.cleanup(); }
});

// --------------------------------------------------------------------- ledger
ledgerTest("a claim followed at once by the list and the record both report the advanced next id", async () => {
  const repo = makeRepo({ cfg: { ...BASE_CFG, idAllocation: "ledger" }, items: [{ status: "active", id: "DEMO0001" }] });
  try {
    const cfg = loadConfig(repo.root).cfg;
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await getJson(port, "/api/backlogs/demo")).json.nextId, null);
      seed(repo.root, cfg);
      assert.equal((await getJson(port, "/api/backlogs")).json[0].nextId, "DEMO0002");
      claim(repo.root, cfg, { title: "next" });
      assert.equal((await getJson(port, "/api/backlogs")).json[0].nextId, "DEMO0003");
      assert.equal((await getJson(port, "/api/backlogs/demo")).json.nextId, "DEMO0003");
    });
  } finally { repo.cleanup(); }
});

test("a task directory made after startup is read on the next request", async () => {
  const repo = makeRepo();
  try {
    await withViewer([entry(repo)], async (_v, port) => {
      assert.equal((await getJson(port, "/api/backlogs/demo")).json.tasks.length, 0);
      repo.add("active", "DEMO0001");
      mkdirSync(repo.folder("removed"), { recursive: true });
      assert.equal((await getJson(port, "/api/backlogs/demo")).json.tasks.length, 1);
    });
  } finally { repo.cleanup(); }
});

test("an event stream whose client stopped reading is closed instead of buffering without bound", () => {
  const sent = [];
  let destroyed = false;
  const res = { writableLength: 0, write: (f) => sent.push(f), destroy: () => { destroyed = true; } };
  assert.equal(pushEvent(res, "a"), true);
  res.writableLength = MAX_STREAM_BUFFER + 1;
  assert.equal(pushEvent(res, "b"), false);
  assert.deepEqual([sent, destroyed], [["a"], true]);
});
