// Trellis backlog core (zero-dependency).
//
// Reusable logic for validating backlog items and generating the derived
// artifacts (README tables, completed/removed indexes, backlog.json). Both the
// CLI (scripts/backlog-readme.mjs) and the MCP server import these functions, so
// every entry point takes an explicit repoRoot and holds no process-wide state.
//
// Front-matter is the small, fixed YAML subset from SPEC.md §5, parsed in-house
// on purpose so Trellis stays drop-in with no install step.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// Spec version this tool implements (SemVer major.minor); see SPEC.md §9.
export const SPEC_VERSION = "1.0";

export const MARKERS = {
  milestones: ["<!-- BEGIN GENERATED:MILESTONES -->", "<!-- END GENERATED:MILESTONES -->"],
  completed: ["<!-- BEGIN GENERATED:COMPLETED -->", "<!-- END GENERATED:COMPLETED -->"],
  removed: ["<!-- BEGIN GENERATED:REMOVED -->", "<!-- END GENERATED:REMOVED -->"],
};

export function paths(repoRoot) {
  const tasks = join(repoRoot, "docs", "tasks");
  return {
    config: join(repoRoot, "backlog.config.json"),
    tasks,
    active: join(tasks, "active"),
    completedTasks: join(tasks, "completed", "tasks"),
    removed: join(tasks, "removed"),
    readme: join(tasks, "README.md"),
    backlogJson: join(tasks, "backlog.json"),
    completedIndex: join(tasks, "completed", "index.md"),
    removedIndex: join(tasks, "removed", "index.md"),
  };
}

// ----------------------------------------------------------------- config
export function loadConfig(repoRoot) {
  const warnings = [];
  const configPath = paths(repoRoot).config;
  if (!existsSync(configPath)) return { cfg: null, warnings, errors: ["missing backlog.config.json"] };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { cfg: null, warnings, errors: [`backlog.config.json is not valid JSON (${e.message})`] };
  }

  const errors = [];
  if (typeof cfg.idPrefix !== "string" || !cfg.idPrefix) errors.push("config: `idPrefix` must be a non-empty string");
  if (!Number.isInteger(cfg.idWidth) || cfg.idWidth < 1) errors.push("config: `idWidth` must be a positive integer");
  if (!Array.isArray(cfg.milestones) || cfg.milestones.length === 0) errors.push("config: `milestones` must be a non-empty array");
  if (!Array.isArray(cfg.priorities) || cfg.priorities.length === 0) errors.push("config: `priorities` must be a non-empty array");
  const effortValues = Array.isArray(cfg.effort) ? cfg.effort : cfg.effort && cfg.effort.values;
  if (!Array.isArray(effortValues) || effortValues.length === 0) {
    errors.push("config: `effort` must be an array of numbers (or an object with a `values` array)");
  } else if (!effortValues.every((v) => typeof v === "number" && Number.isFinite(v))) {
    errors.push("config: `effort` values must all be numbers");
  }
  cfg.effortValues = Array.isArray(effortValues) ? effortValues : [];

  if (cfg.specVersion == null) {
    warnings.push(`config has no \`specVersion\`; assuming current spec ${SPEC_VERSION}`);
  } else if (String(cfg.specVersion).split(".")[0] !== SPEC_VERSION.split(".")[0]) {
    warnings.push(`config \`specVersion\` ${cfg.specVersion} differs in major version from this tool's spec ${SPEC_VERSION}`);
  }
  return { cfg, warnings, errors };
}

// ----------------------------------------------------------- front-matter
function unquote(s) {
  const m = s.match(/^"([\s\S]*)"$/) || s.match(/^'([\s\S]*)'$/);
  return m ? m[1] : s;
}

