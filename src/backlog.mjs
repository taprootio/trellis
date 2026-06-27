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
import { join, relative, isAbsolute } from "node:path";

// Spec version this tool implements (SemVer major.minor); see SPEC.md §9.
export const SPEC_VERSION = "2.0";

// The backlog root defaults to `trellis/` and is overridable per repo via the
// config's `tasksDir` key (SPEC §2/§7). The config file itself lives at a FIXED
// path under `trellis/`, independent of `tasksDir`, so the tool can always find
// it before it knows where the task tree is — see paths().
export const DEFAULT_TASKS_DIR = "trellis";
export const CONFIG_DIR = "trellis";

export const MARKERS = {
  milestones: ["<!-- BEGIN GENERATED:MILESTONES -->", "<!-- END GENERATED:MILESTONES -->"],
  completed: ["<!-- BEGIN GENERATED:COMPLETED -->", "<!-- END GENERATED:COMPLETED -->"],
  removed: ["<!-- BEGIN GENERATED:REMOVED -->", "<!-- END GENERATED:REMOVED -->"],
};

// The config path is fixed at `<repo>/trellis/backlog.config.json` and never
// depends on `cfg` — loadConfig calls paths() before any config is known. The
// task tree (active/completed/removed + generated artifacts) lives under
// `cfg.tasksDir` (default `trellis/`), so callers that touch those dirs MUST
// pass the loaded config.
export function paths(repoRoot, cfg) {
  const tasksDir = (cfg && cfg.tasksDir) || DEFAULT_TASKS_DIR;
  const tasks = join(repoRoot, tasksDir);
  return {
    config: join(repoRoot, CONFIG_DIR, "backlog.config.json"),
    // The team roster lives at the FIXED config home (next to backlog.config.json),
    // independent of tasksDir — like the config, it is authored input, not a
    // generated artifact (SPEC §7.2).
    team: join(repoRoot, CONFIG_DIR, "team.json"),
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

  // `tasksDir` is optional (defaults to `trellis/`); when present it must be a
  // non-empty repo-relative path that stays inside the repo — `join(repoRoot,
  // tasksDir)` must not escape via an absolute path or a `..` segment. The config
  // home stays fixed regardless (see paths()).
  if (cfg.tasksDir != null) {
    if (typeof cfg.tasksDir !== "string" || !cfg.tasksDir.trim()) {
      errors.push("config: `tasksDir` must be a non-empty string when present");
    } else if (isAbsolute(cfg.tasksDir) || cfg.tasksDir.split(/[/\\]/).includes("..")) {
      errors.push("config: `tasksDir` must be a repo-relative path within the repo (no absolute path or `..` segments)");
    } else {
      // Canonicalize the stored value so consumers that build rel paths or
      // messages by string interpolation (init skeletons, the AGENTS block, the
      // CLI summary) don't inherit a doubled separator from a trailing slash.
      // join() already tolerates it, but the echoed strings should be clean.
      cfg.tasksDir = cfg.tasksDir.replace(/[/\\]+$/, "");
    }
  }

  if (cfg.specVersion == null) {
    warnings.push(`config has no \`specVersion\`; assuming current spec ${SPEC_VERSION}`);
  } else if (String(cfg.specVersion).split(".")[0] !== SPEC_VERSION.split(".")[0]) {
    warnings.push(`config \`specVersion\` ${cfg.specVersion} differs in major version from this tool's spec ${SPEC_VERSION}`);
  }
  return { cfg, warnings, errors };
}

// ------------------------------------------------------------- team roster
// The team roster (SPEC §7.2) is an authored `team.json` at the FIXED config home
// (next to backlog.config.json, independent of `tasksDir`), kept separate from the
// config so the core vocab stays stable. It is OPTIONAL: an absent file is an empty
// roster (not an error), so a repo that never assigns owners stays green. A present
// file is validated like the config — a malformed roster is a fatal, config-class
// error surfaced through readBacklog so `--check`/validate fail on it. Shape:
//   { "members": [ { "handle", "name", "email"?, "status": "active"|"inactive" } ] }
//
// `handle` is the stable key used in front-matter (`owner`/`collaborators`); it is
// constrained to [A-Za-z0-9._-] so it survives the inline-list serialization of
// `collaborators`. `name`/`email` are display only — the identity model is not
// coupled to any external provider (that is the later cross-repo direction).
const HANDLE_RE = /^[A-Za-z0-9._-]+$/;
const MEMBER_KEYS = new Set(["handle", "name", "email", "status"]);

// The roster shape consumers use: the normalized member list plus a case-insensitive
// handle index. Case-insensitive matching mirrors effort labels and import remap.
export function emptyRoster() {
  return { members: [], byHandle: new Map() };
}

// Resolve a handle to its roster member regardless of status (case-insensitive),
// or undefined. Used by the importer to recover the canonical handle of a now-inactive
// member when carrying a historical owner on a closed item.
export function findMember(roster, handle) {
  if (!roster || typeof handle !== "string" || !handle.trim()) return undefined;
  return roster.byHandle.get(handle.trim().toLowerCase());
}

// Resolve a handle to its roster member only when that member is ACTIVE — the check
// behind active-item owner/collaborator validation and import resolution. Returns
// the member (carrying its canonical handle) or undefined.
export function findActiveMember(roster, handle) {
  const m = findMember(roster, handle);
  return m && m.status === "active" ? m : undefined;
}

// Load and validate the roster → { roster, warnings, errors }, mirroring loadConfig's
// result-object idiom. Absent file → empty roster, no errors. Never throws; the
// caller surfaces errors. Top-level extra keys are tolerated (room for the future
// cross-repo direction); member keys are validated strictly.
export function loadRoster(repoRoot) {
  const warnings = [];
  const teamPath = paths(repoRoot).team;
  if (!existsSync(teamPath)) return { roster: emptyRoster(), warnings, errors: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(teamPath, "utf8"));
  } catch (e) {
    return { roster: emptyRoster(), warnings, errors: [`team.json is not valid JSON (${e.message})`] };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { roster: emptyRoster(), warnings, errors: ["team.json must be an object with a `members` array"] };
  }
  if (!Array.isArray(raw.members)) {
    return { roster: emptyRoster(), warnings, errors: ["team.json: `members` must be an array"] };
  }

  const errors = [];
  const members = [];
  const byHandle = new Map();
  raw.members.forEach((m, i) => {
    const at = `team.json member ${i + 1}`;
    if (m == null || typeof m !== "object" || Array.isArray(m)) { errors.push(`${at}: must be an object`); return; }
    for (const k of Object.keys(m)) if (!MEMBER_KEYS.has(k)) errors.push(`${at}: unknown key \`${k}\``);
    const { handle, name, email, status } = m;
    if (typeof handle !== "string" || !handle.trim()) { errors.push(`${at}: \`handle\` must be a non-empty string`); return; }
    if (!HANDLE_RE.test(handle.trim())) errors.push(`${at}: \`handle\` "${handle}" must use only letters, digits, ., _, -`);
    if (typeof name !== "string" || !name.trim()) errors.push(`${at} (${handle}): \`name\` must be a non-empty string`);
    if (email != null && typeof email !== "string") errors.push(`${at} (${handle}): \`email\` must be a string`);
    // `status` is optional and defaults to active; a present-but-invalid value errors.
    let st = status == null ? "active" : status;
    if (st !== "active" && st !== "inactive") { errors.push(`${at} (${handle}): \`status\` must be "active" or "inactive"`); st = "active"; }
    const key = handle.trim().toLowerCase();
    if (byHandle.has(key)) { errors.push(`team.json: duplicate handle "${handle}"`); return; }
    const member = { handle: handle.trim(), name: typeof name === "string" ? name.trim() : name, status: st };
    if (typeof email === "string" && email.trim()) member.email = email.trim();
    byHandle.set(key, member);
    members.push(member);
  });
  return { roster: { members, byHandle }, warnings, errors };
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
    if (FM_LIST_KEYS.has(key)) {
      if (val.startsWith("[")) {
        fm[key] = val.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s.trim())).filter(Boolean);
      } else if (val === "") {
        const tokens = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          tokens.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
        }
        fm[key] = tokens;
      } else {
        fm[key] = [unquote(val)];
      }
      continue;
    }
    const quoted = /^"[\s\S]*"$/.test(val) || /^'[\s\S]*'$/.test(val);
    const v = unquote(val);
    // Coerce only *unquoted* all-digit values to numbers, so a quoted "404" round-
    // trips as the string "404" — how the writer below preserves a numeric-looking
    // title/summary (serializeFrontMatter) against the string contract.
    fm[key] = !quoted && /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return fm;
}

