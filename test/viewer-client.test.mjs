// Tests the viewer's pure modules against the server's fixture responses.
// There is no DOM here: app.mjs is thin wiring over what this file covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { effortView } from "../viewer/effort.mjs";
import {
  defaultFilters, parseQuery, serializeQuery, parseLocation, normalizeOwner,
  visibleRows, filterRows, buildRows, taskPath, listPath, bodyLinkPath, taskFields, carryFiltersInLinks, taskProblems, pickerEpoch,
} from "../viewer/filters.mjs";
import { createStore, connectEvents, backlogViews, attentionItems } from "../viewer/state.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/viewer-api/${name}.json`, import.meta.url), "utf8")).variants;
const backlogFx = fixture("backlog");
const searchFx = fixture("search");
const taskFx = fixture("task");
const listFx = fixture("backlogs");

const demo = backlogFx["custom-scale-active"].response;
const plain = backlogFx["identity-scale"].response;
const view = (b) => ({ ...b });

// A fetch double whose responses the test releases by hand.
function deferredFetch() {
  const calls = [];
  const fetchJson = (url) => new Promise((resolve) => { calls.push({ url, resolve }); });
  return { calls, fetchJson, urls: () => calls.map((c) => c.url) };
}

function makeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    fire: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("default sort is backlog order, then milestone order, then id", () => {
  const rows = [
    { ...demo, tasks: [
      { id: "DEMO0010", milestone: "Beta", status: "active" },
      { id: "DEMO0002", milestone: "Beta", status: "active" },
      { id: "DEMO0009", milestone: "Alpha", status: "active" },
      { id: "DEMO0001", milestone: "Unlisted", status: "active" },
    ] },
    { ...plain, tasks: [{ id: "PLN0001", milestone: "Alpha", status: "active" }] },
  ];
  const ids = visibleRows(rows.map(view), defaultFilters(), { status: "idle", hits: [] }).map((r) => r.task.id);
  assert.deepEqual(ids, ["DEMO0009", "DEMO0002", "DEMO0010", "DEMO0001", "PLN0001"]);
  // Config order wins over alphabetical order of the backlogs.
  const swapped = visibleRows([rows[1], rows[0]].map(view), defaultFilters(), { status: "idle", hits: [] }).map((r) => r.task.id);
  assert.equal(swapped[0], "PLN0001");
});

test("owner filter trims and case-folds, and deduplicates variants", () => {
  assert.equal(normalizeOwner("  Jereme "), "jereme");
  const b = { ...plain, tasks: [
    { id: "PLN0001", status: "active", owner: " Jereme " },
    { id: "PLN0002", status: "active", owner: "JEREME" },
    { id: "PLN0003", status: "active", owner: "sam" },
    { id: "PLN0004", status: "active", owner: null },
  ] };
  const rows = buildRows([b]);
  const got = filterRows(rows, { ...defaultFilters(), owner: "jEREME  " }).map((r) => r.task.id);
  assert.deepEqual(got, ["PLN0001", "PLN0002"]);
});

test("status defaults to active and other filters apply together", () => {
  const rows = buildRows([{ ...demo, tasks: [
    { id: "D1", status: "active", milestone: "Alpha", priority: "High" },
    { id: "D2", status: "completed", milestone: "Alpha", priority: "High" },
    { id: "D3", status: "active", milestone: "Beta", priority: "High" },
    { id: "D4", status: "active", milestone: "Alpha", priority: "Low" },
  ] }]);
  const ids = (f) => filterRows(rows, { ...defaultFilters(), ...f }).map((r) => r.task.id);
  assert.deepEqual(ids({}), ["D1", "D3", "D4"]);
  assert.deepEqual(ids({ statuses: ["completed"] }), ["D2"]);
  assert.deepEqual(ids({ milestones: ["demo:Alpha"], priority: "High" }), ["D1"]);
  assert.deepEqual(ids({ backlogs: ["other"] }), []);
});

