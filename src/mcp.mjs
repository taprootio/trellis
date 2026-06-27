// Trellis MCP operations (zero-dependency, transport-agnostic).
//
// The backlog operations the MCP server exposes as tools, each a plain function
// over the TRL0002 core (src/backlog.mjs) that takes an explicit repoRoot and
// returns a structured result (the backlog.json shape or a slice; the import tool
// returns an import summary).
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
import { join, relative, dirname, isAbsolute } from "node:path";
import {
  loadConfig,
  readBacklog,
  generateArtifacts,
  buildBacklogJson,
  resolveEffort,
  findActiveMember,
  nextId,
  parseFrontMatter,
  paths,
  composeFile,
} from "./backlog.mjs";
import { applyImport } from "./import.mjs";
import { loadProfile } from "./profiles.mjs";

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
// The serializer (FM_ORDER / emitScalar / serializeFrontMatter / composeFile) lives
// in the core (src/backlog.mjs) so the importer shares one writer; only the
// MCP-specific input guard stays here.
function oneLine(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TrellisError(`\`${field}\` is required`);
  if (/[\r\n]/.test(value)) throw new TrellisError(`\`${field}\` must be a single line`);
  return value.trim();
}

// ----------------------------------------------------------------- ownership
// Resolve a create_task `owner` arg → a canonical active-roster handle, or undefined
// when omitted. A provided owner that is not an active member is a clear error up
// front (the post-write re-read is the backstop). Empty/whitespace is treated as unset.
function resolveOwnerArg(value, roster) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const v = oneLine(value, "owner");
  const m = findActiveMember(roster, v);
  if (!m) throw new TrellisError(`owner "${v}" is not an active roster member`, "invalid_request");
  return m.handle;
}

// Resolve a create_task `collaborators` arg → canonical active-roster handles, deduped,
// or [] when omitted. Each must be an active member.
function resolveCollaboratorsArg(value, roster) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((c) => typeof c !== "string")) {
    throw new TrellisError("`collaborators` must be a list of roster handles");
  }
  const out = [];
  for (const c of value) {
    const v = c.trim();
    if (!v) continue;
    const m = findActiveMember(roster, v);
    if (!m) throw new TrellisError(`collaborator "${v}" is not an active roster member`, "invalid_request");
    if (!out.includes(m.handle)) out.push(m.handle);
  }
  return out;
}

// Apply an optional owner/collaborators override when closing a task. On close the
// values are historical (SPEC §8.3) — not re-validated against the roster — so this
// only shapes the front-matter (a now-inactive assignee, or who actually did it, is
// allowed); passing null/empty clears the field.
function applyOwnershipOverride(fm, args) {
  if (args.owner !== undefined) {
    if (args.owner === null || String(args.owner).trim() === "") delete fm.owner;
    else fm.owner = oneLine(args.owner, "owner");
  }
  if (args.collaborators !== undefined) {
    if (!Array.isArray(args.collaborators) || args.collaborators.some((c) => typeof c !== "string")) {
      throw new TrellisError("`collaborators` must be a list of roster handles");
    }
    const cleaned = [...new Set(args.collaborators.map((c) => c.trim()).filter(Boolean))];
    if (cleaned.length) fm.collaborators = cleaned; else delete fm.collaborators;
  }
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
  // Local calendar date, not UTC — so a default close date doesn't slip a day
  // when the server's wall clock is on the other side of midnight from UTC.
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function idRegex(cfg) {
  return new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);
}

// Reject a client-supplied id that is not a well-formed task id for this repo,
// before it is ever used to build a filesystem path — closes path traversal via an
// id like "../active/DEMO0001" (which, with to:"removed", could delete a task).
function assertId(id, cfg) {
  const v = oneLine(id, "id");
  if (!idRegex(cfg).test(v)) {
    throw new TrellisError(`invalid task id: ${v} (expected ${cfg.idPrefix} + ${cfg.idWidth} digits)`, "invalid_request");
  }
  return v;
}

