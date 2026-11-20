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

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync, renameSync, copyFileSync,
  statSync, fchmodSync, unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, dirname, basename, isAbsolute } from "node:path";
import {
  loadConfig,
  readBacklog,
  generateArtifacts,
  buildBacklogJson,
  resolveEffort,
  findActiveMember,
  isValidHandle,
  nextId,
  parseFrontMatter,
  paths,
  composeFile,
  activeItemErrors,
  isLocalMode,
  validateLocal,
} from "./backlog.mjs";
import { applyImport, ImportRefused } from "./import.mjs";
import { loadProfile } from "./profiles.mjs";
import { deriveTaskHistory, deriveAllHistory, HistoryError } from "./history.mjs";
import { outputPreflight, writeArtifactFiles, makeDirs, removeCreatedDirs, stageFile } from "./local-output.mjs";

// Kept as an export of this module for its callers and tests; the owner is local-output.
export { stageFile };
import { LedgerError, unsafeText, claim, preview, checkLayout, refuseSymlinkedArtifacts, artifactPaths } from "./ledger.mjs";

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
// `guard(cfg)` runs before the task tree is read (ledger-mode layout refusals).
function loadClean(repoRoot, guard) {
  const cfg = loadCfg(repoRoot);
  if (guard) guard(cfg);
  const data = readBacklog(repoRoot, cfg);
  if (data.errors.length) {
    throw new TrellisError(`backlog has errors; fix before mutating: ${data.errors.join("; ")}`, "invalid_backlog");
  }
  return { cfg, data };
}

// The backlog.json shape as an object — parsed from the core's serializer so the
// tool result is byte-for-byte the same contract clients read from disk.
function backlogObject(cfg, data, opts) {
  return JSON.parse(buildBacklogJson(cfg, data, opts));
}

// ------------------------------------------------------------ id ledger
// Ledger-mode repos (TRL0037) hand out ids through src/ledger.mjs, never nextId.
const isLedgerMode = (cfg) => cfg.idAllocation === "ledger";

// A refusal (exit 2) is a bad request; anything else keeps the ledger's own code.
function ledgerCall(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LedgerError) throw new TrellisError(e.message, e.exitCode === 2 ? "invalid_request" : e.code);
    throw e;
  }
}

// The preview `next_id`, `list_tasks` and `regenerate` report in ledger mode; null
// in scan mode so callers keep the scan value.
const ledgerPreview = (repoRoot, cfg) => (isLedgerMode(cfg) ? preview(repoRoot, cfg) : null);

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

// A historical assignee skips roster membership (closed items are historical, SPEC
// §8.3) but MUST still be a valid handle, so it round-trips through the inline
// serializer — a comma/bracket would corrupt the `collaborators` array (SPEC §7.2).
function assertHandle(v) {
  if (!isValidHandle(v)) throw new TrellisError(`invalid handle "${v}" (use letters, digits, ., _, -)`, "invalid_request");
  return v.trim();
}