test("query string round-trips every filter", () => {
  assert.equal(serializeQuery(defaultFilters()), "");
  const filters = {
    backlogs: ["demo", "plain"],
    statuses: ["active", "completed"],
    milestones: ["demo:Alpha", "plain:Beta release"],
    priority: "High",
    owner: "Jereme",
    q: "a & b",
  };
  assert.deepEqual(parseQuery(serializeQuery(filters)), filters);
  // No status selected differs from the default.
  const none = { ...defaultFilters(), statuses: [] };
  assert.deepEqual(parseQuery(serializeQuery(none)), none);
  assert.deepEqual(parseQuery("").statuses, ["active"]);
});

test("routes parse, and /b/<id> presets the backlog filter", () => {
  assert.deepEqual(parseLocation("/b/demo", "").filters.backlogs, ["demo"]);
  assert.deepEqual(parseLocation("/b/demo", "?backlog=plain").filters.backlogs, ["plain"]);
  const t = parseLocation("/b/demo/task/DEMO0001", "?status=completed");
  assert.equal(t.view, "task");
  assert.deepEqual(t.task, { backlog: "demo", id: "DEMO0001" });
  assert.deepEqual(t.filters.statuses, ["completed"]);
  assert.equal(parseLocation("/", "").view, "list");
  const back = taskPath("demo", "DEMO0001", t.filters);
  assert.deepEqual(parseLocation(...back.split(/(?=\?)/)).task, t.task);
  assert.equal(listPath(t.filters), "/?status=completed");
});

test("effort renders emoji, an image with the label as alt text, or text", () => {
  const [emoji, image] = demo.tasks.map((t) => effortView(t.effortDisplay));
  assert.equal(emoji.kind, "emoji");
  assert.equal(emoji.emoji, "🐡");
  assert.deepEqual(image, { kind: "image", src: "/assets/demo/effort/tuna.svg", alt: "Tuna", text: "Tuna · 5" });
  assert.deepEqual(effortView(plain.tasks[0].effortDisplay), { kind: "text", text: plain.tasks[0].effortDisplay.text });
  const empty = backlogFx["completed-retired-label"].response.tasks[0].effortDisplay;
  assert.equal(effortView(empty).kind, "none");
  assert.equal(effortView(null).kind, "none");
  // A foreign image URL is never drawn.
  assert.equal(effortView({ label: "X", text: "X · 1", emoji: null, imageUrl: "https://evil.example/x.png" }).kind, "text");
});

test("error backlogs and diagnostics surface from the fixtures", () => {
  const entries = listFx["ok-and-error"].response;
  const state = { backlogs: entries, details: { demo, broken: backlogFx["error-backlog"].response } };
  const views = backlogViews(state);
  assert.equal(views[1].status, "error");
  assert.ok(views[1].errors.length > 0);
  const flagged = backlogFx["active-missing-title-and-milestone"].response;
  const { diagnostics, flagged: tasks } = attentionItems(flagged);
  // Diagnostics and flagged tasks are counted apart: a task with several errors counts once.
  assert.equal(tasks.length, flagged.tasks.filter((t) => t.needsAttention).length);
  assert.ok(tasks.every((t) => Array.isArray(t.errors)));
  assert.equal(diagnostics.length, (flagged.diagnostics ?? []).length);
  assert.equal(attentionItems({ diagnostics: [{ path: "active/X.md", message: "bad" }], tasks: [] }).flagged.length, 0);
});

test("search hits replace the sort and add the matching line", () => {
  const hits = searchFx["hits-and-skipped"].response.hits;
  const views = [view({ ...demo, tasks: [
    { id: "DEMO0001", status: "active", milestone: "Alpha" },
    { id: "DEMO0002", status: "active", milestone: "Beta" },
    { id: "DEMO0003", status: "active", milestone: "Alpha" },
  ] }), view({ ...plain, tasks: [{ id: "PLN0001", status: "active", milestone: "Alpha" }] })];
  const filters = { ...defaultFilters(), q: "x" };
  const rows = visibleRows(views, filters, { status: "ready", hits });
  assert.deepEqual(rows.map((r) => r.task.id), ["DEMO0003", "DEMO0001", "DEMO0002", "PLN0001"]);
  assert.equal(rows[3].hit.line, "The first line that matches");
  assert.deepEqual(visibleRows(views, filters, { status: "pending", hits: [] }), []);
});

