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
  attachEffortScale(cfg, errors);

  if (cfg.specVersion == null) {
    warnings.push(`config has no \`specVersion\`; assuming current spec ${SPEC_VERSION}`);
  } else if (String(cfg.specVersion).split(".")[0] !== SPEC_VERSION.split(".")[0]) {
    warnings.push(`config \`specVersion\` ${cfg.specVersion} differs in major version from this tool's spec ${SPEC_VERSION}`);
  }
  return { cfg, warnings, errors };
}

// --------------------------------------------------------- effort scales
// The active effort scale is a 1:1 skin over the canonical numbers (SPEC §6).
// Shape: { isIdentity, name, byNumber: Map<number,{label,emoji?,image?}>,
// byLabel: Map<lowercased label, number> }. The identity ("fibonacci") scale
// labels each value with its own number and accepts no aliases.
// Resolve and attach the active effort scale to a config (SPEC §6.1). Exported
// so callers that build a config WITHOUT loadConfig — e.g. trellis init's
// synthetic effectiveConfig — still get a usable scale; otherwise resolveEffort
// and the rendering helpers dereference an undefined `effortScale`. Only attempts
// the skin when the canonical values are well-formed; otherwise falls back to
// identity so later stages have a usable (if empty) scale and the real config
// error is what surfaces.
export function attachEffortScale(cfg, errors = []) {
  const values = Array.isArray(cfg.effortValues) ? cfg.effortValues : [];
  cfg.effortScale = values.length && values.every((v) => typeof v === "number" && Number.isFinite(v))
    ? buildEffortScale(cfg, errors)
    : identityScale(values);
  return cfg.effortScale;
}

function identityScale(values) {
  return {
    isIdentity: true,
    name: "fibonacci",
    byNumber: new Map(values.map((v) => [v, { label: String(v) }])),
    byLabel: new Map(),
  };
}

function buildEffortScale(cfg, errors) {
  const values = cfg.effortValues;
  const obj = Array.isArray(cfg.effort) ? null : cfg.effort;
  const scaleName = obj && obj.scale != null ? obj.scale : "fibonacci";

  if (typeof scaleName !== "string") {
    errors.push("config: effort `scale` must be a string");
    return identityScale(values);
  }
  if (scaleName === "fibonacci") return identityScale(values);

  const scales = obj && obj.scales;
  if (scales == null || typeof scales !== "object" || Array.isArray(scales)) {
    errors.push("config: effort `scales` must be an object when a non-identity `scale` is selected");
    return identityScale(values);
  }
  const active = scales[scaleName];
  if (active == null || typeof active !== "object" || Array.isArray(active)) {
    errors.push(`config: effort \`scale\` "${scaleName}" is not defined in \`scales\``);
    return identityScale(values);
  }

  // Validate the active scale fully: every canonical value mapped, each entry a
  // non-empty unique label with optional string emoji/image (SPEC §6.1).
  const byNumber = new Map();
  const byLabel = new Map();
  for (const v of values) {
    const entry = active[String(v)];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`config: effort scale "${scaleName}" is missing a mapping for value ${v}`);
      continue;
    }
    const { label, emoji, image } = entry;
    if (typeof label !== "string" || !label.trim()) {
      errors.push(`config: effort scale "${scaleName}" value ${v}: \`label\` must be a non-empty string`);
      continue;
    }
    if (emoji != null && typeof emoji !== "string") errors.push(`config: effort scale "${scaleName}" value ${v}: \`emoji\` must be a string`);
    if (image != null && typeof image !== "string") errors.push(`config: effort scale "${scaleName}" value ${v}: \`image\` must be a string`);
    const key = label.trim().toLowerCase();
    if (byLabel.has(key)) errors.push(`config: effort scale "${scaleName}" has duplicate label "${label}"`);
    byLabel.set(key, v);
    const resolved = { label };
    if (typeof emoji === "string") resolved.emoji = emoji;
    if (typeof image === "string") resolved.image = image;
    byNumber.set(v, resolved);
  }
  return { isIdentity: false, name: scaleName, byNumber, byLabel };
}

