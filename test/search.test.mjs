// Behavior tests for the search ranking (src/search.mjs, TRL0005).

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchItems } from "../src/search.mjs";

const item = (backlog, order, id, fields = {}) => ({ backlog, order, id, title: "", summary: "", body: "", ...fields });

test("an exact id ranks first, then a partial id, then title, summary and body", () => {
  const items = [
    item("a", 0, "TR0001", { body: "mentions TR0003 here" }),
    item("a", 0, "TR0002", { summary: "about TR0003" }),
    item("a", 0, "TR0004", { title: "Fixes TR0003 again" }),
    item("a", 0, "XTR0003Y", { title: "partial" }),
    item("a", 0, "TR0003", { title: "Exact" }),
  ];
  assert.deepEqual(searchItems(items, "tr0003").map((h) => [h.id, h.field]), [
    ["TR0003", "id"], ["XTR0003Y", "id"], ["TR0004", "title"], ["TR0002", "summary"], ["TR0001", "body"],
  ]);
});

test("each task yields one hit for its best field, and the line is the title or the matching line", () => {
  const items = [
    item("a", 0, "TR0001", { title: "Fix the widget", body: "first\nthe widget breaks here\nthird" }),
    item("a", 0, "TR0002", { title: "Other", body: "a\nb widget c\n" }),
  ];
  const hits = searchItems(items, "Widget");
  assert.deepEqual(hits, [
    { backlog: "a", id: "TR0001", field: "title", line: "Fix the widget" },
    { backlog: "a", id: "TR0002", field: "body", line: "b widget c" },
  ]);
  assert.equal(searchItems(items, "TR0001")[0].line, "Fix the widget");
});

test("a numeric title is matched as text, and a task with no title gives an id hit with an empty line", () => {
  const items = [item("a", 0, "TR0007", { title: 404 }), item("a", 0, "TR0008", { title: undefined, summary: undefined })];
  assert.deepEqual(searchItems(items, "404"), [{ backlog: "a", id: "TR0007", field: "title", line: "404" }]);
  assert.deepEqual(searchItems(items, "TR0008"), [{ backlog: "a", id: "TR0008", field: "id", line: "" }]);
});

test("ties keep backlog config order, then id; an empty query has no hits", () => {
  const items = [item("b", 1, "B0001", { title: "same" }), item("a", 0, "A0002", { title: "same" }), item("a", 0, "A0001", { title: "same" })];
  assert.deepEqual(searchItems(items, " same ").map((h) => h.id), ["A0001", "A0002", "B0001"]);
  assert.deepEqual(searchItems(items, "   "), []);
  assert.deepEqual(searchItems(items, undefined), []);
});

test("a query with a newline matches across lines and reports the line it starts on", () => {
  const items = [item("a", 0, "TR0001", { body: "one\ntwo\nthree\nfour" })];
  assert.deepEqual(searchItems(items, "two\nthree"), [{ backlog: "a", id: "TR0001", field: "body", line: "two" }]);
});
