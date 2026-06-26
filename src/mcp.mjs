// Trellis MCP operations (zero-dependency, transport-agnostic).
//
// The seven backlog operations the MCP server exposes as tools, each a plain
// function over the TRL0002 core (src/backlog.mjs) that takes an explicit
// repoRoot and returns a structured result (the backlog.json shape, or a slice).
// The SDK + stdio wiring live in scripts/trellis-mcp.mjs; keeping these functions
// dependency-free means the whole tool surface is unit-testable with `node --test`
// and no transport.
//
// Mutating ops (create_task, move_task, regenerate) honour one rule (TRL0004
// Risk): apply the change, then re-read + validate the whole backlog and
// regenerate every artifact before returning. On any validation failure they roll
// back to the pre-call state, so the repo is never left invalid or with stale
// generated files — mirroring init's no-partial-write ethos.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import {
  loadConfig,
  readBacklog,
  generateArtifacts,
  buildBacklogJson,
  nextId,
  parseFrontMatter,
  paths,
} from "./backlog.mjs";

// A domain error the transport maps to an MCP tool error (isError result) rather
// than a protocol failure. `code` is a short slug for programmatic handling.
export class TrellisError extends Error {
  constructor(message, code = "invalid_request") {
    super(message);
    this.name = "TrellisError";
    this.code = code;
  }
}

// ------------------------------------------------------------- loading
// Config must load for any op (we can't compute ids/validate without it).
function loadCfg(repoRoot) {
  const { cfg, errors } = loadConfig(repoRoot);
  if (errors.length) throw new TrellisError(`config: ${errors.join("; ")}`, "config_error");
  return cfg;
}

// Read ops tolerate per-item errors (they still list what parsed); mutating ops
// require a clean backlog up front, since you should not mutate an invalid one.
function loadClean(repoRoot) {
  const cfg = loadCfg(repoRoot);
  const data = readBacklog(repoRoot, cfg);
  if (data.errors.length) {
    throw new TrellisError(`backlog has errors; fix before mutating: ${data.errors.join("; ")}`, "invalid_backlog");
  }
  return { cfg, data };
}

// The backlog.json shape as an object — parsed from the core's serializer so the
// tool result is byte-for-byte the same contract clients read from disk.
function backlogObject(cfg, data) {
  return JSON.parse(buildBacklogJson(cfg, data));
}

// ----------------------------------------------------------- front-matter
// Canonical field order, matching the hand-authored items (close date sits right
// after milestone; removed_reason last). Order is cosmetic — the parser is
// order-independent — but consistency keeps diffs clean.
const FM_ORDER = [
  "id", "title", "status", "milestone",
  "completed_on", "removed_on",
  "priority", "effort", "depends_on", "summary", "removed_reason",
];

function oneLine(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TrellisError(`\`${field}\` is required`);
  if (/[\r\n]/.test(value)) throw new TrellisError(`\`${field}\` must be a single line`);
  return value.trim();
}

// Emit the YAML-subset front-matter the core's parser reads back: depends_on as an
// inline array, everything else verbatim. Unknown keys are preserved after the
// known ones so nothing is silently dropped.
function serializeFrontMatter(fm) {
  const emit = (key) => {
    const v = fm[key];
    if (key === "depends_on") return `depends_on: [${(v ?? []).join(", ")}]`;
    return `${key}: ${v}`;
  };
  const keys = [...FM_ORDER.filter((k) => fm[k] !== undefined), ...Object.keys(fm).filter((k) => !FM_ORDER.includes(k))];
  return keys.map(emit).join("\n");
}

function composeFile(fm, body) {
  const b = String(body).replace(/^\n+/, "").replace(/\n*$/, "\n");
  return `---\n${serializeFrontMatter(fm)}\n---\n\n${b}`;
}

// Split an item file into its front-matter object and the Markdown body.
function splitItem(text, where) {
  const norm = text.replace(/\r\n/g, "\n");
  const errors = [];
  const fm = parseFrontMatter(norm, where, errors);
  if (!fm || errors.length) throw new TrellisError(`${where}: ${errors.join("; ") || "unparseable front-matter"}`, "invalid_item");
  const m = norm.match(/^---\n[\s\S]*?\n---\n?/);
  // Strip the blank line that follows the closing `---` so the body starts at its
  // first heading — prependSection anchors on a leading H1.
  const body = (m ? norm.slice(m[0].length) : "").replace(/^\n+/, "");
  return { fm, body };
}

