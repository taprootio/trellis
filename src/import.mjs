// Trellis import engine (zero-dependency).
//
// Converts an existing backlog on a foreign schema into Trellis items, driven by a
// declarative, JSON-serializable mapping. Mirrors src/init.mjs: every entry point
// takes an explicit targetRoot/sourceRoot and holds no process-wide state, so the
// `trellis import` CLI, the MCP `import` tool, and `init --import` share one
// implementation, and named source profiles (src/profiles.mjs) are just mapping
// objects of the same shape.
//
// Contracts (SPEC §4–§5, §8; TRL0021): the source tree is READ-ONLY (copy-out,
// never delete); ids are assigned fresh-sequentially from the target's nextId so an
// import is safe into a non-empty target; colliding source ids dedupe by
// construction and every depends_on is rewritten through the id map (an ambiguous
// or dangling reference is a hard error); a real run regenerates via the TRL0002
// core and ROLLS BACK on any failure, so the target is never left invalid or
// half-written.
//
// The mapping shape (documented in full in docs/import.md, with the built-in
// profiles/ as worked examples):
//   {
//     sources: { active|completed|removed: { dirs: [..], file: "*.md" } },
//     fields:  { title, id, priority, effort, milestone, summary, depends_on,
//                owner, collaborators, completed_on, removed_on, removed_reason: <extractor> },
//     remap:   { priority: {..}, milestone: {..}, owner: {..} },   // case-insensitive keys
//     summary: { strategy: "firstSentence" | "title" },
//     defaults:{ milestone, priority, effort, owner, removed_reason },  // used when the source lacks a value
//   }
// `remap.owner` maps a source assignee to a roster handle (SPEC §7.2) and applies to
// both `owner` and `collaborators`; `defaults.owner` fills an unresolved owner on
// active items only. An owner that resolves to no active member never invents one —
// active items drop to unassigned; closed items keep a valid historical handle (after
// remap) and drop a non-handle value that wouldn't round-trip.
// `defaults` chiefly fills the historical metadata that header-style legacy closed
// items lack but the schema still requires on completed/removed items (SPEC §5.1).
// An <extractor> is { from: "yaml", key } | { from:"inline"|"header", label }
//   | { from:"h1" } | { from:"filename", pattern? } | { from:"const", value },
// each optionally carrying { fallback: <extractor> } and { list: true }.
// The `title` field additionally honours { stripIdPrefix: true }: a leading token equal
// to the item's source id (plus an optional `. : - – —` and whitespace) is dropped from
// the stored title (TRL0029); it is set on the numeric-prefix profiles, off elsewhere.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, relative, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadConfig,
  readBacklog,
  generateArtifacts,
  resolveEffort,
  findMember,
  isValidHandle,
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
// null if it isn't a real calendar date — the caller turns null into a hard error
// rather than guessing a close date (SPEC §5.1 requires a valid ISO close date).
// A UTC round-trip rejects impossible dates (month 13, day 0, Feb 31, …): an
// out-of-range component rolls Date over to a different y/m/d than we put in.
function toISO(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const dt = new Date(Date.UTC(y, month - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Most-recent commit author-date (YYYY-MM-DD) for a source path, read against the
// source repo — the git-commit-date fallback for a legacy close-date with no header
// (SPEC §5.1 requires an ISO date; many legacy closed items have none). Import-time
// ONLY: git lives here in the importer, never in the generator/`--check` (SPEC §8.4),
// mirroring src/history.mjs. Returns null on ANY failure (no git on PATH, not a repo,
// an unborn HEAD, a shallow clone missing the commit, or a path never committed) so
// the caller degrades to the next fallback instead of throwing. `--follow` tracks the
// date across renames (e.g. a legacy active→completed move). No shell; arg array only.
function gitCommitDate(repoRoot, relPath) {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "log", "-1", "--follow", "--format=%ad", "--date=short", "--", relPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    return toISO(out); // "" (path not committed) or a bad value → null
  } catch {
    return null;
  }
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

// Drop a leading source-id token from an imported title (TRL0029). When `enabled` and
// the title begins with the item's OWN source id followed by a separator — whitespace,
// optionally around a single `. : - – —` — strip that token, so a foreign
// "001 README Truth Pass" reads as "README Truth Pass". Conservative by construction:
// the separator's trailing whitespace is REQUIRED, so the matched run is the whole id
// plus a real break — id "04" never bites into "047 Foo", "001README" (no break) is
// left intact, and "001 .NET" keeps its dot. Only the item's resolved source id is
// matched, so a genuinely number-leading title ("2024 Roadmap" under a different id) is
// never touched; a title that is nothing but the id is returned unchanged, never blanked.
function stripLeadingId(title, sourceId, enabled) {
  if (!enabled || !title) return title;
  const id = String(sourceId == null ? "" : sourceId).trim();
  if (!id) return title;
  const stripped = title.replace(new RegExp(`^${escRe(id)}[ \\t]*[.:–—-]?[ \\t]+`), "").trim();
  return stripped || title;
}

// Case-insensitive remap lookup → the mapped value (trimmed), or the input unchanged.
// Shared by enum resolution (priority/milestone) and assignee resolution (owner/
// collaborators), so all three honour `remap.<field>` the same way.
function remapLookup(table, value) {
  const s = String(value).trim();
  if (table && typeof table === "object") {
    const key = Object.keys(table).find((k) => k.toLowerCase() === s.toLowerCase());
    if (key) return String(table[key]).trim();
  }
  return s;
}

// Resolve a foreign enum to a configured one: a `remap` entry (case-insensitive
// key) wins, then a direct case-insensitive match against the allowed set;
// otherwise an actionable error (the §7.1 milestone collapse must be an explicit
// mapping decision, never a silent guess).
function resolveEnum(raw, remap, allowed, label) {
  if (raw == null || String(raw).trim() === "") return { error: `missing ${label}` };
  const s = String(raw).trim();
  const mapped = remapLookup(remap, s);
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
      else for (const d of spec.dirs) {
        // Source dirs must stay inside sourceRoot — reject absolute paths and any
        // `..` segment so a mapping can't read outside the tree it was pointed at.
        if (typeof d !== "string" || !d.trim()) errors.push(`mapping.sources.${s}.dirs entries must be non-empty strings`);
        else if (isAbsolute(d) || d.split(/[/\\]/).includes("..")) errors.push(`mapping.sources.${s}.dirs entry "${d}" must be a relative path within the source (no absolute path or ".." segments)`);
      }
      if (spec.file != null && typeof spec.file !== "string") errors.push(`mapping.sources.${s}.file must be a string`);
    }
  }
  if (!mapping.fields || typeof mapping.fields !== "object") errors.push("mapping.fields must be an object");
  if (mapping.defaults != null && (typeof mapping.defaults !== "object" || Array.isArray(mapping.defaults))) errors.push("mapping.defaults must be an object when present");
  return errors;
}

// ----------------------------------------------------------------- plan
// Build the full import plan WITHOUT touching disk: resolve every field, assign
// fresh ids, rewrite dependencies, and collect per-item errors + warnings. Read
// access is limited to the source tree and the target's config/backlog.
export function planImport(targetRoot, sourceRoot, mapping, opts = {}) {
  // A factory (not a shared literal) so each early return gets its own arrays/objects
  // and results can never alias one another.
  const empty = () => ({ cfg: null, root: null, items: [], idMap: [], counts: { active: 0, completed: 0, removed: 0, total: 0 }, provenance: { gitDated: 0, dateDefaulted: 0, effortEstimated: 0 }, warnings: [], errors: [] });

  const mapErrors = validateMapping(mapping);
  if (mapErrors.length) return { ...empty(), errors: mapErrors };

  const { cfg, errors: cfgErrors } = loadConfig(targetRoot);
  if (cfgErrors.length) return { ...empty(), errors: [`target config: ${cfgErrors.join("; ")}`] };
  const root = cfg.tasksDir || "trellis";
  const p = paths(targetRoot, cfg);

  // The target must already be a Trellis repo — import emits items + regenerates,
  // it does not scaffold (that's `trellis init`, or the `init --import` on-ramp
  // that scaffolds first, then calls this).
  if (!existsSync(p.readme) || !existsSync(p.completedIndex) || !existsSync(p.removedIndex)) {
    return { ...empty(), cfg, root, errors: ["target is not an initialized Trellis backlog (missing generated indexes); run `ai-trellis init` first"] };
  }
  const data = readBacklog(targetRoot, cfg);
  if (data.errors.length) return { ...empty(), cfg, root, errors: [`target backlog has errors; fix them before importing: ${data.errors.join("; ")}`] };
  const roster = data.roster; // resolve owners/collaborators against the target roster (SPEC §7.2)

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
  // Provenance of inferred values, surfaced in the import summary (not in the items —
  // volatile git data stays out of the gated files, SPEC §8.4). `gitDate` is injected
  // in tests; in production it reads the source repo's git (import-time only).
  const provenance = { gitDated: 0, dateDefaulted: 0, effortEstimated: 0 };
  const gitDate = opts.gitDate || ((rel) => gitCommitDate(sourceRoot, rel));
  const bySourceId = new Map(); // source id → [newId, …]; >1 ⇒ a collision (ambiguous for deps)

  for (const src of sources) {
    const raw = readFileSync(src.file, "utf8");
    const ctx = { raw, basename: src.basename, yaml: parseFrontMatter(raw, src.rel, []) || {} };
    const newId = fmtId(n++);
    const sourceId = String(runExtractor(idEx, ctx) ?? src.basename).trim();
    const at = bySourceId.get(sourceId) || []; at.push(newId); bySourceId.set(sourceId, at);

    const ierr = (m) => errors.push(`${src.rel}: ${m}`);
    const isActive = src.status === "active";

    const titleEx = fields.title || { from: "h1" };
    const title = stripLeadingId(runExtractor(titleEx, ctx), sourceId, titleEx.stripIdPrefix === true);
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
    // `mapping.defaults` supplies a value when the source has none — chiefly for the
    // historical metadata that header-style legacy closed items lack but the schema
    // still requires (SPEC §5.1). A defaulted value is treated like any extracted
    // one (validated for active items, carried for closed).
    const defaults = mapping.defaults || {};
    const withDefault = (v, field) => (v != null && String(v).trim() !== "" ? v : defaults[field]);
    const priority = resolveOrCarry(withDefault(runExtractor(fields.priority, ctx), "priority"), remap.priority, cfg.priorities, "priority");
    const milestone = resolveOrCarry(withDefault(runExtractor(fields.milestone, ctx), "milestone"), remap.milestone, cfg.milestones, "milestone");

    // Effort: a real `Effort:`/`Size:` signal (the profile's effort extractor may chain
    // `Effort` → `Size`) is remapped through `remap.effort` (a foreign size → a canonical
    // value, mirroring remap.priority/milestone) then resolved. With NO signal we fall to
    // `defaults.effort`; on a CLOSED item that default is frozen history, so flag it
    // estimated (a per-item warning + a summary count) — nothing passes as authored. A
    // present-but-unresolved signal on a closed item is kept as a historical value with a
    // warning (SPEC §5.1, §8.3); active items must resolve.
    const rawEffort = runExtractor(fields.effort, ctx);
    const hasEffort = rawEffort != null && String(rawEffort).trim() !== "";
    let effort;
    if (hasEffort) {
      const eff = resolveEffort(cfg, remapLookup(remap.effort, rawEffort));
      if (!eff.error) effort = eff.value;
      else if (isActive) ierr(`effort: ${eff.error}`);
      else { warnings.push(`${src.rel}: effort "${rawEffort}" not resolved — kept as a historical value`); effort = String(rawEffort).trim(); }
    } else {
      const eff = resolveEffort(cfg, defaults.effort);
      if (!eff.error) {
        effort = eff.value;
        if (!isActive) {
          warnings.push(`${src.rel}: effort ${effort} estimated (no \`Effort:\`/\`Size:\` signal — used defaults.effort)`);
          provenance.effortEstimated++;
        }
      } else if (isActive) {
        ierr(`effort: ${eff.error}`);
      }
      // closed + no/invalid `defaults.effort` → effort stays undefined → the missing
      // historical-metadata check below reports it.
    }

    // Closed items still require the descriptive metadata as a historical snapshot
    // (SPEC §5.1) — if the source lacks it and no mapping default fills it, fail loud
    // (a clear plan-time error) rather than emit an item the core would reject.
    if (!isActive) {
      for (const [k, v] of [["milestone", milestone], ["priority", priority], ["effort", effort]]) {
        if (v === undefined) ierr(`${src.status} item is missing \`${k}\` (source has none — set \`defaults.${k}\` in the mapping)`);
      }
    }

    const body = buildBody(raw, newId, title || newId);
    let summary = runExtractor(fields.summary, ctx);
    if (summary == null || String(summary).trim() === "") summary = synthSummary(body, title || newId, (mapping.summary && mapping.summary.strategy) || "firstSentence");
    summary = String(summary).replace(/\s+/g, " ").trim();

    const srcDeps = fields.depends_on ? asList(runExtractor({ ...fields.depends_on, list: true }, ctx)) : [];

    // ----- ownership (owner + collaborators) -----------------------------------
    // `remap.owner` (case-insensitive) maps a source assignee to a roster handle and
    // applies to both owner and collaborators (one identity space). resolveAssignee
    // returns the target handle to store, or null:
    //   - active item: an ACTIVE roster member's canonical handle, else null (silent —
    //     the caller falls back to defaults / unassigned).
    //   - closed item (historical, SPEC §5.1/§8.3): any roster member's canonical handle
    //     (no warning); else the *remapped* value if it is a valid handle (a former
    //     member — kept, with a warning); else null (a non-handle that would not
    //     round-trip — dropped, with a warning). Never invents a member.
    const resolveAssignee = (raw, kind) => {
      const s = raw == null ? "" : String(raw).trim();
      if (!s) return null;
      const remapped = remapLookup(remap.owner, s);
      const m = findMember(roster, remapped);
      if (isActive) return m && m.status === "active" ? m.handle : null;
      if (m) return m.handle;
      if (isValidHandle(remapped)) {
        warnings.push(`${src.rel}: ${kind} "${s}" is not in the roster — kept as a historical value`);
        return remapped;
      }
      warnings.push(`${src.rel}: ${kind} "${s}" is not a valid handle — dropped`);
      return null;
    };

    // owner (optional): on active items chain resolve → `defaults.owner` → unassigned
    // (warn if a source owner was present but didn't resolve); on closed items
    // resolveAssignee has already carried or dropped it as a historical value.
    const rawOwner = runExtractor(fields.owner, ctx);
    let owner = resolveAssignee(rawOwner, "owner") ?? undefined;
    if (isActive && owner === undefined) {
      if (defaults.owner != null && String(defaults.owner).trim() !== "") {
        owner = resolveAssignee(defaults.owner, "owner") ?? undefined;
      }
      if (owner === undefined && rawOwner != null && String(rawOwner).trim() !== "") {
        warnings.push(`${src.rel}: owner "${String(rawOwner).trim()}" is not an active roster member — imported unassigned`);
      }
    }

    // collaborators (optional list): per-entry resolution, deduped. Active items drop a
    // non-member with a warning; closed items keep/drop via resolveAssignee (which warns),
    // so there is no double-warning here.
    const collaborators = [];
    const rawCollabs = fields.collaborators ? asList(runExtractor({ ...fields.collaborators, list: true }, ctx)) : [];
    for (const c of rawCollabs) {
      const h = resolveAssignee(c, "collaborator");
      if (h != null) {
        if (!collaborators.includes(h)) collaborators.push(h);
      } else if (isActive) {
        warnings.push(`${src.rel}: collaborator "${String(c).trim()}" is not an active roster member — dropped`);
      }
    }

    const fm = { id: newId, title: title || newId, status: src.status, milestone, priority, effort, depends_on: [], summary };
    if (owner !== undefined) fm.owner = owner;
    if (collaborators.length) fm.collaborators = collaborators;
    // Close-date resolution (SPEC §5.1 requires an ISO date). A date field that is
    // PRESENT but malformed is a hard error — never papered over by the fallback chain;
    // only an ABSENT field falls through: extractor → git last-commit date → a
    // `defaults.<field>` floor → unresolved. A git-derived or defaulted date is flagged
    // (a per-item warning + a summary count) so it never passes as authored.
    const resolveCloseDate = (extractor, field) => {
      const raw = runExtractor(extractor, ctx);
      if (raw != null && String(raw).trim() !== "") {
        const authored = toISO(raw);
        return authored
          ? { date: authored }
          : { error: `${field} "${String(raw).trim()}" is not an ISO date (expected YYYY-MM-DD)` };
      }
      // Absent: normalize each fallback through toISO so the resolver boundary is
      // uniformly defensive — the production resolver returns ISO-or-null, but an
      // injected one must not mint a date the downstream gate would later reject.
      const fromGit = toISO(gitDate(src.rel));
      if (fromGit) {
        warnings.push(`${src.rel}: ${field} ${fromGit} derived from git history (source had no date header)`);
        provenance.gitDated++;
        return { date: fromGit };
      }
      const floor = toISO(defaults[field]);
      if (floor) {
        warnings.push(`${src.rel}: ${field} ${floor} from defaults.${field} (no date header, no git date)`);
        provenance.dateDefaulted++;
        return { date: floor };
      }
      return { date: null };
    };
    if (src.status === "completed") {
      const r = resolveCloseDate(fields.completed_on, "completed_on");
      if (r.error) ierr(r.error);
      else if (!r.date) ierr("could not resolve a `completed_on` date (no date header, no git commit date, no `defaults.completed_on`)");
      else fm.completed_on = r.date;
    } else if (src.status === "removed") {
      const r = resolveCloseDate(fields.removed_on, "removed_on");
      if (r.error) ierr(r.error);
      else if (!r.date) ierr("could not resolve a `removed_on` date (no date header, no git commit date, no `defaults.removed_on`)");
      else fm.removed_on = r.date;
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
  return { cfg, root, items, idMap, counts, provenance, warnings, errors };
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
export function applyImport(targetRoot, sourceRoot, mapping, { dryRun = false, gitDate } = {}) {
  const summary = { imported: [], created: [], generated: [], idMap: [], counts: null, provenance: null, root: null, warnings: [], errors: [] };
  const plan = planImport(targetRoot, sourceRoot, mapping, { gitDate });
  summary.idMap = plan.idMap;
  summary.counts = plan.counts;
  summary.provenance = plan.provenance;
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