// ------------------------------------------------------- front-matter (write)
// The serializer side of parseFrontMatter: turn an item object back into the
// YAML-subset front-matter the parser reads. Lives in the core so every writer —
// the MCP create/move ops (src/mcp.mjs) and the importer (src/import.mjs) — emits
// byte-identical, hand-authored-looking files with no string drift.

// Canonical field order, matching the hand-authored items (close date sits right
// after milestone; removed_reason last). Order is cosmetic — the parser is
// order-independent — but consistency keeps diffs clean.
export const FM_ORDER = [
  "id", "title", "status", "milestone",
  "completed_on", "removed_on",
  "priority", "effort", "depends_on", "owner", "collaborators", "summary", "removed_reason",
];

// Front-matter keys whose value is a list of tokens, serialized inline as
// `key: [a, b]` and parsed back the same way (or from a `- ` block / bare scalar).
// `depends_on` is task ids; `collaborators` is roster handles (SPEC §5.1, §7.2).
export const FM_LIST_KEYS = new Set(["depends_on", "collaborators"]);

// Quote a value the parser would otherwise misread on the way back in: an all-digit
// string (it coerces unquoted digits to a number), one already wrapped in a quote
// (stripped by `unquote`), or the empty string. `unquote` is greedy, anchored, and
// does not unescape, so a bare `"` wrap round-trips for any single-line value.
// Numbers (e.g. effort) pass through bare.
export function emitScalar(v) {
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s === "" || /^-?\d+$/.test(s) || /^["']/.test(s) || /["']$/.test(s)) return `"${s}"`;
  return s;
}

// Emit the front-matter the parser reads back: depends_on as an inline array,
// everything else as a (possibly quoted) scalar. Unknown keys are preserved after
// the known ones so nothing is silently dropped.
export function serializeFrontMatter(fm) {
  const emit = (key) => {
    const v = fm[key];
    if (FM_LIST_KEYS.has(key)) return `${key}: [${(v ?? []).join(", ")}]`;
    return `${key}: ${emitScalar(v)}`;
  };
  const keys = [...FM_ORDER.filter((k) => fm[k] !== undefined), ...Object.keys(fm).filter((k) => !FM_ORDER.includes(k))];
  return keys.map(emit).join("\n");
}

// Compose a full item file: front-matter block + a body normalized to start at its
// first line and end with exactly one trailing newline.
export function composeFile(fm, body) {
  const b = String(body).replace(/^\n+/, "").replace(/\n*$/, "\n");
  return `---\n${serializeFrontMatter(fm)}\n---\n\n${b}`;
}

// --------------------------------------------------------------- reading
function idsFromDir(dir, fileRe) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.match(fileRe)).filter(Boolean).map((m) => m[1]);
}

