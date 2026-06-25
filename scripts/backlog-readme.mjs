#!/usr/bin/env node
// Trellis backlog generator (bootstrap, dependency-free).
//
// Validates docs/tasks/active/*.md front-matter against backlog.config.json,
// regenerates the milestone tables + "Next task ID" block in
// docs/tasks/README.md, and writes docs/tasks/backlog.json.
//
//   node scripts/backlog-readme.mjs          # validate + rewrite README + backlog.json
//   node scripts/backlog-readme.mjs --check  # validate + fail if either is stale
//
// Front-matter is a small fixed YAML subset (scalar `key: value`, plus
// `depends_on` as inline [A, B] or a block list). The production Trellis CLI
// will use a full YAML parser; this bootstrap stays zero-dependency on purpose.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(repoRoot, "backlog.config.json"), "utf8"));

const tasksDir = join(repoRoot, "docs", "tasks");
const activeDir = join(tasksDir, "active");
const completedDir = join(tasksDir, "completed", "tasks");
const removedDir = join(tasksDir, "removed");
const readmePath = join(tasksDir, "README.md");
const backlogJsonPath = join(tasksDir, "backlog.json");
const completedIndexPath = join(tasksDir, "completed", "index.md");
const removedIndexPath = join(tasksDir, "removed", "index.md");

const MILESTONES = cfg.milestones;
const PRIORITIES = cfg.priorities;
const EFFORT = new Set(cfg.effort);
const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));
const FILE_RE = new RegExp(`^(${cfg.idPrefix}\\d{${cfg.idWidth}})\\.md$`);
const ID_RE = new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);

const BEGIN = "<!-- BEGIN GENERATED:MILESTONES -->";
const END = "<!-- END GENERATED:MILESTONES -->";
const C_BEGIN = "<!-- BEGIN GENERATED:COMPLETED -->";
const C_END = "<!-- END GENERATED:COMPLETED -->";
const R_BEGIN = "<!-- BEGIN GENERATED:REMOVED -->";
const R_END = "<!-- END GENERATED:REMOVED -->";

const errors = [];
const isCheck = process.argv.includes("--check");

function parseFrontMatter(text, where) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) { errors.push(`${where}: missing YAML front-matter`); return null; }
  const fm = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (key === "depends_on") {
      if (val.startsWith("[")) {
        fm.depends_on = val.replace(/^\[|\]$/g, "").split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else if (val === "") {
        const deps = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          deps.push(lines[++i].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        }
        fm.depends_on = deps;
      } else {
        fm.depends_on = [val.replace(/^["']|["']$/g, "")];
      }
      continue;
    }
    val = val.replace(/^["']|["']$/g, "");
    if (/^-?\d+$/.test(val)) val = Number(val);
    fm[key] = val;
  }
  return fm;
}

function idsFromDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.match(FILE_RE)).filter(Boolean).map((m) => m[1]);
}

function knownIds() {
  const byId = new Map();
  for (const [label, dir] of [["active", activeDir], ["completed/tasks", completedDir], ["removed", removedDir]]) {
    for (const id of idsFromDir(dir)) {
      const arr = byId.get(id) || [];
      arr.push(label);
      byId.set(id, arr);
    }
  }
  for (const [id, labels] of byId) {
    if (labels.length > 1) errors.push(`${id}: duplicate id in ${labels.join(", ")}`);
  }
  return new Set(byId.keys());
}

function readActive(ids) {
  const items = [];
  if (!existsSync(activeDir)) return items;
  for (const f of readdirSync(activeDir).sort()) {
    if (!/\.md$/.test(f)) continue;
    const where = `active/${f}`;
    const fileId = f.replace(/\.md$/, "");
    const fm = parseFrontMatter(readFileSync(join(activeDir, f), "utf8"), where);
    if (!fm) continue;
    const err = (msg) => errors.push(`${where}: ${msg}`);
    if (!ID_RE.test(fileId)) err(`filename must be ${cfg.idPrefix} + ${cfg.idWidth} digits`);
    if (!fm.id) err("missing `id`");
    else if (fm.id !== fileId) err(`id (${fm.id}) does not match filename (${fileId})`);
    if (!fm.title) err("missing `title`");
    if (!fm.summary) err("missing `summary`");
    if (fm.status !== "active") err('`status` must be "active"');
    if (!PRIORITIES.includes(fm.priority)) err(`priority must be one of ${PRIORITIES.join(", ")}`);
    if (!EFFORT.has(fm.effort)) err(`effort must be one of ${[...EFFORT].join(", ")}`);
    if (!MILESTONES.includes(fm.milestone)) err(`milestone must be one of ${MILESTONES.join(", ")}`);
    const deps = fm.depends_on ?? [];
    for (const d of deps) if (!ids.has(d)) err(`depends_on ${d} is not a known task id`);
    items.push({ ...fm, depends_on: deps, _file: f });
  }
  return items;
}

function readClosed(dir) {
  const items = [];
  if (!existsSync(dir)) return items;
  for (const f of readdirSync(dir).sort()) {
    if (!FILE_RE.test(f)) continue;
    const fm = parseFrontMatter(readFileSync(join(dir, f), "utf8"), f);
    if (fm) items.push({ ...fm, depends_on: fm.depends_on ?? [] });
  }
  return items;
}

function nextId(ids) {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.slice(cfg.idPrefix.length));
    if (n > max) max = n;
  }
  return cfg.idPrefix + String(max + 1).padStart(cfg.idWidth, "0");
}

