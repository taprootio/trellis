// A small Markdown renderer for task bodies (TRL0005).
//
// It covers headings, paragraphs, lists, code spans and blocks, links, emphasis and
// pipe tables. Everything else is shown as text. All text is HTML-escaped, so a body
// can never put markup on the page; the only tags are the ones built here.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// A target with a scheme is kept only for these. Anything else renders as text.
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const PUNCT_RE = /[!-/:-@[-`{-~]/;

// Decide what a link target becomes: { href, repo } for a link (`repo` when the viewer
// resolved a repository path), or null for plain text.
// `resolveRepoPath(target)` maps a scheme-less repository path to an href (or null).
function linkHref(target, resolveRepoPath) {
  // Whitespace and control characters can hide a scheme from a reader but not from a browser.
  if (!target || /[\x00-\x20\x7f]/.test(target)) return null;
  const scheme = SCHEME_RE.exec(target);
  if (scheme) {
    if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
    return { href: target, repo: false };
  }
  // `//host` and `/\host` are network paths, not repository paths.
  if (/^[/\\]{2}/.test(target)) return null;
  if (target.startsWith("#")) return null;
  const href = typeof resolveRepoPath === "function" ? resolveRepoPath(target) : null;
  return href ? { href, repo: true } : null;
}

// Length of the backtick run starting at `i`.
function tickRun(text, i) {
  let n = 1;
  while (text[i + n] === "`") n++;
  return n;
}

// Backtick runs of `text`, indexed by length, in one pass. The returned lookup(from, len) gives
// the start of the first run of exactly `len` backticks at or after `from`, or -1. A code span
// closes only on a run of its opener's length, never on part of a longer run, and the one
// index serves inline rendering, bracket pairing and emphasis scanning in O(log n) a call.
function tickIndex(text) {
  const byLen = new Map();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`") continue;
    const n = tickRun(text, i);
    if (!byLen.has(n)) byLen.set(n, []);
    byLen.get(n).push(i);
    i += n - 1;
  }
  return (from, len) => {
    const starts = byLen.get(len);
    if (!starts) return -1;
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < from) lo = mid + 1; else hi = mid;
    }
    return lo < starts.length ? starts[lo] : -1;
  };
}

// Pairs every `[` with its `]` in one pass (skipping escapes and code spans), so a long
// paragraph of unmatched brackets stays linear instead of rescanning to the end for each one.
// Returns Map(open index -> close index); an unmatched `[` has no entry.
function bracketPairs(text, closerOf) {
  const pairs = new Map();
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      const run = tickRun(text, i);
      const end = closerOf(i + run, run);
      i = end !== -1 ? end + run - 1 : i + run - 1;
      continue;
    }
    if (c === "[") open.push(i);
    else if (c === "]" && open.length) pairs.set(open.pop(), i);
  }
  return pairs;
}

// The longest link destination read; a longer or unclosed one renders as plain text, so a
// run of `[a](` cannot make every link rescan the rest of the paragraph.
const MAX_DESTINATION = 2000;

// Reads `(destination "optional title")` at `start` (the `(`). Returns { target, end } or null.
function linkDestination(text, start) {
  let i = start + 1;
  while (text[i] === " ") i++;
  let target;
  if (text[i] === "<") {
    const close = text.slice(0, i + MAX_DESTINATION).indexOf(">", i);
    if (close === -1 || text.slice(i, close).includes("\n")) return null;
    target = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const from = i;
    for (; i < text.length && i - from <= MAX_DESTINATION; i++) {
      const c = text[i];
      if (c === "\\") { i++; continue; }
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      else if (c === " " || c === "\n") break;
    }
    target = text.slice(from, i).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (text[i] === " ") i++;
  if (text[i] === '"' || text[i] === "'") {
    const q = text[i];
    const close = text.indexOf(q, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (text[i] === " ") i++;
  }
  return text[i] === ")" ? { target, end: i + 1 } : null;
}

// Closing delimiter search for emphasis: the run must not follow whitespace, and an `_` run
// inside a word (`snake_case`) is not a closer, so the search goes on to the next one.
function findClose(text, from, delim, closerOf) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      const run = tickRun(text, i);
      const end = closerOf(i + run, run);
      // No closer for this run: skip the whole run, or each backtick would rescan the text.
      i = end !== -1 ? end + run - 1 : i + run - 1;
      continue;
    }
    if (text.startsWith(delim, i) && i > from && !/\s/.test(text[i - 1])) {
      // `*` must not be the start of a longer run when closing a single one.
      if (delim.length === 1 && text[i + 1] === delim) continue;
      if (delim[0] === "_" && /[A-Za-z0-9]/.test(text[i + delim.length] || "")) continue;
      return i;
    }
  }
  return -1;
}

function inline(text, ctx, allowLinks = true) {
  let out = "";
  let i = 0;
  const closerOf = tickIndex(text);
  let pairs = null; // built on the first `[`
  const closeOf = (open) => (pairs ??= bracketPairs(text, closerOf)).get(open) ?? -1;
  // A delimiter with no closer from here has none from any later start either.
  const noCloseFrom = new Map();
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && PUNCT_RE.test(text[i + 1])) { out += escapeHtml(text[i + 1]); i += 2; continue; }
    if (c === "`") {
      const n = tickRun(text, i);
      const run = "`".repeat(n);
      const end = closerOf(i + n, n);
      if (end !== -1) {
        let code = text.slice(i + run.length, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code)}</code>`;
        i = end + run.length;
        continue;
      }
      out += run; i += run.length; continue;
    }
    // An image is not covered, so it stays text (its brackets must not become a link).
    if (c === "!" && text[i + 1] === "[") {
      const close = closeOf(i + 1);
      const dest = close !== -1 && text[close + 1] === "(" ? linkDestination(text, close + 1) : null;
      if (dest) { out += escapeHtml(text.slice(i, dest.end)); i = dest.end; continue; }
    }
    if (c === "[" && allowLinks) {
      const close = closeOf(i);
      if (close !== -1 && text[close + 1] === "(") {
        const dest = linkDestination(text, close + 1);
        if (dest) {
          const label = text.slice(i + 1, close);
          const link = linkHref(dest.target, ctx.resolveRepoPath);
          // The mark tells the client which links the server built from repository paths.
          if (link) out += `<a href="${escapeHtml(link.href)}"${link.repo ? " data-task-link" : ""}>${inline(label, ctx, false)}</a>`;
          else {
            const shown = inline(label, ctx, false);
            out += label === dest.target ? shown : `${shown} (${escapeHtml(dest.target)})`;
          }
          i = dest.end;
          continue;
        }
      }
    }
    if (c === "*" || c === "_") {
      const delim = text.startsWith(c + c, i) ? c + c : c;
      const intraword = c === "_" && i > 0 && /[A-Za-z0-9]/.test(text[i - 1]);
      const next = text[i + delim.length];
      if (!intraword && next !== undefined && !/\s/.test(next)) {
        const from = i + delim.length;
        const close = from >= (noCloseFrom.get(delim) ?? Infinity) ? -1 : findClose(text, from, delim, closerOf);
        if (close === -1 && !noCloseFrom.has(delim)) noCloseFrom.set(delim, from);
        if (close !== -1) {
          const tag = delim.length === 2 ? "strong" : "em";
          out += `<${tag}>${inline(text.slice(i + delim.length, close), ctx, allowLinks)}</${tag}>`;
          i = close + delim.length;
          continue;
        }
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ----------------------------------------------------------------- blocks
// The marker and the info string are matched apart: one regex with both overlapping
// quantifiers backtracked quadratically on a long run of tildes ending in a backtick.
const FENCE_MARKER_RE = /^ {0,3}(`{3,}|~{3,})/;
function parseFence(line) {
  const m = FENCE_MARKER_RE.exec(line);
  if (!m) return null;
  const info = line.slice(m[0].length);
  if (info.includes("`")) return null;
  return { marker: m[1], lang: info.trim().split(/\s/, 1)[0] };
}
// The marker, the text and the optional closing hashes are taken in separate linear steps:
// one regex with lazy text and an optional trailer backtracked quadratically on long spaces.
const HEADING_MARKER_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
function parseHeading(line) {
  const m = HEADING_MARKER_RE.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--; // a loop: `#+$` rescans a long run of hashes
  const closing = text.length - end;
  // Closing hashes count only when a space or tab precedes them (or they are the whole text).
  if (closing && (closing === text.length || /[ \t]/.test(text[text.length - closing - 1]))) text = text.slice(0, text.length - closing).trim();
  return { level: m[1].length, text };
}
const MAX_LIST_DEPTH = 32;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/;
const SEP_CELL_RE = /^:?-+:?$/;
// Split and trim first, so a long run of whitespace cannot make a regex backtrack.
const isTableSep = (line) => splitRow(line).every((c) => SEP_CELL_RE.test(c));

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; } else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const startsTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && isTableSep(lines[i + 1])
  && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

// Whether a line begins a block that may interrupt a paragraph.
function interrupts(lines, i) {
  const line = lines[i];
  if (parseFence(line) || parseHeading(line)) return true;
  const m = LIST_RE.exec(line);
  if (m && (/^[-*+]$/.test(m[2]) || m[2] === "1." || m[2] === "1)")) return true;
  return startsTable(lines, i);
}

function renderTable(lines, i, ctx) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cell = (tag, text, n) => `<${tag}${aligns[n] ? ` align="${aligns[n]}"` : ""}>${inline(text, ctx)}</${tag}>`;
  let html = `<table>\n<thead>\n<tr>${head.map((t, n) => cell("th", t, n)).join("")}</tr>\n</thead>\n`;
  let j = i + 2;
  const rows = [];
  for (; j < lines.length && lines[j].trim() && lines[j].includes("|"); j++) {
    const cells = splitRow(lines[j]);
    // Only the cells present, up to the header width: padding short rows would cost
    // header-width work per row for input that is not there.
    rows.push(`<tr>${cells.slice(0, head.length).map((t, n) => cell("td", t, n)).join("")}</tr>`);
  }
  if (rows.length) html += `<tbody>\n${rows.join("\n")}\n</tbody>\n`;
  return { html: `${html}</table>\n`, next: j };
}

// Parses a list starting at `i`. An item's lines are everything indented past its marker
// (nested blocks), plus lazy continuation lines of its first paragraph.
function renderList(lines, i, ctx) {
  const inner = { ...ctx, listDepth: (ctx.listDepth ?? 0) + 1 };
  const first = LIST_RE.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let j = i;
  while (j < lines.length) {
    const m = LIST_RE.exec(lines[j]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const itemLines = [m[3]];
    j++;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        // Scan the whole blank run once: rescanning from each blank line is quadratic.
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && lines[k].search(/\S/) > baseIndent) {
          for (; j < k; j++) itemLines.push("");
          j = k - 1; // the loop's j++ lands on the continuation line
          continue;
        }
        break;
      }
      const indent = line.search(/\S/);
      if (indent > baseIndent) { itemLines.push(line.slice(Math.min(indent, baseIndent + 2))); continue; }
      if (LIST_RE.test(line) || interrupts(lines, j)) break;
      if (itemLines[itemLines.length - 1] === "") break;
      itemLines.push(line.trim());
    }
    let body = renderBlocks(itemLines, inner).trimEnd();
    // A tight item (no blank line inside) shows its first paragraph without <p>.
    if (!itemLines.includes("")) body = body.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    items.push(`<li>${body}</li>`);
    while (j < lines.length && !lines[j].trim() && j + 1 < lines.length && LIST_RE.test(lines[j + 1]) && LIST_RE.exec(lines[j + 1])[1].length === baseIndent) j++;
  }
  const tag = ordered ? "ol" : "ul";
  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : "";
  return { html: `<${tag}${start}>\n${items.join("\n")}\n</${tag}>\n`, next: j };
}

function renderBlocks(lines, ctx) {
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = parseFence(line);
    if (fence) {
      const { marker, lang } = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = /^[\w+#.-]+$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : "";
      html += `<pre><code${cls}>${escapeHtml(body.join("\n"))}${body.length ? "\n" : ""}</code></pre>\n`;
      continue;
    }
    const heading = parseHeading(line);
    if (heading) {
      html += `<h${heading.level}>${inline(heading.text, ctx)}</h${heading.level}>\n`;
      i++;
      continue;
    }
    if (startsTable(lines, i)) {
      const t = renderTable(lines, i, ctx);
      html += t.html; i = t.next;
      continue;
    }
    // Past the cap a marker is plain text, so a line of thousands of `- ` cannot overflow the stack.
    if (LIST_RE.test(line) && (ctx.listDepth ?? 0) < MAX_LIST_DEPTH) {
      const l = renderList(lines, i, ctx);
      html += l.html; i = l.next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !interrupts(lines, i)) para.push(lines[i++].trim());
    html += `<p>${inline(para.join("\n"), ctx)}</p>\n`;
  }
  return html;
}

// Renders Markdown to HTML. `resolveRepoPath(target)` turns a scheme-less repository path
// (such as `../active/TRL0012.md`) into an href, or returns null to leave it as text.
export function renderMarkdown(text, { resolveRepoPath } = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return renderBlocks(lines, { resolveRepoPath });
}