// Parse the YAML-subset front-matter block. Tolerates CRLF, `#` comments, and
// colons inside values; flags malformed lines and duplicate keys via `errors`.
export function parseFrontMatter(text, where, errors = []) {
  const block = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!block) { errors.push(`${where}: missing or unterminated YAML front-matter`); return null; }
  const fm = {};
  const seen = new Set();
  const lines = block[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { errors.push(`${where}: cannot parse front-matter line: "${line.trim()}"`); continue; }
    const key = kv[1];
    if (seen.has(key)) errors.push(`${where}: duplicate key \`${key}\``);
    seen.add(key);
    const val = kv[2].trim();
    if (key === "depends_on") {
      if (val.startsWith("[")) {
        fm.depends_on = val.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s.trim())).filter(Boolean);
      } else if (val === "") {
        const deps = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          deps.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
        }
        fm.depends_on = deps;
      } else {
        fm.depends_on = [unquote(val)];
      }
      continue;
    }
    const quoted = /^"[\s\S]*"$/.test(val) || /^'[\s\S]*'$/.test(val);
    const v = unquote(val);
    // Coerce only *unquoted* all-digit values to numbers, so a quoted "404" round-
    // trips as the string "404" — how the MCP writer preserves a numeric-looking
    // title/summary (src/mcp.mjs serializeFrontMatter) against the string contract.
    fm[key] = !quoted && /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return fm;
}

// --------------------------------------------------------------- reading
function idsFromDir(dir, fileRe) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.match(fileRe)).filter(Boolean).map((m) => m[1]);
}

export function readBacklog(repoRoot, cfg) {
  const p = paths(repoRoot);
  const fileRe = new RegExp(`^(${cfg.idPrefix}\\d{${cfg.idWidth}})\\.md$`);
  const errors = [];

  const byId = new Map();
  for (const [label, dir] of [["active", p.active], ["completed/tasks", p.completedTasks], ["removed", p.removed]]) {
    for (const id of idsFromDir(dir, fileRe)) {
      const at = byId.get(id) || []; at.push(label); byId.set(id, at);
    }
  }
  for (const [id, at] of byId) if (at.length > 1) errors.push(`${id}: duplicate id in ${at.join(", ")}`);
  const ids = new Set(byId.keys());

  const readDir = (dir, kind, isActive) => {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
      if (!fileRe.test(f)) {
        if (isActive && /\.md$/.test(f)) errors.push(`active/${f}: filename must be ${cfg.idPrefix} + ${cfg.idWidth} digits`);
        continue;
      }
      const fm = parseFrontMatter(readFileSync(join(dir, f), "utf8"), `${kind}/${f}`, errors);
      if (fm) out.push({ ...fm, _file: f });
    }
    return out;
  };

  const active = readDir(p.active, "active", true);
  const completed = readDir(p.completedTasks, "completed", false);
  const removed = readDir(p.removed, "removed", false);

  // Validation. Active items are checked in full against the live config. Closed
  // items are checked for lifecycle integrity (status, ISO close date, reason,
  // required depends_on with referential checks); their historical enum values
  // (milestone/priority/effort) are NOT re-validated against the current config
  // (SPEC.md §5.1, §8.3).
  const effortSet = new Set(cfg.effortValues);
  const idRe = new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);
  const isoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const checkCommon = (it, expected, err) => {
    const fileId = it._file.replace(/\.md$/, "");
    if (!idRe.test(fileId)) err(`filename must be ${cfg.idPrefix} + ${cfg.idWidth} digits`);
    if (!it.id) err("missing `id`");
    else if (it.id !== fileId) err(`id (${it.id}) does not match filename (${fileId})`);
    if (!it.title) err("missing `title`");
    if (it.status !== expected) err(`\`status\` must be "${expected}"`);
    if (it.depends_on === undefined) err("missing `depends_on` (use [] for none)");
    else for (const d of it.depends_on) if (!ids.has(d)) err(`depends_on ${d} is not a known task id`);
  };

  for (const it of active) {
    const err = (m) => errors.push(`active/${it._file}: ${m}`);
    checkCommon(it, "active", err);
    if (!it.summary) err("missing `summary`");
    if (!cfg.priorities.includes(it.priority)) err(`priority must be one of ${cfg.priorities.join(", ")}`);
    if (!effortSet.has(it.effort)) err(`effort must be one of ${cfg.effortValues.join(", ")}`);
    if (!cfg.milestones.includes(it.milestone)) err(`milestone must be one of ${cfg.milestones.join(", ")}`);
  }
  for (const it of completed) {
    const err = (m) => errors.push(`completed/${it._file}: ${m}`);
    checkCommon(it, "completed", err);
    if (!isoDate(it.completed_on)) err("`completed_on` must be an ISO date (YYYY-MM-DD)");
  }
  for (const it of removed) {
    const err = (m) => errors.push(`removed/${it._file}: ${m}`);
    checkCommon(it, "removed", err);
    if (!isoDate(it.removed_on)) err("`removed_on` must be an ISO date (YYYY-MM-DD)");
    if (!it.removed_reason) err("missing `removed_reason`");
  }

  return { active, completed, removed, ids, errors };
}