// Insert a section (e.g. "## Completed") right after the body's H1, so a closeout
// note lands where the spec recommends (SPEC §5.2, prepended on closeout).
function prependSection(body, heading, note) {
  if (!note) return body;
  const block = `## ${heading}\n\n${note}`;
  const m = body.match(/^(#\s[^\n]*\n)/);
  if (!m) return `${block}\n\n${body}`;
  const rest = body.slice(m[0].length).replace(/^\n+/, "");
  return `${m[1]}\n${block}\n\n${rest}`;
}

function scaffoldBody(id, title) {
  return `# ${id} — ${title}\n\n## Scope\n\n## Notes\n\n## Risks\n`;
}

// --------------------------------------------------------------- dates
function isoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------- regenerate (shared)
// Write any stale artifact; return the repo-relative paths that changed. Pure
// w.r.t. the item files — only the four generated artifacts are touched.
function writeArtifacts(repoRoot, cfg, data) {
  const { files, nextId: next, errors } = generateArtifacts(repoRoot, cfg, data);
  if (errors.length) throw new TrellisError(`generate failed: ${errors.join("; ")}`, "generate_failed");
  const changed = [];
  for (const f of files) {
    const before = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
    if (before !== f.content) {
      writeFileSync(f.path, f.content);
      changed.push(relative(repoRoot, f.path));
    }
  }
  return { changed, nextId: next };
}

// ================================================================= tools

// list_tasks — the backlog header + tasks, optionally filtered. counts/nextId
// always describe the whole backlog; only `tasks` is narrowed by the filters.
export function listTasks(repoRoot, { status, milestone } = {}) {
  const cfg = loadCfg(repoRoot);
  const data = readBacklog(repoRoot, cfg);
  const backlog = backlogObject(cfg, data);
  let tasks = backlog.tasks;
  if (status) tasks = tasks.filter((t) => t.status === status);
  if (milestone) tasks = tasks.filter((t) => t.milestone === milestone);
  return { ...backlog, tasks };
}

// get_task — the structured entry plus the raw Markdown body and file path.
export function getTask(repoRoot, { id } = {}) {
  oneLine(id, "id");
  const cfg = loadCfg(repoRoot);
  const data = readBacklog(repoRoot, cfg);
  const entry = backlogObject(cfg, data).tasks.find((t) => t.id === id);
  if (!entry) throw new TrellisError(`no task with id ${id}`, "not_found");
  const p = paths(repoRoot);
  const dir = entry.status === "active" ? p.active : entry.status === "completed" ? p.completedTasks : p.removed;
  const file = join(dir, `${id}.md`);
  const { body } = splitItem(readFileSync(file, "utf8"), `${entry.status}/${id}.md`);
  return { ...entry, body: body.replace(/\n*$/, "\n"), file: relative(repoRoot, file) };
}

// next_id — the id a new task would receive.
export function nextIdOp(repoRoot) {
  const cfg = loadCfg(repoRoot);
  const data = readBacklog(repoRoot, cfg);
  return { nextId: nextId(data.ids, cfg) };
}

// validate — config + item + marker validity, read-only. Never throws on backlog
// content; reporting those errors is the point. (`regenerate` owns staleness.)
export function validateOp(repoRoot) {
  const { cfg, warnings, errors: cfgErrors } = loadConfig(repoRoot);
  if (cfgErrors.length) return { ok: false, errors: cfgErrors, warnings };
  const data = readBacklog(repoRoot, cfg);
  const gen = generateArtifacts(repoRoot, cfg, data); // computes only; the CLI writes
  const errors = [...data.errors, ...gen.errors];
  return { ok: errors.length === 0, errors, warnings };
}

// regenerate — rewrite any stale artifact. Refuses on an invalid backlog rather
// than generating from bad input.
export function regenerateOp(repoRoot) {
  const { cfg, data } = loadClean(repoRoot);
  const { changed, nextId: next } = writeArtifacts(repoRoot, cfg, data);
  return { changed, nextId: next, counts: backlogObject(cfg, data).counts };
}

// create_task — assign the next id, write active/<id>.md, then re-read + validate
// + regenerate. Rolls back (removes the new file) if the result does not validate.
export function createTask(repoRoot, args = {}) {
  const title = oneLine(args.title, "title");
  const summary = oneLine(args.summary, "summary");
  const milestone = oneLine(args.milestone, "milestone");
  const priority = oneLine(args.priority, "priority");
  if (typeof args.effort !== "number" || !Number.isFinite(args.effort)) {
    throw new TrellisError("`effort` must be a number (label resolution is TRL0015)");
  }
  const depends_on = args.depends_on ?? [];
  if (!Array.isArray(depends_on) || depends_on.some((d) => typeof d !== "string")) {
    throw new TrellisError("`depends_on` must be a list of task ids");
  }

  const { cfg, data } = loadClean(repoRoot);
  const id = nextId(data.ids, cfg);
  const fm = { id, title, status: "active", milestone, priority, effort: args.effort, depends_on, summary };
  const body = args.body ? args.body : scaffoldBody(id, title);
  const file = join(paths(repoRoot).active, `${id}.md`);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, composeFile(fm, body));
  try {
    const data2 = readBacklog(repoRoot, cfg);
    if (data2.errors.length) throw new TrellisError(`created task is invalid: ${data2.errors.join("; ")}`, "invalid_backlog");
    writeArtifacts(repoRoot, cfg, data2);
    return { created: backlogObject(cfg, data2).tasks.find((t) => t.id === id) };
  } catch (e) {
    rmSync(file, { force: true }); // roll back — the file is brand new
    throw e;
  }
}

// move_task — active → completed/removed: move the file, update front-matter, and
// prepend the closeout note. Rolls back (restore source, remove target) on a
// validation failure.
export function moveTask(repoRoot, args = {}) {
  const id = oneLine(args.id, "id");
  const to = args.to;
  if (to !== "completed" && to !== "removed") throw new TrellisError("`to` must be \"completed\" or \"removed\"");
  const date = args.date === undefined ? todayISO() : args.date;
  if (!isoDate(date)) throw new TrellisError("`date` must be an ISO date (YYYY-MM-DD)");
  const reason = to === "removed" ? oneLine(args.reason, "reason") : undefined;

  const { cfg } = loadClean(repoRoot);
  const p = paths(repoRoot);
  const src = join(p.active, `${id}.md`);
  if (!existsSync(src)) {
    const elsewhere = existsSync(join(p.completedTasks, `${id}.md`)) || existsSync(join(p.removed, `${id}.md`));
    throw new TrellisError(elsewhere ? `task ${id} is not active; only active tasks can be moved` : `no active task with id ${id}`, "not_found");
  }

  const original = readFileSync(src, "utf8");
  const { fm, body } = splitItem(original, `active/${id}.md`);
  fm.status = to;
  if (to === "completed") fm.completed_on = date;
  else { fm.removed_on = date; fm.removed_reason = reason; }
  const heading = to === "completed" ? "Completed" : "Removed";
  const newBody = prependSection(body, heading, args.note ? oneLine(args.note, "note") : "");

  const targetDir = to === "completed" ? p.completedTasks : p.removed;
  const target = join(targetDir, `${id}.md`);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, composeFile(fm, newBody));
  rmSync(src, { force: true });
  try {
    const data2 = readBacklog(repoRoot, cfg);
    if (data2.errors.length) throw new TrellisError(`move produced an invalid backlog: ${data2.errors.join("; ")}`, "invalid_backlog");
    writeArtifacts(repoRoot, cfg, data2);
    return { moved: backlogObject(cfg, data2).tasks.find((t) => t.id === id), counts: backlogObject(cfg, data2).counts };
  } catch (e) {
    writeFileSync(src, original); // restore the source…
    rmSync(target, { force: true }); // …and undo the target write
    throw e;
  }
}

// Dispatch table for the transport: tool name → (repoRoot, args) → result.
export const OPS = {
  list_tasks: listTasks,
  get_task: getTask,
  next_id: nextIdOp,
  create_task: createTask,
  move_task: moveTask,
  validate: validateOp,
  regenerate: regenerateOp,
};