// Resolve a front-matter `effort` (a canonical number or a case-insensitive
// label alias) against the active scale (SPEC §6.2). Returns
// { value, label, emoji?, image? } on success, or { error } with an actionable
// message. Shared by the generator (active-item validation) and the MCP writer.
export function resolveEffort(cfg, raw) {
  const scale = cfg.effortScale;
  let value;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    const key = raw.trim().toLowerCase();
    if (scale.byLabel.has(key)) value = scale.byLabel.get(key);
    else if (/^-?\d+$/.test(raw.trim())) value = Number(raw.trim());
    else return { error: effortError(cfg) };
  } else {
    return { error: effortError(cfg) };
  }
  if (!cfg.effortValues.includes(value)) return { error: effortError(cfg) };
  const entry = scale.byNumber.get(value) || { label: String(value) };
  const out = { value, label: entry.label };
  if (entry.emoji) out.emoji = entry.emoji;
  if (entry.image) out.image = entry.image;
  return out;
}

function effortError(cfg) {
  const nums = cfg.effortValues.join(", ");
  if (cfg.effortScale.isIdentity) return `effort must be one of ${nums}`;
  const labels = [...cfg.effortScale.byNumber.values()].map((e) => e.label).join(", ");
  return `effort must be a value (${nums}) or a label (${labels})`;
}

// The README effort cell: `[emoji ]label · N` under a custom scale, bare `N`
// under identity (SPEC §6.3). Reads the resolved fields attached in readBacklog.
function effortCell(it, cfg) {
  if (cfg.effortScale.isIdentity || !it._effortLabel) return String(it.effort ?? "");
  const emoji = it._effortEmoji ? `${it._effortEmoji} ` : "";
  return `${emoji}${it._effortLabel} · ${it.effort}`;
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
  const idRe = new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);
  const isoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // Resolve `effort` (number or label alias) and attach the display fields used
  // by rendering. Active items surface a resolution error; closed items resolve
  // best-effort (historical values are not re-validated — SPEC §5.1, §8.3).
  const attachEffort = (it, onError) => {
    const r = resolveEffort(cfg, it.effort);
    if (r.error) { if (onError) onError(r.error); return; }
    it.effort = r.value;
    it._effortLabel = r.label;
    if (r.emoji) it._effortEmoji = r.emoji;
    if (r.image) it._effortImage = r.image;
  };

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
    attachEffort(it, err);
    if (!cfg.milestones.includes(it.milestone)) err(`milestone must be one of ${cfg.milestones.join(", ")}`);
  }
  for (const it of completed) {
    const err = (m) => errors.push(`completed/${it._file}: ${m}`);
    checkCommon(it, "completed", err);
    attachEffort(it, null);
    if (!isoDate(it.completed_on)) err("`completed_on` must be an ISO date (YYYY-MM-DD)");
  }
  for (const it of removed) {
    const err = (m) => errors.push(`removed/${it._file}: ${m}`);
    checkCommon(it, "removed", err);
    attachEffort(it, null);
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
    .map((it) => `| [${it.id}](active/${it._file}) | ${cell(it.title)} | ${it.priority} | ${cell(effortCell(it, cfg))} |`);
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

// Resolved effort skin for backlog.json (SPEC §8.2): label + optional
// emoji/image, emitted only under a custom scale. Identity (array-form) repos
// emit no extra fields, so their backlog.json is unchanged.
function effortFields(a, cfg) {
  if (cfg.effortScale.isIdentity || !a._effortLabel) return {};
  const f = { effortLabel: a._effortLabel };
  if (a._effortEmoji) f.effortEmoji = a._effortEmoji;
  if (a._effortImage) f.effortImage = a._effortImage;
  return f;
}

export function buildBacklogJson(cfg, data) {
  const backlog = {
    prefix: cfg.idPrefix,
    milestones: cfg.milestones,
    nextId: nextId(data.ids, cfg),
    counts: { active: data.active.length, completed: data.completed.length, removed: data.removed.length },
    tasks: [
      ...data.active.map((a) => ({ id: a.id, title: a.title, status: "active", milestone: a.milestone, priority: a.priority, effort: a.effort, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], summary: a.summary })),
      ...data.completed.map((a) => ({ id: a.id, title: a.title, status: "completed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], summary: a.summary ?? null, completed_on: a.completed_on ?? null })),
      ...data.removed.map((a) => ({ id: a.id, title: a.title, status: "removed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], summary: a.summary ?? null, removed_on: a.removed_on ?? null, removed_reason: a.removed_reason ?? null })),
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