test("a search response that lands after the query changed, before the debounce, never reaches the list", async () => {
  const net = deferredFetch();
  const clock = makeTimers();
  const store = createStore({ fetchJson: net.fetchJson, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.applyUrl("/", "?q=ab");
  assert.equal(clock.timers[0].ms, 250);
  clock.fire(); // first search request goes out
  assert.equal(net.calls.length, 1);
  assert.match(net.calls[0].url, /^\/api\/search\?q=ab/);

  store.setFilters({ ...store.state.filters, q: "abc" }); // invalidates the pending one at once
  assert.equal(store.state.search.status, "pending");
  net.calls[0].resolve({ status: 200, body: searchFx["hits-and-skipped"].response });
  await tick();
  assert.deepEqual(store.state.search.hits, []);
  assert.equal(store.state.search.status, "pending");

  clock.fire();
  net.calls[1].resolve({ status: 200, body: searchFx.empty.response });
  await tick();
  assert.equal(store.state.search.status, "ready");
  assert.deepEqual(store.state.search.hits, []);
});

test("search names the selected backlogs", async () => {
  const net = deferredFetch();
  const clock = makeTimers();
  const store = createStore({ fetchJson: net.fetchJson, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.applyUrl("/", "?q=x&backlog=demo&backlog=plain");
  clock.fire();
  assert.equal(net.calls[0].url, "/api/search?q=x&backlog=demo&backlog=plain");
});

class FakeEventSource {
  constructor(url) { this.url = url; FakeEventSource.last = this; }
  close() {}
}

test("every SSE open, first and reconnect, refetches what is shown", async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url === "/api/backlogs") return { status: 200, body: [{ id: "demo", name: "Demo" }] };
    if (url.startsWith("/api/backlogs/demo/tasks/")) return { status: 200, body: taskFx["active-with-body"].response };
    if (url.startsWith("/api/search")) return { status: 200, body: searchFx.empty.response };
    return { status: 200, body: demo };
  };
  const clock = makeTimers();
  const store = createStore({ fetchJson, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.applyUrl("/b/demo/task/DEMO0003", "?q=zz");
  await tick();
  urls.length = 0;

  const source = connectEvents(store, FakeEventSource);
  assert.equal(FakeEventSource.last, source);
  source.onopen();
  await tick();
  assert.deepEqual(urls.sort(), [
    "/api/backlogs", "/api/backlogs/demo", "/api/backlogs/demo/tasks/DEMO0003", "/api/search?q=zz",
  ].sort());

  urls.length = 0;
  source.onopen(); // reconnect
  await tick();
  assert.equal(urls.length, 4);

  urls.length = 0;
  source.onmessage({ data: JSON.stringify({ backlog: "demo" }) });
  await tick();
  assert.deepEqual(urls.sort(), ["/api/backlogs/demo", "/api/backlogs/demo/tasks/DEMO0003", "/api/search?q=zz"].sort());

  urls.length = 0;
  source.onmessage({ data: ": keep-alive" });
  await tick();
  assert.deepEqual(urls, []);
});

test("an open task that 404s drops its body, and an older response is discarded", async () => {
  const net = deferredFetch();
  const store = createStore({ fetchJson: net.fetchJson, setTimer: makeTimers().setTimer });
  store.applyUrl("/b/demo/task/DEMO0003", "");
  assert.equal(store.state.task.status, "loading");
  const first = net.calls[0];
  store.onEvent({ backlog: "demo" }); // a later refetch
  const taskCall = net.calls.filter((c) => c.url.endsWith("/tasks/DEMO0003"))[1];
  assert.ok(taskCall);

  taskCall.resolve({ status: 404, body: null });
  await tick();
  assert.equal(store.state.task.status, "gone");
  assert.equal(store.state.task.record, null);

  first.resolve({ status: 200, body: taskFx["active-with-body"].response }); // older, stale
  await tick();
  assert.equal(store.state.task.status, "gone");
  assert.equal(store.state.task.record, null);
});

test("leaving the task view invalidates its pending response", async () => {
  const net = deferredFetch();
  const store = createStore({ fetchJson: net.fetchJson, setTimer: makeTimers().setTimer });
  store.applyUrl("/b/demo/task/DEMO0003", "");
  store.applyUrl("/", "");
  net.calls[0].resolve({ status: 200, body: taskFx["active-with-body"].response });
  await tick();
  assert.equal(store.state.task, null);
});

test("a task link in a body keeps the current filters, and only task links are taken in-app", () => {
  const filters = { ...defaultFilters(), statuses: ["completed"], q: "x y" };
  const path = bodyLinkPath("/b/demo/task/DEMO0002", filters);
  assert.equal(path, "/b/demo/task/DEMO0002?status=completed&q=x+y");
  assert.deepEqual(parseLocation(...path.split(/(?=\?)/)).filters, filters);
  assert.equal(bodyLinkPath("/b/demo", filters), null);
  assert.equal(bodyLinkPath("/assets/demo/a.png", filters), null);
  assert.equal(bodyLinkPath("/b/demo/task/DEMO0002/extra", filters), null);
});

test("task links in a body get the current filters in their href, again when the filters change; other links are untouched", () => {
  const anchor = (href, marked = true) => {
    const u = new URL(href, "http://127.0.0.1:4747");
    return { origin: u.origin, pathname: u.pathname, href, marked, hasAttribute() { return this.marked; }, setAttribute(_n, v) { this.href = v; } };
  };
  const links = [anchor("/b/demo/task/DEMO0002"), anchor("https://example.com/b/demo/task/DEMO0002"), anchor("/assets/demo/a.png")];
  const authored = anchor("http://127.0.0.1:4747/b/demo/task/DEMO0002?x=1#top", false);
  carryFiltersInLinks([authored], "http://127.0.0.1:4747", { ...defaultFilters(), q: "x" });
  assert.equal(authored.href, "http://127.0.0.1:4747/b/demo/task/DEMO0002?x=1#top", "an authored same-origin link is left alone");
  carryFiltersInLinks(links, "http://127.0.0.1:4747", { ...defaultFilters(), q: "x" });
  assert.deepEqual(links.map((l) => l.href), ["/b/demo/task/DEMO0002?q=x", "https://example.com/b/demo/task/DEMO0002", "/assets/demo/a.png"]);
  carryFiltersInLinks(links, "http://127.0.0.1:4747", { ...defaultFilters(), statuses: ["completed"] });
  assert.equal(links[0].href, "/b/demo/task/DEMO0002?status=completed");
});

test("the task view's problems are the record's validation errors as text", () => {
  assert.deepEqual(taskProblems({ validationErrors: ["milestone must be one of: Alpha", ""] }), ["milestone must be one of: Alpha"]);
  assert.deepEqual(taskProblems({ validationErrors: [] }), []);
  assert.deepEqual(taskProblems({}), []);
});

test("the task view lists the standard text fields, hiding empty ones and the authored id", () => {
  const closed = {
    id: "DEMO0009", status: "removed", milestone: "Alpha", priority: "High", owner: null, collaborators: ["ann", "bo"], summary: "Why.",
    completed_on: "2026-01-01", removed_on: "2026-02-01", removed_reason: "Superseded.", effort: 3,
  };
  assert.deepEqual(taskFields(closed, "demo").map(([k]) => k), [
    "Backlog", "Status", "Milestone", "Priority", "Collaborators", "Summary", "Completed on", "Removed on", "Removed reason",
  ]);
  assert.equal(taskFields(closed, "demo").find(([k]) => k === "Collaborators")[1], "ann, bo");
  assert.deepEqual(taskFields({ id: "A", status: "active", collaborators: [] }, "demo"), [["Backlog", "demo"], ["Status", "active"]]);
});

test("the picker key moves only when navigation changes the filters", () => {
  const a = parseQuery("?backlog=demo&status=completed");
  const b = parseQuery("?milestone=demo:Alpha");
  assert.equal(pickerEpoch(3, a, parseQuery("?backlog=demo&status=completed")), 3, "same filters keep the pickers");
  assert.equal(pickerEpoch(3, a, b), 4, "Back to other filters rebuilds them");
  assert.equal(pickerEpoch(0, a, defaultFilters()), 1);
});
