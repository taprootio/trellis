// Behavior tests for the task-body Markdown renderer (src/markdown.mjs, TRL0005).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown.mjs";

const tasks = { "../active/TRL0012.md": "/b/trl/task/TRL0012" };
const resolveRepoPath = (target) => tasks[target] ?? null;
const render = (md) => renderMarkdown(md, { resolveRepoPath });

test("a <script> in a body renders inert", () => {
  const html = render("Hello <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n`<script>`\n\n```\n<script>x</script>\n```");
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("only http, https and mailto links are kept", () => {
  const html = render("[a](https://example.com/x) [b](HTTP://example.com) [c](mailto:me@example.com) [d](javascript:alert(1)) [e](data:text/html,x) [f](ftp://h/x)");
  assert.equal([...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]).join(" "), "https://example.com/x HTTP://example.com mailto:me@example.com");
  assert.match(html, /d \(javascript:alert\(1\)\)/);
});

test("network-path and disguised targets render no link", () => {
  for (const md of ["[x](javascript:alert(1))", "[x](//evil.example)", "[x](/\\evil.example)", "[x](\\\\evil.example)", "[x](<java\tscript:alert(1)>)", "[x](<java script:alert(1)>)"]) {
    assert.doesNotMatch(render(md), /<a /, md);
  }
});

test("a link to another task file of the same backlog goes to its task route, other repository paths stay text", () => {
  const html = render("See [the dependency](../active/TRL0012.md) and [readme](../README.md) and [other](../active/TRL0099.md).");
  assert.match(html, /<a href="\/b\/trl\/task\/TRL0012" data-task-link>the dependency<\/a>/);
  assert.match(html, /readme \(\.\.\/README\.md\)/);
  assert.equal(html.match(/<a /g).length, 1);
});

test("without a resolver every repository path is text", () => {
  assert.doesNotMatch(renderMarkdown("[x](../active/TRL0012.md)"), /<a /);
});

test("headings, lists, code, emphasis and tables render", () => {
  const html = render("# One\n\n## Two ##\n\nA **bold** and _em_ and `code` line.\nSecond line.\n\n- a\n- b\n  - nested\n\n3. three\n4. four\n\n```js\nconst a = 1 < 2;\n```\n\n| H1 | H2 |\n| --- | ---: |\n| a | b |\n");
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<h2>Two<\/h2>/);
  assert.match(html, /<strong>bold<\/strong> and <em>em<\/em> and <code>code<\/code> line\.\nSecond line\./);
  assert.match(html, /<ul>\n<li>a<\/li>\n<li>b\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>\n<\/ul>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2;\n<\/code><\/pre>/);
  assert.match(html, /<th align="right">H2<\/th>/);
  assert.match(html, /<td align="right">b<\/td>/);
});

test("markdown it does not cover stays text, and snake_case is not emphasis", () => {
  const html = render("> quote\n\n![alt](http://example.com/i.png)\n\nsnake_case_name and 2*3*4");
  assert.doesNotMatch(html, /<blockquote|<img|<a /);
  assert.match(html, /snake_case_name/);
});

test("an unterminated fence runs to the end and stays escaped", () => {
  assert.equal(render("```\n<b>x"), "<pre><code>&lt;b&gt;x\n</code></pre>\n");
});

test("a long malformed paragraph renders as escaped text in linear time", () => {
  const DEADLINE_MS = 10_000; // the shared test deadline; the unfixed renderer needs minutes at this size
  const inputs = ["[".repeat(200_000), "![".repeat(100_000), "[a](".repeat(15_000), "*a ".repeat(70_000), "_a ".repeat(70_000), "[a](<".repeat(12_000), `${"~".repeat(100_000)}\``, `${"`".repeat(100_000)} a\``];
  const started = Date.now();
  for (const md of inputs) {
    const html = render(md);
    assert.doesNotMatch(html, /<a |<em>|<strong>/);
  }
  assert.equal(render("~~~js title\nx\n~~~"), '<pre><code class="language-js">x\n</code></pre>\n');
  assert.ok(Date.now() - started < DEADLINE_MS, "rendering should finish within the deadline");
  assert.match(render("[ok](https://example.com) and [open"), /<a href="https:\/\/example.com">ok<\/a> and \[open/);
});

test("only links resolved from repository paths carry the task-link mark", () => {
  const html = renderMarkdown("[a](../active/A.md) [b](https://example.com/b/demo/task/X1) [c](missing.md)", { resolveRepoPath: (t) => (t.endsWith("A.md") ? "/b/demo/task/A" : null) });
  assert.match(html, /<a href="\/b\/demo\/task\/A" data-task-link>a<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/b\/demo\/task\/X1">b<\/a>/);
});