// ------------------------------------------------------------------ ids
export function nextId(ids, cfg) {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.slice(cfg.idPrefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return cfg.idPrefix + String(max + 1).padStart(cfg.idWidth, "0");
}

// ------------------------------------------------------------- rendering
function cell(s) { return String(s ?? "").replace(/\|/g, "\\|"); }

function fillMarkers(text, [begin, end], body, where, errors) {
  const re = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!re.test(text)) { errors.push(`${where}: generated markers not found (${begin} ... ${end})`); return text; }
  return text.replace(re, `${begin}\n${body}\n${end}`);
}

function activeTable(items, cfg) {
  const rank = Object.fromEntries(cfg.priorities.map((p, i) => [p, i]));
  const rows = items.slice()
    .sort((a, b) => (rank[a.priority] - rank[b.priority]) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](active/${it._file}) | ${cell(it.title)} | ${it.priority} | ${it.effort} |`);
  return ["| ID | Title | Priority | Effort |", "| --- | --- | --- | --- |", ...rows].join("\n");
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

export function buildBacklogJson(cfg, data) {
  const backlog = {
    prefix: cfg.idPrefix,
    milestones: cfg.milestones,
    nextId: nextId(data.ids, cfg),
    counts: { active: data.active.length, completed: data.completed.length, removed: data.removed.length },
    tasks: [
      ...data.active.map((a) => ({ id: a.id, title: a.title, status: "active", milestone: a.milestone, priority: a.priority, effort: a.effort, depends_on: a.depends_on ?? [], summary: a.summary })),
      ...data.completed.map((a) => ({ id: a.id, title: a.title, status: "completed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, depends_on: a.depends_on ?? [], summary: a.summary ?? null, completed_on: a.completed_on ?? null })),
      ...data.removed.map((a) => ({ id: a.id, title: a.title, status: "removed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, depends_on: a.depends_on ?? [], summary: a.summary ?? null, removed_on: a.removed_on ?? null, removed_reason: a.removed_reason ?? null })),
    ],
  };
  return JSON.stringify(backlog, null, 2) + "\n";
}

// Compute each generated artifact's path + new content. Pure except for reading
// the current files (needed to replace content between their markers).
export function generateArtifacts(repoRoot, cfg, data) {
  const p = paths(repoRoot);
  const errors = [];
  const next = nextId(data.ids, cfg);

  let block = "";
  for (const ms of cfg.milestones) {
    const items = data.active.filter((a) => a.milestone === ms);
    if (items.length) block += `\n### ${ms}\n\n${activeTable(items, cfg)}\n`;
  }
  const readmeBody = `${block}\n## Next task ID\n\n\`${next}\``;

  const readText = (path) => {
    if (existsSync(path)) return readFileSync(path, "utf8");
    errors.push(`missing ${relative(repoRoot, path)}`);
    return "";
  };

  const files = [
    { path: p.readme, content: fillMarkers(readText(p.readme), MARKERS.milestones, readmeBody, "docs/tasks/README.md", errors) },
    { path: p.completedIndex, content: fillMarkers(readText(p.completedIndex), MARKERS.completed, completedTable(data.completed), "docs/tasks/completed/index.md", errors) },
    { path: p.removedIndex, content: fillMarkers(readText(p.removedIndex), MARKERS.removed, removedTable(data.removed), "docs/tasks/removed/index.md", errors) },
    { path: p.backlogJson, content: buildBacklogJson(cfg, data) },
  ];
  return { files, nextId: next, errors };
}