// ---------------------------------------------------- regenerate (shared)
// Write any stale artifact; return the repo-relative paths that changed. Pure
// w.r.t. the item files — only the four generated artifacts are touched.
function writeArtifacts(repoRoot, cfg, data) {
  const { files, nextId: next, errors } = generateArtifacts(repoRoot, cfg, data);
  if (errors.length) throw new TrellisError(`generate failed: ${errors.join("; ")}`, "generate_failed");
  // Snapshot prior bytes first so a mid-loop write failure (ENOSPC/EACCES) restores
  // every artifact — honouring the Risk's "never left … with stale generated files."
  const prior = files.map((f) => ({ path: f.path, before: existsSync(f.path) ? readFileSync(f.path, "utf8") : null }));
  const done = [];
  try {
    const changed = [];
    for (const f of files) {
      const { before } = prior.find((p) => p.path === f.path);
      if (before !== f.content) {
        writeFileSync(f.path, f.content);
        done.push(f.path);
        changed.push(relative(repoRoot, f.path));
      }
    }
    return { changed, nextId: next };
  } catch (e) {
    for (const p of prior) {
      if (!done.includes(p.path)) continue;
      try { p.before === null ? rmSync(p.path, { force: true }) : writeFileSync(p.path, p.before); } catch { /* best-effort restore */ }
    }
    throw e;
  }
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
  const cfg = loadCfg(repoRoot);
  const taskId = assertId(id, cfg); // normalized (trimmed) — use it everywhere below
  const data = readBacklog(repoRoot, cfg);
  const entry = backlogObject(cfg, data).tasks.find((t) => t.id === taskId);
  if (!entry) throw new TrellisError(`no task with id ${taskId}`, "not_found");
  const p = paths(repoRoot, cfg);
  const dir = entry.status === "active" ? p.active : entry.status === "completed" ? p.completedTasks : p.removed;
  const file = join(dir, `${taskId}.md`);
  const { body } = splitItem(readFileSync(file, "utf8"), `${entry.status}/${taskId}.md`);
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
  if (typeof args.effort !== "number" && typeof args.effort !== "string") {
    throw new TrellisError("`effort` must be a number or a scale label");
  }
  const rawDeps = args.depends_on ?? [];
  if (!Array.isArray(rawDeps) || rawDeps.some((d) => typeof d !== "string")) {
    throw new TrellisError("`depends_on` must be a list of task ids");
  }
  const depends_on = [...new Set(rawDeps)];

  const { cfg, data } = loadClean(repoRoot);
  // Resolve a number or a case-insensitive scale label to the canonical number,
  // which is what we store in front-matter (SPEC §6.2).
  const effort = resolveEffort(cfg, args.effort);
  if (effort.error) throw new TrellisError(effort.error, "invalid_request");
  // Each dependency id must be a well-formed id for this repo — reject up front so a
  // stray value can't be injected into the front-matter array (the core would catch
  // it on re-read, but this fails faster and with a clearer message).
  const idRe = idRegex(cfg);
  for (const d of depends_on) {
    if (!idRe.test(d)) throw new TrellisError(`invalid dependency id: ${d} (expected ${cfg.idPrefix} + ${cfg.idWidth} digits)`, "invalid_request");
  }
  // Ownership (optional): resolve each handle to an ACTIVE roster member up front for
  // a clear error and canonical casing; the post-write re-read re-checks as a backstop.
  const owner = resolveOwnerArg(args.owner, data.roster);
  const collaborators = resolveCollaboratorsArg(args.collaborators, data.roster);

  const id = nextId(data.ids, cfg);
  const fm = { id, title, status: "active", milestone, priority, effort: effort.value, depends_on, summary };
  if (owner) fm.owner = owner;
  if (collaborators.length) fm.collaborators = collaborators;
  const body = args.body ? args.body : scaffoldBody(id, title);
  const file = join(paths(repoRoot, cfg).active, `${id}.md`);

  // The write lives inside the try so a failure at any point — the item write, the
  // re-validate, or regenerate — rolls the brand-new file back.
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, composeFile(fm, body));
    const data2 = readBacklog(repoRoot, cfg);
    if (data2.errors.length) throw new TrellisError(`created task is invalid: ${data2.errors.join("; ")}`, "invalid_backlog");
    writeArtifacts(repoRoot, cfg, data2);
    return { created: backlogObject(cfg, data2).tasks.find((t) => t.id === id) };
  } catch (e) {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

// move_task — active → completed/removed: move the file, update front-matter, and
// prepend the closeout note. Rolls back (restore source, remove target) on a
// validation failure.
export function moveTask(repoRoot, args = {}) {
  const to = args.to;
  if (to !== "completed" && to !== "removed") throw new TrellisError("`to` must be \"completed\" or \"removed\"");
  const date = args.date === undefined ? todayISO() : args.date;
  if (!isoDate(date)) throw new TrellisError("`date` must be an ISO date (YYYY-MM-DD)");
  const reason = to === "removed" ? oneLine(args.reason, "reason") : undefined;

  const { cfg } = loadClean(repoRoot);
  const id = assertId(args.id, cfg); // validate the id format before building any path
  const p = paths(repoRoot, cfg);
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
  // Ownership carries over from the active item automatically; allow an optional
  // override at close (historical from here — not re-validated against the roster).
  applyOwnershipOverride(fm, args);
  const heading = to === "completed" ? "Completed" : "Removed";
  const newBody = prependSection(body, heading, args.note ? oneLine(args.note, "note") : "");

  const targetDir = to === "completed" ? p.completedTasks : p.removed;
  const target = join(targetDir, `${id}.md`);
  // The move (write target, remove source) lives inside the try so a failure at any
  // point — including between the two writes — restores the source and undoes the
  // target. Restores are best-effort so the original error is never masked.
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, composeFile(fm, newBody));
    rmSync(src, { force: true });
    const data2 = readBacklog(repoRoot, cfg);
    if (data2.errors.length) throw new TrellisError(`move produced an invalid backlog: ${data2.errors.join("; ")}`, "invalid_backlog");
    writeArtifacts(repoRoot, cfg, data2);
    return { moved: backlogObject(cfg, data2).tasks.find((t) => t.id === id), counts: backlogObject(cfg, data2).counts };
  } catch (e) {
    try { writeFileSync(src, original); } catch { /* best-effort */ } // restore the source…
    try { rmSync(target, { force: true }); } catch { /* best-effort */ } // …and undo the target write
    throw e;
  }
}