// Apply an optional owner/collaborators override when closing a task. On close the
// values are historical (SPEC §8.3) — not re-validated against the roster — so this
// only shapes the front-matter (a now-inactive assignee, or who actually did it, is
// allowed); passing null/empty clears the field.
function applyOwnershipOverride(fm, args) {
  if (args.owner !== undefined) {
    if (args.owner === null || String(args.owner).trim() === "") delete fm.owner;
    else fm.owner = assertHandle(oneLine(args.owner, "owner"));
  }
  if (args.collaborators !== undefined) {
    if (!Array.isArray(args.collaborators) || args.collaborators.some((c) => typeof c !== "string")) {
      throw new TrellisError("`collaborators` must be a list of roster handles");
    }
    const cleaned = [...new Set(args.collaborators.map((c) => c.trim()).filter(Boolean))].map(assertHandle);
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
// Refuses a bad output before a claim or a write: in local mode a leftover marker,
// a bad `.generated/` or output path, and (inside a git work tree) an output that
// is unignored or tracked; in ledger mode a symlinked or non-regular artifact.
function guardOutputs(repoRoot, cfg) {
  ledgerCall(() => {
    outputPreflight(repoRoot, cfg);
    if (isLedgerMode(cfg)) refuseSymlinkedArtifacts(artifactPaths(repoRoot, cfg));
  });
}

// Write any stale artifact; return the repo-relative paths that changed. Pure
// w.r.t. the item files — only the generated artifacts are touched (the four
// committed files, or the four under `.generated/` in local mode).
// `hooks` are test seams (see writeArtifactsStaged).
// `pv` is the operation's one ledger preview, so the file and the reply always agree.
function writeArtifacts(repoRoot, cfg, data, hooks = {}, pv = ledgerPreview(repoRoot, cfg)) {
  // Refuse a bad artifact before anything is rendered.
  if (isLedgerMode(cfg)) ledgerCall(() => refuseSymlinkedArtifacts(artifactPaths(repoRoot, cfg)));
  // Local mode publishes the ledger preview in its uncommitted backlog.json.
  const nextIdOverride = isLocalMode(cfg) && pv ? pv.nextId : undefined;
  const { files, nextId: next, errors } = generateArtifacts(repoRoot, cfg, data, { nextIdOverride });
  if (errors.length) throw new TrellisError(`generate failed: ${errors.join("; ")}`, "generate_failed");
  if (isLedgerMode(cfg)) return writeArtifactsStaged(repoRoot, files, next, hooks);
  // The shared writer snapshots prior bytes, so a mid-loop write failure (ENOSPC/EACCES)
  // restores every artifact — honouring the Risk's "never left … with stale generated files."
  const changed = writeArtifactFiles(files).map((path) => relative(repoRoot, path));
  return { changed, nextId: next };
}

// Ledger-mode artifact write (TRL0037). A claimed id cannot be released, so the
// write must either land whole or leave every artifact as it was. Each new file is
// staged beside its target, each original is copied to a backup, and one rename
// installs the new bytes, so an artifact is never missing. Any failure before the
// commit point (the last artifact rename) puts every backup back and removes an
// artifact that had no original. After it, a failed backup cleanup is only a
// warning: the item and its generated entries are already consistent.
// Test seams: `hooks.afterArtifactRename(path, n)` and `hooks.removeBackup(path)`.
function writeArtifactsStaged(repoRoot, files, next, hooks) {
  ledgerCall(() => refuseSymlinkedArtifacts(files.map((f) => f.path)));
  const plan = [];
  for (const f of files) {
    const dest = f.path;
    const exists = existsSync(dest);
    if ((exists ? readFileSync(dest, "utf8") : null) !== f.content) plan.push({ f, dest, exists, temp: null, backup: null });
  }
  const installed = [];
  // Local mode stages into `.generated/`, which may not exist yet; a rollback
  // removes it again when this call made it and it is empty.
  const created = [];
  try {
    for (const dir of new Set(files.map((f) => dirname(f.path)))) makeDirs(dir, created);
    for (const e of plan) {
      const mode = e.exists ? statSync(e.dest).mode & 0o7777 : 0o666 & ~process.umask();
      e.temp = stageFile(e.dest, "tmp", e.f.content, mode);
    }
    for (const e of plan) {
      if (e.exists) e.backup = stageFile(e.dest, "bak", readFileSync(e.dest), statSync(e.dest).mode & 0o7777);
      renameSync(e.temp, e.dest);
      e.temp = null;
      installed.push(e);
      if (hooks.afterArtifactRename) hooks.afterArtifactRename(e.dest, installed.length - 1);
    }
  } catch (err) {
    // A backup that cannot be put back is the only copy of the original, so it is
    // kept and named in the error instead of being deleted.
    const kept = [];
    for (const e of installed.reverse()) {
      try {
        if (e.backup) renameSync(e.backup, e.dest); else rmSync(e.dest, { force: true });
      } catch {
        if (e.backup) { kept.push(`${e.backup} (original of ${e.dest})`); e.backup = null; }
      }
    }
    for (const e of plan) {
      for (const leftover of [e.temp, e.backup]) {
        if (leftover) { try { rmSync(leftover, { force: true }); } catch { /* best-effort */ } }
      }
    }
    removeCreatedDirs(created);
    if (kept.length) {
      throw new TrellisError(`${err.message}; could not restore every artifact, backups kept at: ${kept.join(", ")}`, "generate_failed");
    }
    throw err;
  }
  const warnings = [];
  for (const e of plan) {
    if (!e.backup) continue;
    try {
      if (hooks.removeBackup) hooks.removeBackup(e.backup); else rmSync(e.backup, { force: true });
    } catch (err) {
      warnings.push(`could not remove the backup ${e.backup}: ${err.message}`);
    }
  }
  return { changed: plan.map((e) => relative(repoRoot, e.f.path)), nextId: next, warnings };
}

// ================================================================= tools

// list_tasks — the backlog header + tasks, optionally filtered. counts/nextId
// always describe the whole backlog; only `tasks` is narrowed by the filters.
export function listTasks(repoRoot, { status, milestone } = {}) {
  const cfg = loadCfg(repoRoot);
  const data = readBacklog(repoRoot, cfg);
  const pv = ledgerPreview(repoRoot, cfg);
  const backlog = backlogObject(cfg, data, pv ? { nextIdOverride: pv.nextId } : undefined);
  let tasks = backlog.tasks;
  if (status) tasks = tasks.filter((t) => t.status === status);
  if (milestone) tasks = tasks.filter((t) => t.milestone === milestone);
  return { ...backlog, tasks, ...(pv ? { nextIdNote: pv.note } : {}) };
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

// next_id — the id a new task would receive. In ledger mode it is a preview only:
// it never claims, and another writer may take the id first.
export function nextIdOp(repoRoot) {
  const cfg = loadCfg(repoRoot);
  const pv = ledgerPreview(repoRoot, cfg);
  if (pv) return { nextId: pv.nextId, preview: true, note: pv.note };
  const data = readBacklog(repoRoot, cfg);
  return { nextId: nextId(data.ids, cfg) };
}

// validate — config + item + marker validity, read-only. Never throws on backlog
// content; reporting those errors is the point. (`regenerate` owns staleness.)
export function validateOp(repoRoot) {
  const { cfg, warnings, errors: cfgErrors } = loadConfig(repoRoot);
  if (cfgErrors.length) return { ok: false, errors: cfgErrors, warnings };
  // Local mode shares one validator with the CLI `check`, so they cannot disagree.
  if (isLocalMode(cfg)) {
    const { errors } = validateLocal(repoRoot, cfg);
    return { ok: errors.length === 0, errors, warnings };
  }
  const data = readBacklog(repoRoot, cfg);
  const gen = generateArtifacts(repoRoot, cfg, data); // computes only; the CLI writes
  const errors = [...data.errors, ...gen.errors];
  return { ok: errors.length === 0, errors, warnings };
}

// regenerate — rewrite any stale artifact. Refuses on an invalid backlog rather
// than generating from bad input.
export function regenerateOp(repoRoot) {
  const { cfg, data } = loadClean(repoRoot);
  guardOutputs(repoRoot, cfg);
  // In committed mode the files on disk keep the scan value; only the reply carries the ledger preview.
  const pv = ledgerPreview(repoRoot, cfg);
  const { changed, nextId: next, warnings } = writeArtifacts(repoRoot, cfg, data, {}, pv);
  const counts = backlogObject(cfg, data).counts;
  if (pv) return { changed, nextId: pv.nextId, note: pv.note, counts, ...(warnings && warnings.length ? { warnings } : {}) };
  return { changed, nextId: next, counts };
}

// claim_id — claim the next id from the local id ledger (ledger mode only). The id
// stays claimed even if the caller never writes an item for it.
export function claimIdOp(repoRoot, { title } = {}) {
  const cfg = loadCfg(repoRoot);
  const out = ledgerCall(() => claim(repoRoot, cfg, { title }));
  return { id: out.id, tip: out.tip };
}

// create_task — assign the next id, write active/<id>.md, then re-read + validate
// + regenerate. Rolls back (removes the new file) if the result does not validate.
// `hooks` are test seams: `afterOpen({fd, file})` plus the writeArtifacts hooks.
export function createTask(repoRoot, args = {}, hooks = {}) {
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

  // In ledger mode the layout guard runs before the task tree is read, so an
  // unsupported layout is `invalid_request` even when an item in it is malformed.
  const { cfg, data } = loadClean(repoRoot, (c) => { if (isLedgerMode(c)) ledgerCall(() => checkLayout(repoRoot, c)); });
  const ledgerMode = isLedgerMode(cfg);
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

  // A claimed id is never released, so in ledger mode every input the re-read would
  // reject is checked before claiming, not after.
  if (ledgerMode) {
    for (const [field, value] of [["title", title], ["summary", summary], ["milestone", milestone], ["priority", priority], ["owner", owner]]) {
      if (value !== undefined && unsafeText(value)) throw new TrellisError(`\`${field}\` must be a single line with no control or line-separator characters`, "invalid_request");
    }
    for (const d of depends_on) {
      if (!data.ids.has(d)) throw new TrellisError(`depends_on ${d} is not a known task id`, "invalid_request");
    }
    if (!cfg.milestones.includes(milestone)) throw new TrellisError(`milestone must be one of ${cfg.milestones.join(", ")}`, "invalid_request");
    if (!cfg.priorities.includes(priority)) throw new TrellisError(`priority must be one of ${cfg.priorities.join(", ")}`, "invalid_request");
  }
  // Compose and re-parse the item as the re-read will, with a stand-in id of the
  // right shape, so a value that does not survive the round trip fails before the claim.
  if (ledgerMode) {
    const probe = cfg.idPrefix + "9".repeat(cfg.idWidth);
    const probeFm = { id: probe, title, status: "active", milestone, priority, effort: effort.value, depends_on, summary };
    if (owner) probeFm.owner = owner;
    if (collaborators.length) probeFm.collaborators = collaborators;
    const parseErrors = [];
    const parsed = parseFrontMatter(composeFile(probeFm, ""), "new item", parseErrors);
    const problems = parsed ? [...parseErrors, ...activeItemErrors(cfg, data, { ...parsed, _file: `${probe}.md` })] : parseErrors;
    if (problems.length) throw new TrellisError(`the new item would not validate: ${problems.join("; ")}`, "invalid_request");
  }
  // A bad output (a symlink, or in local mode a leftover marker or an unignored or
  // tracked output) is refused by the write, so it must fail before the claim too.
  guardOutputs(repoRoot, cfg);
  // Ledger mode claims the id, and never falls back to the scan: a fresh clone
  // would hand out an id another worktree holds. The claim is never undone.
  const id = ledgerMode ? ledgerCall(() => claim(repoRoot, cfg, { title })).id : nextId(data.ids, cfg);
  const fm = { id, title, status: "active", milestone, priority, effort: effort.value, depends_on, summary };
  if (owner) fm.owner = owner;
  if (collaborators.length) fm.collaborators = collaborators;
  const body = args.body ? args.body : scaffoldBody(id, title);
  const file = join(paths(repoRoot, cfg).active, `${id}.md`);

  // The write lives inside the try so a failure at any point — the item write, the
  // re-validate, or regenerate — rolls the brand-new file back. Ledger mode creates
  // the file exclusively and removes it only if this call created it, so an existing
  // item (even one a case-insensitive filesystem aliases) is never touched.
  let fd;
  let owned = !ledgerMode;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (ledgerMode) {
      try {
        fd = openSync(file, "wx");
      } catch (e) {
        if (e.code === "EEXIST") throw new TrellisError(`${id} already has an item file; the id stays claimed`, "conflict");
        throw e;
      }
      owned = true;
      if (hooks.afterOpen) hooks.afterOpen({ fd, file });
      writeFileSync(fd, composeFile(fm, body));
      closeSync(fd);
      fd = undefined;
    } else {
      writeFileSync(file, composeFile(fm, body));
    }
    const data2 = readBacklog(repoRoot, cfg);
    if (data2.errors.length) throw new TrellisError(`created task is invalid: ${data2.errors.join("; ")}`, "invalid_backlog");
    const { warnings } = writeArtifacts(repoRoot, cfg, data2, hooks);
    return { created: backlogObject(cfg, data2).tasks.find((t) => t.id === id), ...(warnings && warnings.length ? { warnings } : {}) };
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
    if (owned) { try { rmSync(file, { force: true }); } catch { /* best-effort */ } }
    throw e;
  }
}

// move_task — active → completed/removed: move the file, update front-matter, and
// prepend the closeout note. Rolls back (restore source, remove target) on a
// validation failure.
export function moveTask(repoRoot, args = {}, hooks = {}) {
  const to = args.to;
  if (to !== "completed" && to !== "removed") throw new TrellisError("`to` must be \"completed\" or \"removed\"");
  const date = args.date === undefined ? todayISO() : args.date;
  if (!isoDate(date)) throw new TrellisError("`date` must be an ISO date (YYYY-MM-DD)");
  const reason = to === "removed" ? oneLine(args.reason, "reason") : undefined;

  const { cfg } = loadClean(repoRoot);
  const id = assertId(args.id, cfg); // validate the id format before building any path
  // A bad output is refused before the move touches any file.
  guardOutputs(repoRoot, cfg);
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
    const { warnings } = writeArtifacts(repoRoot, cfg, data2, hooks);
    return { moved: backlogObject(cfg, data2).tasks.find((t) => t.id === id), counts: backlogObject(cfg, data2).counts, ...(warnings && warnings.length ? { warnings } : {}) };
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
  if (args.idFloor != null && (!Number.isInteger(args.idFloor) || args.idFloor < 0)) throw new TrellisError("`idFloor` must be a non-negative integer");
  const dryRun = !args.apply;
  let summary;
  try {
    ({ summary } = applyImport(repoRoot, source, mapping, { dryRun, preserveIds: args.preserveIds === true, idFloor: args.idFloor }));
  } catch (e) {
    if (e instanceof ImportRefused) throw new TrellisError(e.message, "invalid_request");
    throw e;
  }
  if (summary.errors.length) throw new TrellisError(summary.errors.join("; "), "import_failed");
  return { ...summary, dryRun };
}

// history — read-only git-derived task history (SPEC §8.4). By id → { id, entries };
// omit id → { generated, tasks } keyed by id (the same shape `trellis history --write`
// materializes, so a client reads the tool result and the file identically). Each
// entry is { id, commit, date, author, subject, reason }, newest-first. NEVER writes
// and is NOT part of `--check` — history is volatile and git is authoritative. Uses
// loadCfg (not loadClean): like get_task/list_tasks it is a tolerant read, and history
// is a forensic tool that should work even on a backlog that doesn't fully validate.
// The deriver's HistoryError (no git, not a work tree, bad/unknown id) maps to a
// TrellisError so the transport returns an isError result, not a stack trace.
export function historyOp(repoRoot, { id } = {}) {
  const cfg = loadCfg(repoRoot);
  try {
    if (id !== undefined && id !== null && String(id).trim() !== "") {
      return deriveTaskHistory(repoRoot, cfg, id);
    }
    return deriveAllHistory(repoRoot, cfg);
  } catch (e) {
    if (e instanceof HistoryError) throw new TrellisError(e.message, e.code);
    throw e;
  }
}

// Dispatch table for the transport: tool name → (repoRoot, args) → result.
export const OPS = {
  list_tasks: listTasks,
  get_task: getTask,
  next_id: nextIdOp,
  claim_id: claimIdOp,
  create_task: createTask,
  move_task: moveTask,
  validate: validateOp,
  regenerate: regenerateOp,
  import: importOp,
  history: historyOp,
};