function table(items) {
  const rows = items.slice()
    .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](active/${it._file}) | ${it.title} | ${it.priority} | ${it.effort} |`);
  return ["| ID | Title | Priority | Effort |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

function fillMarkers(text, begin, end, body) {
  return text.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), `${begin}\n${body}\n${end}`);
}

function completedTable(items) {
  if (!items.length) return "_No completed items yet._";
  const rows = items.slice()
    .sort((a, b) => String(b.completed_on ?? "").localeCompare(String(a.completed_on ?? "")) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](tasks/${it.id}.md) | ${cell(it.title)} | ${cell(it.summary)} | ${cell(it.completed_on)} |`);
  return ["| ID | Title | Summary | Completed |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function removedTable(items) {
  if (!items.length) return "_No removed items yet._";
  const rows = items.slice()
    .sort((a, b) => String(b.removed_on ?? "").localeCompare(String(a.removed_on ?? "")) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](${it.id}.md) | ${cell(it.title)} | ${cell(it.summary)} | ${cell(it.removed_on)} | ${cell(it.removed_reason)} |`);
  return ["| ID | Title | Summary | Removed | Reason |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

const ids = knownIds();
const active = readActive(ids);
const completed = readClosed(completedDir);
const removed = readClosed(removedDir);

if (errors.length) {
  console.error("Backlog validation failed:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

let block = "";
for (const ms of MILESTONES) {
  const items = active.filter((a) => a.milestone === ms);
  if (!items.length) continue;
  block += `\n### ${ms}\n\n${table(items)}\n`;
}
const next = nextId(ids);
const generated = `${BEGIN}\n${block}\n## Next task ID\n\n\`${next}\`\n${END}`;

const readme = readFileSync(readmePath, "utf8");
const newReadme = readme.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), generated);

const completedIndex = readFileSync(completedIndexPath, "utf8");
const newCompletedIndex = fillMarkers(completedIndex, C_BEGIN, C_END, completedTable(completed));
const removedIndex = readFileSync(removedIndexPath, "utf8");
const newRemovedIndex = fillMarkers(removedIndex, R_BEGIN, R_END, removedTable(removed));

const backlog = {
  prefix: cfg.idPrefix,
  milestones: MILESTONES,
  nextId: next,
  counts: { active: active.length, completed: completed.length, removed: removed.length },
  tasks: [
    ...active.map((a) => ({ id: a.id, title: a.title, status: "active", milestone: a.milestone, priority: a.priority, effort: a.effort, depends_on: a.depends_on, summary: a.summary })),
    ...completed.map((a) => ({ id: a.id, title: a.title, status: "completed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, depends_on: a.depends_on, summary: a.summary ?? null, completed_on: a.completed_on ?? null })),
    ...removed.map((a) => ({ id: a.id, title: a.title, status: "removed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, depends_on: a.depends_on, summary: a.summary ?? null, removed_on: a.removed_on ?? null, removed_reason: a.removed_reason ?? null })),
  ],
};
const backlogStr = JSON.stringify(backlog, null, 2) + "\n";

if (isCheck) {
  let stale = false;
  const drift = (cur, want, path) => {
    if (cur !== want) { console.error(`${path} is stale - run: npm run backlog:readme`); stale = true; }
  };
  drift(readme, newReadme, "docs/tasks/README.md");
  drift(completedIndex, newCompletedIndex, "docs/tasks/completed/index.md");
  drift(removedIndex, newRemovedIndex, "docs/tasks/removed/index.md");
  drift(existsSync(backlogJsonPath) ? readFileSync(backlogJsonPath, "utf8") : "", backlogStr, "docs/tasks/backlog.json");
  if (stale) process.exit(1);
  console.log("Backlog check OK.");
  process.exit(0);
}

writeFileSync(readmePath, newReadme);
writeFileSync(completedIndexPath, newCompletedIndex);
writeFileSync(removedIndexPath, newRemovedIndex);
writeFileSync(backlogJsonPath, backlogStr);
console.log(`Backlog OK: ${active.length} active, ${completed.length} completed, ${removed.length} removed. Next id: ${next}`);