// import — bring an existing backlog into this repo via a named profile or an
// inline mapping. The engine (src/import.mjs) does the resolve → write →
// regenerate → roll-back-on-any-failure; this adapter only resolves the mapping,
// runs it against the target, and maps a refused/failed import (summary.errors) to
// a TrellisError so the transport returns an isError result rather than a silent
// partial. DRY-RUN unless `apply: true` — mirroring the `trellis import` CLI's safe
// default for a bulk, multi-file operation.
export function importOp(repoRoot, args = {}) {
  if (typeof args.source !== "string" || !args.source.trim()) {
    throw new TrellisError("`source` is required (path to the backlog to import)");
  }
  const hasProfile = args.profile != null && String(args.profile).trim() !== "";
  const hasMapping = args.mapping != null;
  // Exactly one mapping source — a profile name or an inline mapping object.
  if (hasProfile === hasMapping) {
    throw new TrellisError("provide exactly one of `profile` (a built-in profile name) or `mapping` (an inline mapping object)");
  }
  let mapping;
  if (hasProfile) {
    const r = loadProfile(String(args.profile).trim());
    if (r.error) throw new TrellisError(r.error, "not_found");
    mapping = r.mapping;
  } else {
    if (typeof args.mapping !== "object" || Array.isArray(args.mapping)) throw new TrellisError("`mapping` must be an object");
    mapping = args.mapping;
  }
  // Relative source resolves against the target repo (you import a backlog that
  // lives in the repo being onboarded); an absolute path is used as-is.
  const src = args.source.trim();
  const source = isAbsolute(src) ? src : join(repoRoot, src);
  const dryRun = !args.apply;
  const { summary } = applyImport(repoRoot, source, mapping, { dryRun });
  if (summary.errors.length) throw new TrellisError(summary.errors.join("; "), "import_failed");
  return { ...summary, dryRun };
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
  import: importOp,
};
