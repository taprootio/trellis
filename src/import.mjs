// Trellis import engine (zero-dependency).
//
// Converts an existing backlog on a foreign schema into Trellis items, driven by a
// declarative, JSON-serializable mapping. Mirrors src/init.mjs: every entry point
// takes an explicit targetRoot/sourceRoot and holds no process-wide state, so the
// `trellis import` CLI and a future MCP import tool (TRL0022) share one
// implementation, and named source profiles (TRL0022) are just mapping objects of
// the same shape.
//
// Contracts (SPEC §4–§5, §8; TRL0021): the source tree is READ-ONLY (copy-out,
// never delete); ids are assigned fresh-sequentially from the target's nextId so an
// import is safe into a non-empty target; colliding source ids dedupe by
// construction and every depends_on is rewritten through the id map (an ambiguous
// or dangling reference is a hard error); a real run regenerates via the TRL0002
// core and ROLLS BACK on any failure, so the target is never left invalid or
// half-written.
//
// The mapping shape — see docs and test/fixtures for a worked example:
//   {
//     sources: { active|completed|removed: { dirs: [..], file: "*.md" } },
//     fields:  { title, id, priority, effort, milestone, summary, depends_on,
//                completed_on, removed_on, removed_reason: <extractor> },
//     remap:   { priority: {..}, milestone: {..} },   // case-insensitive keys
//     summary: { strategy: "firstSentence" | "title" },
//     defaults:{ removed_reason: ".." },
//   }
// An <extractor> is { from: "yaml", key } | { from:"inline"|"header", label }
//   | { from:"h1" } | { from:"filename", pattern? } | { from:"const", value },
// each optionally carrying { fallback: <extractor> } and { list: true }.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import {
  loadConfig,
  readBacklog,
  generateArtifacts,
  resolveEffort,
  nextId,
  parseFrontMatter,
  paths,
  composeFile,
} from "./backlog.mjs";

// Target subdir for each status; statuses are always processed in this fixed order
// (not the mapping's key order) so id assignment is deterministic.
const STATUS_DIRS = { active: "active", completed: join("completed", "tasks"), removed: "removed" };
const STATUS_ORDER = ["active", "completed", "removed"];

// ----------------------------------------------------------- small helpers
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// A trivial `*`-only glob → anchored RegExp (dependency-free; no `**`/`?`/classes).
function globToRe(glob) { return new RegExp("^" + String(glob).split("*").map(escRe).join(".*") + "$"); }

function firstMatch(text, re) { const m = text.match(re); return m ? m[1] : undefined; }

