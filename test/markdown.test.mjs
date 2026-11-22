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
  const inputs = ["[".repeat(200_000), "![".repeat(100_000), "[a](".repeat(15_000), "*a ".repeat(70_000), "_a ".repeat(70_000), "[a](<".repeat(12_000), `${"~".repeat(100_000)}\``, `${"`".repeat(100_000)} a\``, `|a|b\n|-${" ".repeat(100_000)}x`, `|a|b\n${" ".repeat(100_000)}|${" ".repeat(100_000)}-${" ".repeat(100_000)}!`, `#${" ".repeat(100_000)}a`, `# a${" ".repeat(100_000)}x#`, `# ${"#".repeat(100_000)}x`];
  const started = Date.now();
  for (const md of inputs) {
    const html = render(md);
    assert.doesNotMatch(html, /<a |<em>|<strong>/);
  }
  // Unmatched openers whose only closers are intraword, and a long blank run before a list continuation.
  for (const md of ["_a ".repeat(70_000) + "b_c", `- a${"\n".repeat(100_000)}  b`, `_a ${"x_y ".repeat(50_000)}`, `*a ${"`".repeat(100_000)} b`, `_a ${"`".repeat(100_000)} b`]) render(md);
  assert.equal(render("## Title ##  "), "<h2>Title</h2>\n");
  assert.equal(render("# C# #"), "<h1>C#</h1>\n");
  assert.equal(render("#hash"), "<p>#hash</p>\n");
  assert.equal(render("~~~js title\nx\n~~~"), '<pre><code class="language-js">x\n</code></pre>\n');
  assert.ok(Date.now() - started < DEADLINE_MS, "rendering should finish within the deadline");
  assert.match(render("[ok](https://example.com) and [open"), /<a href="https:\/\/example.com">ok<\/a> and \[open/);
});

test("a wide table header over many short rows renders only the cells present", () => {
  const head = `|${Array.from({ length: 2000 }, (_, n) => `h${n}`).join("|")}|`;
  const sep = `|${"-|".repeat(2000)}`;
  const html = render(`${head}\n${sep}\n${"|x|\n".repeat(2000)}`);
  assert.equal(html.match(/<td/g).length, 2000);
  assert.ok(html.length < 400_000, "output stays proportional to the input");
});

test("only links resolved from repository paths carry the task-link mark", () => {
  const html = renderMarkdown("[a](../active/A.md) [b](https://example.com/b/demo/task/X1) [c](missing.md)", { resolveRepoPath: (t) => (t.endsWith("A.md") ? "/b/demo/task/A" : null) });
  assert.match(html, /<a href="\/b\/demo\/task\/A" data-task-link>a<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/b\/demo\/task\/X1">b<\/a>/);
});

test("thousands of nested list markers on one line render without a stack overflow", () => {
  for (const marker of ["- ", "1. ", "* - "]) {
    const html = render(`${marker.repeat(5000)}deep`);
    assert.ok(html.includes("deep"));
    assert.ok(html.match(/<ul>|<ol>/g).length <= 33, "nesting stops at the cap");
  }
  assert.equal(render("- a\n  - b"), "<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ul>\n");
});

test("an intraword underscore is skipped as a closer, so the next valid closer is found", () => {
  assert.equal(render("_see snake_case here_"), "<p><em>see snake_case here</em></p>\n");
  assert.equal(render("__a snake__case b__"), "<p><strong>a snake__case b</strong></p>\n");
  assert.equal(render("_a b_c"), "<p>_a b_c</p>\n");
});

test("a long blank run inside a list item keeps the continuation in the item", () => {
  assert.equal(render("- a\n\n\n\n  b\n- c"), "<ul>\n<li><p>a</p>\n<p>b</p></li>\n<li>c</li>\n</ul>\n");
});