export function readBacklog(repoRoot, cfg) {
  const p = paths(repoRoot, cfg);
  const fileRe = new RegExp(`^(${cfg.idPrefix}\\d{${cfg.idWidth}})\\.md$`);
  const errors = [];

  // The roster lives at the fixed config home; its load/validation errors are
  // config-class and surface here so `--check`/validate fail on a malformed team.json
  // (SPEC §7.2). An absent roster is empty — owner/collaborators stay optional.
  const { roster, errors: rosterErrors } = loadRoster(repoRoot);
  errors.push(...rosterErrors);

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

  // The descriptive metadata is required on closed items too, as a historical
  // snapshot (SPEC §5.1): its *presence* is enforced here, but its enum membership
  // is NOT re-validated against the current config (§8.3) — a value that has since
  // left the config still validates. Call before attachEffort, so a present-but-
  // unresolvable historical effort (e.g. a retired scale label) counts as present.
  const checkHistorical = (it, err) => {
    if (!it.summary) err("missing `summary`");
    if (it.milestone === undefined || it.milestone === "") err("missing `milestone`");
    if (it.priority === undefined || it.priority === "") err("missing `priority`");
    if (it.effort === undefined || it.effort === "") err("missing `effort`");
  };

  // Active-item ownership (SPEC §5.1, §8.3): `owner` (if set) and every collaborator
  // must be an ACTIVE roster member. Both fields are optional. Called for active items
  // only — on closed items the values are historical and not re-validated, so a member
  // who has since gone inactive or left the roster still validates.
  const validateAssignees = (it, err) => {
    if (it.owner !== undefined && it.owner !== "") {
      if (!findActiveMember(roster, it.owner)) err(`owner "${it.owner}" is not an active roster member`);
    }
    if (it.collaborators !== undefined) {
      if (!Array.isArray(it.collaborators)) err("`collaborators` must be a list of handles");
      else for (const c of it.collaborators) {
        if (!findActiveMember(roster, c)) err(`collaborator "${c}" is not an active roster member`);
      }
    }
  };

  for (const it of active) {
    const err = (m) => errors.push(`active/${it._file}: ${m}`);
    checkCommon(it, "active", err);
    if (!it.summary) err("missing `summary`");
    if (!cfg.priorities.includes(it.priority)) err(`priority must be one of ${cfg.priorities.join(", ")}`);
    attachEffort(it, err);
    if (!cfg.milestones.includes(it.milestone)) err(`milestone must be one of ${cfg.milestones.join(", ")}`);
    validateAssignees(it, err);
  }
  for (const it of completed) {
    const err = (m) => errors.push(`completed/${it._file}: ${m}`);
    checkCommon(it, "completed", err);
    checkHistorical(it, err);
    attachEffort(it, null);
    if (!isoDate(it.completed_on)) err("`completed_on` must be an ISO date (YYYY-MM-DD)");
  }
  for (const it of removed) {
    const err = (m) => errors.push(`removed/${it._file}: ${m}`);
    checkCommon(it, "removed", err);
    checkHistorical(it, err);
    attachEffort(it, null);
    if (!isoDate(it.removed_on)) err("`removed_on` must be an ISO date (YYYY-MM-DD)");
    if (!it.removed_reason) err("missing `removed_reason`");
  }

  return { active, completed, removed, ids, errors, roster };
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
    .map((it) => `| [${it.id}](active/${it._file}) | ${cell(it.title)} | ${cell(it.owner ?? "")} | ${it.priority} | ${cell(effortCell(it, cfg))} |`);
  return ["| ID | Title | Owner | Priority | Effort |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
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

// Ownership fields for backlog.json (SPEC §8.2): every task carries `owner` (a
// roster handle or null) and `collaborators` (handles, [] if none), for active and
// closed items alike — on closed items they are a historical snapshot, not
// re-validated against the current roster (§8.3).
function assigneeFields(a) {
  return { owner: a.owner || null, collaborators: a.collaborators ?? [] };
}

export function buildBacklogJson(cfg, data) {
  const backlog = {
    prefix: cfg.idPrefix,
    milestones: cfg.milestones,
    nextId: nextId(data.ids, cfg),
    counts: { active: data.active.length, completed: data.completed.length, removed: data.removed.length },
    tasks: [
      ...data.active.map((a) => ({ id: a.id, title: a.title, status: "active", milestone: a.milestone, priority: a.priority, effort: a.effort, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary })),
      ...data.completed.map((a) => ({ id: a.id, title: a.title, status: "completed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary ?? null, completed_on: a.completed_on ?? null })),
      ...data.removed.map((a) => ({ id: a.id, title: a.title, status: "removed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary ?? null, removed_on: a.removed_on ?? null, removed_reason: a.removed_reason ?? null })),
    ],
  };
  return JSON.stringify(backlog, null, 2) + "\n";
}

// Compute each generated artifact's path + new content. Pure except for reading
// the current files (needed to replace content between their markers).
export function generateArtifacts(repoRoot, cfg, data) {
  const p = paths(repoRoot, cfg);
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
    { path: p.readme, content: fillMarkers(readText(p.readme), MARKERS.milestones, readmeBody, relative(repoRoot, p.readme), errors) },
    { path: p.completedIndex, content: fillMarkers(readText(p.completedIndex), MARKERS.completed, completedTable(data.completed), relative(repoRoot, p.completedIndex), errors) },
    { path: p.removedIndex, content: fillMarkers(readText(p.removedIndex), MARKERS.removed, removedTable(data.removed), relative(repoRoot, p.removedIndex), errors) },
    { path: p.backlogJson, content: buildBacklogJson(cfg, data) },
  ];
  return { files, nextId: next, errors };
}