// `None` / `N/A` / `-` (and the empty string) mean "no dependencies"; otherwise
// split a `a, b; c` (or `[a, b]`) list into trimmed, non-empty tokens.
function asList(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s || /^(none|n\/a|-|—|\[\])$/i.test(s)) return [];
  return s.replace(/^\[|\]$/g, "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

// Normalize a date token to ISO `YYYY-MM-DD` (padding single-digit month/day), or
// null if it isn't a recognizable date — the caller turns null into a hard error
// rather than guessing a close date (SPEC §5.1 requires a valid ISO close date).
function toISO(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null; // reject impossible dates — fail loud, don't guess a close date
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ------------------------------------------------------------- extraction
// Locate one field in a source item via its declared extractor, falling back to a
// nested `fallback` extractor when the primary yields nothing. Returns a trimmed
// string (or the raw yaml value's type) or undefined. Pure over `ctx`.
function runExtractor(ex, ctx) {
  if (!ex || typeof ex !== "object") return undefined;
  let v;
  switch (ex.from) {
    case "const": v = ex.value; break;
    case "yaml": v = ctx.yaml[ex.key]; break;
    case "filename": v = ex.pattern ? matchGroup(ctx.basename, ex.pattern) : ctx.basename; break;
    case "h1": v = firstMatch(ctx.raw, /^[ \t]*#[ \t]+(.+)$/m); break;
    // `**Label:**` / `**Label**:` (colon optional, either side), value = rest of line.
    case "inline": v = firstMatch(ctx.raw, new RegExp(`^[ \\t]*\\*\\*[ \\t]*${escRe(ex.label)}[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?[ \\t]*(.+)$`, "m")); break;
    // A header line `Label: value` (won't match a `**Label:**` line — that starts with `*`).
    case "header": v = firstMatch(ctx.raw, new RegExp(`^[ \\t]*${escRe(ex.label)}[ \\t]*:[ \\t]*(.+)$`, "m")); break;
    default: return undefined; // unknown kind — surfaced by validateMapping
  }
  if (v == null || String(v).trim() === "") return ex.fallback ? runExtractor(ex.fallback, ctx) : undefined;
  return typeof v === "string" ? v.trim() : v;
}

function matchGroup(s, pattern) {
  let re;
  try { re = new RegExp(pattern); } catch { return undefined; }
  const m = String(s).match(re);
  return m ? (m[1] ?? m[0]) : undefined;
}

// Resolve a foreign enum to a configured one: a `remap` entry (case-insensitive
// key) wins, then a direct case-insensitive match against the allowed set;
// otherwise an actionable error (the §7.1 milestone collapse must be an explicit
// mapping decision, never a silent guess).
function resolveEnum(raw, remap, allowed, label) {
  if (raw == null || String(raw).trim() === "") return { error: `missing ${label}` };
  const s = String(raw).trim();
  let mapped = s;
  if (remap && typeof remap === "object") {
    const key = Object.keys(remap).find((k) => k.toLowerCase() === s.toLowerCase());
    if (key) mapped = remap[key];
  }
  const hit = allowed.find((a) => a.toLowerCase() === String(mapped).toLowerCase());
  if (hit) return { value: hit };
  return { error: `${label} "${s}" is not a configured ${label} (${allowed.join(", ")}) and has no \`remap.${label}\` entry` };
}

// First-sentence (or title) synthesis for a missing summary (SPEC §5.1: summary is
// required and feeds the README). Skips the H1, blank lines, and metadata-shaped
// lines (bold `**Field:**`, list bullets, short `Key: value` headers) so it lands
// on real prose, then takes that line's first sentence, single-lined. A heuristic —
// summary is descriptive, not correctness-critical — that fails safe to the title.
function synthSummary(body, title, strategy) {
  if (strategy === "title") return title;
  const isMeta = (l) => l.startsWith("**") || /^[-*+]\s/.test(l) || /^[A-Za-z][\w ()/-]{0,30}:\s+\S/.test(l);
  for (const line of body.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#") || isMeta(l)) continue;
    const m = l.match(/^(.+?[.!?])(\s|$)/);
    const s = (m ? m[1] : l).replace(/\s+/g, " ").trim();
    if (s) return s;
  }
  return title;
}

// Rebuild a source file's prose as a Trellis body: drop a leading YAML block and a
// leading H1 (foreign or ours), then re-head with the canonical `# <id> — <title>`.
// Faithful copy-out — the original prose (including any inline metadata lines) is
// preserved verbatim under the new heading; composeFile normalizes the trailing NL.
function buildBody(raw, newId, title) {
  let body = raw.replace(/\r\n/g, "\n");
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, ""); // strip front-matter if any
  body = body.replace(/^\s*#[ \t]+[^\n]*\n?/, "");   // strip a leading H1
  body = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return body ? `# ${newId} — ${title}\n\n${body}\n` : `# ${newId} — ${title}\n`;
}

// --------------------------------------------------------------- discovery
function listFiles(dir, re) {
  if (!existsSync(dir)) return null; // null = dir absent (a warning), [] = present-but-empty
  return readdirSync(dir)
    .filter((f) => re.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

// Gather every source item across the mapped status dirs, in a deterministic global
// order (status order, then path) so fresh-sequential ids are reproducible.
function discoverSources(sourceRoot, mapping, warnings) {
  const out = [];
  for (const status of STATUS_ORDER) {
    const spec = mapping.sources[status];
    if (!spec) continue;
    const re = globToRe(spec.file || "*.md");
    const hits = [];
    for (const d of spec.dirs) {
      const dir = join(sourceRoot, d);
      const files = listFiles(dir, re);
      if (files === null) { warnings.push(`source dir not found, skipped: ${d}`); continue; }
      for (const f of files) hits.push({ status, dir, file: join(dir, f), basename: f.replace(/\.[^.]+$/, ""), rel: relative(sourceRoot, join(dir, f)) });
    }
    hits.sort((a, b) => a.rel.localeCompare(b.rel));
    out.push(...hits);
  }
  return out;
}

// ------------------------------------------------------ mapping validation
function validateMapping(mapping) {
  const errors = [];
  if (!mapping || typeof mapping !== "object") return ["mapping must be an object"];
  if (!mapping.sources || typeof mapping.sources !== "object") errors.push("mapping.sources must be an object");
  else {
    const present = STATUS_ORDER.filter((s) => mapping.sources[s]);
    if (!present.length) errors.push("mapping.sources must define at least one of active/completed/removed");
    for (const s of present) {
      const spec = mapping.sources[s];
      if (!Array.isArray(spec.dirs) || !spec.dirs.length) errors.push(`mapping.sources.${s}.dirs must be a non-empty array`);
      if (spec.file != null && typeof spec.file !== "string") errors.push(`mapping.sources.${s}.file must be a string`);
    }
  }
  if (!mapping.fields || typeof mapping.fields !== "object") errors.push("mapping.fields must be an object");
  return errors;
}

// ----------------------------------------------------------------- plan
// Build the full import plan WITHOUT touching disk: resolve every field, assign
// fresh ids, rewrite dependencies, and collect per-item errors + warnings. Read
// access is limited to the source tree and the target's config/backlog.
export function planImport(targetRoot, sourceRoot, mapping) {
  // A factory (not a shared literal) so each early return gets its own arrays/objects
  // and results can never alias one another.
  const empty = () => ({ cfg: null, root: null, items: [], idMap: [], counts: { active: 0, completed: 0, removed: 0, total: 0 }, warnings: [], errors: [] });

  const mapErrors = validateMapping(mapping);
  if (mapErrors.length) return { ...empty(), errors: mapErrors };

  const { cfg, errors: cfgErrors } = loadConfig(targetRoot);
  if (cfgErrors.length) return { ...empty(), errors: [`target config: ${cfgErrors.join("; ")}`] };
  const root = cfg.tasksDir || "trellis";
  const p = paths(targetRoot, cfg);

  // The target must already be a Trellis repo — import emits items + regenerates,
  // it does not scaffold (that's `trellis init`; TRL0022 wires `init --import`).
  if (!existsSync(p.readme) || !existsSync(p.completedIndex) || !existsSync(p.removedIndex)) {
    return { ...empty(), cfg, root, errors: ["target is not an initialized Trellis backlog (missing generated indexes); run `trellis init` first"] };
  }
  const data = readBacklog(targetRoot, cfg);
  if (data.errors.length) return { ...empty(), cfg, root, errors: [`target backlog has errors; fix them before importing: ${data.errors.join("; ")}`] };

  const warnings = [];
  const sources = discoverSources(sourceRoot, mapping, warnings);
  if (!sources.length) warnings.push("no source items matched — check `sources.dirs` and the `file` pattern");

  // Fresh-sequential id allocation from the target's current nextId.
  const fields = mapping.fields;
  const idEx = fields.id || { from: "filename" };
  let n = Number(nextId(data.ids, cfg).slice(cfg.idPrefix.length));
  const fmtId = (num) => cfg.idPrefix + String(num).padStart(cfg.idWidth, "0");

  const errors = [];
  const items = [];
  const bySourceId = new Map(); // source id → [newId, …]; >1 ⇒ a collision (ambiguous for deps)

  for (const src of sources) {
    const raw = readFileSync(src.file, "utf8");
    const ctx = { raw, basename: src.basename, yaml: parseFrontMatter(raw, src.rel, []) || {} };
    const newId = fmtId(n++);
    const sourceId = String(runExtractor(idEx, ctx) ?? src.basename).trim();
    const at = bySourceId.get(sourceId) || []; at.push(newId); bySourceId.set(sourceId, at);

    const ierr = (m) => errors.push(`${src.rel}: ${m}`);
    const isActive = src.status === "active";

    const title = runExtractor(fields.title || { from: "h1" }, ctx);
    if (!title) ierr("could not derive a `title`");

    // Enums: active items must resolve (the core validates them); on closed items
    // the value is historical and not re-validated, so an unresolved one keeps the
    // raw source value and only warns (SPEC §5.1, §8.3).
    const resolveOrCarry = (raw0, remap, allowed, label) => {
      const r = resolveEnum(raw0, remap, allowed, label);
      if (!r.error) return r.value;
      if (isActive) { ierr(r.error); return undefined; }
      // Closed items: enums are historical and not re-validated (SPEC §5.1, §8.3).
      // Absence is normal for header-style legacy items, so a missing value just
      // drops to null; only a *present* value that didn't map is worth a warning.
      const has = raw0 != null && String(raw0).trim() !== "";
      if (has) warnings.push(`${src.rel}: ${label} "${String(raw0).trim()}" not mapped — kept as a historical value`);
      return has ? String(raw0).trim() : undefined;
    };
    const remap = mapping.remap || {};
    const priority = resolveOrCarry(runExtractor(fields.priority, ctx), remap.priority, cfg.priorities, "priority");
    const milestone = resolveOrCarry(runExtractor(fields.milestone, ctx), remap.milestone, cfg.milestones, "milestone");

    const rawEffort = runExtractor(fields.effort, ctx);
    const eff = resolveEffort(cfg, rawEffort);
    let effort;
    if (!eff.error) effort = eff.value;
    else if (isActive) ierr(`effort: ${eff.error}`);
    else {
      const has = rawEffort != null && String(rawEffort).trim() !== "";
      if (has) warnings.push(`${src.rel}: effort "${rawEffort}" not resolved — kept as a historical value`);
      effort = has ? rawEffort : undefined;
    }

    const body = buildBody(raw, newId, title || newId);
    let summary = runExtractor(fields.summary, ctx);
    if (summary == null || String(summary).trim() === "") summary = synthSummary(body, title || newId, (mapping.summary && mapping.summary.strategy) || "firstSentence");
    summary = String(summary).replace(/\s+/g, " ").trim();

    const srcDeps = fields.depends_on ? asList(runExtractor({ ...fields.depends_on, list: true }, ctx)) : [];

    const fm = { id: newId, title: title || newId, status: src.status, milestone, priority, effort, depends_on: [], summary };
    if (src.status === "completed") {
      const iso = toISO(runExtractor(fields.completed_on, ctx));
      if (!iso) ierr("could not parse a `completed_on` date (expected YYYY-MM-DD)"); else fm.completed_on = iso;
    } else if (src.status === "removed") {
      const iso = toISO(runExtractor(fields.removed_on, ctx));
      if (!iso) ierr("could not parse a `removed_on` date (expected YYYY-MM-DD)"); else fm.removed_on = iso;
      const reason = runExtractor(fields.removed_reason, ctx) || (mapping.defaults && mapping.defaults.removed_reason);
      if (!reason) ierr("missing `removed_reason` (no field value and no `defaults.removed_reason`)"); else fm.removed_reason = String(reason).trim();
    }

    items.push({ sourceRel: src.rel, status: src.status, sourceId, newId, srcDeps, fm, body, targetRel: `${root}/${STATUS_DIRS[src.status]}/${newId}.md` });
  }

  // Rewrite depends_on through the id map now that every source id is known. A dep
  // on a collided source id is ambiguous, and one with no match is dangling — both
  // hard errors (the sharp edge from the Risk; never point at the wrong task).
  for (const it of items) {
    const out = [];
    for (const dep of it.srcDeps) {
      const hits = bySourceId.get(dep);
      if (!hits) errors.push(`${it.sourceRel}: depends_on "${dep}" does not resolve to any imported item`);
      else if (hits.length > 1) errors.push(`${it.sourceRel}: depends_on "${dep}" is ambiguous — source id maps to ${hits.length} items (${hits.join(", ")})`);
      else out.push(hits[0]);
    }
    it.fm.depends_on = out;
  }

  const counts = { active: 0, completed: 0, removed: 0, total: items.length };
  for (const it of items) counts[it.status]++;
  const idMap = items.map((it) => ({ sourceFile: it.sourceRel, sourceId: it.sourceId, newId: it.newId, status: it.status }));
  return { cfg, root, items, idMap, counts, warnings, errors };
}

// The four generated-artifact paths, repo-relative under the backlog root.
function generatedRels(root) {
  return [`${root}/README.md`, `${root}/completed/index.md`, `${root}/removed/index.md`, `${root}/backlog.json`];
}

// ---------------------------------------------------------------- apply
// Execute the plan: write the item files, then regenerate via the TRL0002 core so
// the backlog is --check-green. On ANY failure, roll back (remove the new items,
// restore the artifacts) so a rejected import leaves the target exactly as it was.
// `dryRun` returns the plan without writing. The source tree is never written.
export function applyImport(targetRoot, sourceRoot, mapping, { dryRun = false } = {}) {
  const summary = { imported: [], created: [], generated: [], idMap: [], counts: null, root: null, warnings: [], errors: [] };
  const plan = planImport(targetRoot, sourceRoot, mapping);
  summary.idMap = plan.idMap;
  summary.counts = plan.counts;
  summary.root = plan.root;
  summary.warnings = plan.warnings;
  if (plan.errors.length) { summary.errors.push(...plan.errors); return { summary }; }

  if (dryRun) {
    summary.imported = plan.items.map((i) => i.newId);
    summary.created = plan.items.map((i) => i.targetRel);
    summary.generated = generatedRels(plan.root);
    return { summary };
  }

  const p = paths(targetRoot, plan.cfg);
  const artifacts = [p.readme, p.completedIndex, p.removedIndex, p.backlogJson];
  const priorArtifacts = artifacts.map((path) => ({ path, before: existsSync(path) ? readFileSync(path, "utf8") : null }));
  const written = [];
  try {
    for (const it of plan.items) {
      const abs = join(targetRoot, it.targetRel);
      // Fresh ids never collide with existing items; a pre-existing target file
      // would mean a corrupt plan, so refuse rather than clobber.
      if (existsSync(abs)) throw new Error(`refusing to overwrite existing ${it.targetRel}`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, composeFile(it.fm, it.body));
      written.push(abs);
    }
    const data = readBacklog(targetRoot, plan.cfg);
    if (data.errors.length) throw new Error(`imported backlog is invalid: ${data.errors.join("; ")}`);
    const { files, errors } = generateArtifacts(targetRoot, plan.cfg, data);
    if (errors.length) throw new Error(`generate failed: ${errors.join("; ")}`);
    for (const f of files) writeFileSync(f.path, f.content);

    summary.imported = plan.items.map((i) => i.newId);
    summary.created = plan.items.map((i) => i.targetRel);
    summary.generated = files.map((f) => relative(targetRoot, f.path));
    return { summary };
  } catch (e) {
    for (const abs of written) { try { rmSync(abs, { force: true }); } catch { /* best-effort */ } }
    for (const a of priorArtifacts) {
      try { a.before === null ? rmSync(a.path, { force: true }) : writeFileSync(a.path, a.before); } catch { /* best-effort */ }
    }
    summary.errors.push(e.message);
    return { summary };
  }
}
