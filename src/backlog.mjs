// Trellis backlog core (zero-dependency).
//
// Reusable logic for validating backlog items and generating the derived
// artifacts (README tables, completed/removed indexes, backlog.json). Both the
// CLI (scripts/backlog-readme.mjs) and the MCP server import these functions, so
// every entry point takes an explicit repoRoot and holds no process-wide state.
//
// Front-matter is the small, fixed YAML subset from SPEC.md §5, parsed in-house
// on purpose so Trellis stays drop-in with no install step.

import { closeSync, fstatSync, openSync, readFileSync, readdirSync, existsSync, constants as fsConstants } from "node:fs";
import { join, relative, isAbsolute, normalize, sep } from "node:path";

// Spec version this tool implements (SemVer major.minor); see SPEC.md §9.
export const SPEC_VERSION = "2.5";

// The backlog root defaults to `trellis/` and is overridable per repo via the
// config's `tasksDir` key (SPEC §2/§7). The config file itself lives at a FIXED
// path under `trellis/`, independent of `tasksDir`, so the tool can always find
// it before it knows where the task tree is — see paths().
export const DEFAULT_TASKS_DIR = "trellis";
export const CONFIG_DIR = "trellis";

// Id ledger config (SPEC §3.1, §7; TRL0037). Validation lives here so `check`
// can reject a bad ledger config without git; reading the ledger is src/ledger.mjs.
export const DEFAULT_LEDGER_REF = "refs/trellis/ids";
export const LEDGER_NAMESPACE = "refs/trellis/";
// A prefix with no regex, comma, whitespace or path characters, so ledger rows
// and every existing id matcher can use it unescaped.
export const PLAIN_PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*$/;

// The `git check-ref-format` character and sequence rules as a pattern, shared by
// the ledger ref and the branch names in the ledger. Returns a problem or null.
export function refNameProblem(ref) {
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return "contains a character git forbids in ref names";
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return "contains a sequence git forbids in ref names";
  if (ref.endsWith("/") || ref.endsWith(".")) return "ends in a character git forbids at the end of a ref name";
  if (ref.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"))) {
    return "has a component starting with `.` or ending in `.lock`";
  }
  return null;
}

// A branch name as git accepts it for `refs/heads/<name>`: the ref rules on the full
// ref, plus the branch-only ones (no `@`, no leading `-`). Returns a problem or null.
// One predicate for the ledger reader and every writer.
export function branchNameProblem(name) {
  if (name === "@" || name.startsWith("-")) return "is not a name git accepts for a branch";
  return refNameProblem(`refs/heads/${name}`);
}

// Returns a problem description, or null when `ref` is a valid ledger ref: the
// namespace rule plus the ref-name rules.
export function ledgerRefProblem(ref) {
  if (typeof ref !== "string" || !ref) return "must be a non-empty string";
  if (!ref.startsWith(LEDGER_NAMESPACE) || ref.length === LEDGER_NAMESPACE.length) {
    return `must name a ref under ${LEDGER_NAMESPACE}`;
  }
  return refNameProblem(ref);
}

// One owner of "real calendar date": the shape, then a UTC round trip so 2026-02-31
// fails. Used by the ledger reader, the `legacy` config and closed-item dates.
export function isRealDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

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
    // A derived, NON-gated report (SPEC §8.4), not a generated artifact: materialized
    // from git history by `trellis history --write`, never written by the generator and
    // never part of `--check`. Pathed here only so the deriver (src/history.mjs) and
    // the CLI agree on its location; it is gitignored, not committed.
    historyJson: join(tasks, "history.json"),
  };
}

// ------------------------------------------------------- artifact set (TRL0038)
// `generatedArtifacts` is "committed" (default) or "local". In local mode the
// generated files live in an ignored folder under the backlog root and the
// committed README and index files are author-owned.
export const GENERATED_DIR = ".generated";
export const isLocalMode = (cfg) => cfg.generatedArtifacts === "local";

// The one mode-aware list of artifact paths. `generated` are the files the
// generator writes; `authorOwned` (local mode only) are files that `check` scans
// for leftover generated markers. No other code spells an artifact path.
export function artifactSet(repoRoot, cfg) {
  const p = paths(repoRoot, cfg);
  const entry = (key, path) => ({ key, path, rel: relative(repoRoot, path) });
  if (!isLocalMode(cfg)) {
    return {
      mode: "committed",
      dir: null,
      generated: [entry("readme", p.readme), entry("completed", p.completedIndex), entry("removed", p.removedIndex), entry("backlog", p.backlogJson)],
      authorOwned: [],
    };
  }
  const dir = join(p.tasks, GENERATED_DIR);
  return {
    mode: "local",
    dir,
    generated: [entry("index", join(dir, "index.md")), entry("completed", join(dir, "completed.md")), entry("removed", join(dir, "removed.md")), entry("backlog", join(dir, "backlog.json"))],
    authorOwned: [entry("readme", p.readme), entry("completedIndex", p.completedIndex), entry("removedIndex", p.removedIndex)],
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
  return validateConfig(cfg);
}

// The config rules, on a parsed object. `loadConfig` reads the file and calls this; the
// local-mode switch calls it on the config it would write, so both apply one rule set.
export function validateConfig(cfg) {
  const warnings = [];
  const errors = [];
  if (typeof cfg.idPrefix !== "string" || !cfg.idPrefix) errors.push("config: `idPrefix` must be a non-empty string");
  if (!Number.isInteger(cfg.idWidth) || cfg.idWidth < 1) errors.push("config: `idWidth` must be a positive integer");
  // Optional (TRL0032): floors the *organic* next id (max(floor, max+1)) so freshly
  // created tasks begin above an imported band; must fit idWidth.
  if (cfg.nextIdFloor != null) {
    if (!Number.isInteger(cfg.nextIdFloor) || cfg.nextIdFloor < 0) {
      errors.push("config: `nextIdFloor` must be a non-negative integer when present");
    } else if (Number.isInteger(cfg.idWidth) && cfg.idWidth >= 1 && cfg.nextIdFloor >= 10 ** cfg.idWidth) {
      errors.push(`config: \`nextIdFloor\` (${cfg.nextIdFloor}) must be < 10^idWidth (${10 ** cfg.idWidth}) to fit ${cfg.idWidth} digits`);
    }
  }
  validateIdAllocation(cfg, errors);
  validateLegacy(cfg, errors);
  // A present key must be valid, so an explicit null is an error, not a default (TRL0038).
  if (Object.hasOwn(cfg, "generatedArtifacts") && cfg.generatedArtifacts !== "committed" && cfg.generatedArtifacts !== "local") {
    errors.push('config: `generatedArtifacts` must be "committed" or "local" when present');
  }
  if (!Array.isArray(cfg.milestones) || cfg.milestones.length === 0) errors.push("config: `milestones` must be a non-empty array");
  if (!Array.isArray(cfg.priorities) || cfg.priorities.length === 0) errors.push("config: `priorities` must be a non-empty array");
  const effortValues = Array.isArray(cfg.effort) ? cfg.effort : cfg.effort && cfg.effort.values;
  if (!Array.isArray(effortValues) || effortValues.length === 0) {
    errors.push("config: `effort` must be an array of numbers (or an object with a `values` array)");
  } else if (!effortValues.every((v) => typeof v === "number" && Number.isFinite(v))) {
    errors.push("config: `effort` values must all be numbers");
  }
  cfg.effortValues = Array.isArray(effortValues) ? effortValues : [];
  // Ledger mode re-reads what it writes, so an effort must survive the front-matter round trip.
  if (cfg.idAllocation === "ledger" && cfg.effortValues.some((v) => typeof v === "number" && !Number.isSafeInteger(v))) {
    errors.push("config: `effort` values must be integers when `idAllocation` is \"ledger\"");
  }
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
      // Git's case-insensitive pathspec folds only ASCII, so a Unicode folder name could
      // alias an output on a folding filesystem without git seeing it (TRL0038). Git-free.
      if (cfg.generatedArtifacts === "local" && /[^\x00-\x7f]/.test(cfg.tasksDir)) {
        errors.push("config: `tasksDir` must be ASCII when `generatedArtifacts` is \"local\"");
      }
    }
  }

  if (cfg.specVersion == null) {
    warnings.push(`config has no \`specVersion\`; assuming current spec ${SPEC_VERSION}`);
  } else if (String(cfg.specVersion).split(".")[0] !== SPEC_VERSION.split(".")[0]) {
    warnings.push(`config \`specVersion\` ${cfg.specVersion} differs in major version from this tool's spec ${SPEC_VERSION}`);
  }
  return { cfg, warnings, errors };
}

// `legacy` (TRL0039) exempts closed items from before adoption from the descriptive
// metadata. A present key must be valid. `through` is checked without a regex built
// from `idPrefix`, which scan mode interpolates unescaped.
const LEGACY_KEYS = new Set(["through", "closedBefore"]);
function validateLegacy(cfg, errors) {
  if (!Object.hasOwn(cfg, "legacy")) return;
  const legacy = cfg.legacy;
  if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) {
    errors.push("config: `legacy` must be an object with `through` and `closedBefore`");
    return;
  }
  for (const k of Object.keys(legacy)) if (!LEGACY_KEYS.has(k)) errors.push(`config: \`legacy\` has an unknown key \`${k}\``);
  const prefixOk = typeof cfg.idPrefix === "string" && cfg.idPrefix;
  if (prefixOk && !PLAIN_PREFIX_RE.test(cfg.idPrefix)) {
    errors.push("config: `idPrefix` must be a letter followed by letters or digits when `legacy` is set");
  }
  const { through } = legacy;
  if (typeof through !== "string" || !through) {
    errors.push("config: `legacy.through` must be a full task id such as TR01388");
  } else if (prefixOk && Number.isInteger(cfg.idWidth) && cfg.idWidth >= 1) {
    const rest = through.startsWith(cfg.idPrefix) ? through.slice(cfg.idPrefix.length) : "";
    if (!/^\d+$/.test(rest) || rest.length !== cfg.idWidth) {
      errors.push(`config: \`legacy.through\` must be ${cfg.idPrefix} + ${cfg.idWidth} digits`);
    }
  }
  if (!isRealDate(legacy.closedBefore)) errors.push("config: `legacy.closedBefore` must be a real date (YYYY-MM-DD)");
}

// `idAllocation` is "scan" (default) or "ledger" (TRL0037). Ledger mode also
// limits the prefix and width so ledger rows stay unambiguous and id math exact.
function validateIdAllocation(cfg, errors) {
  // A present key must be valid, so an explicit null is an error, not a default.
  if (Object.hasOwn(cfg, "idAllocation") && cfg.idAllocation !== "scan" && cfg.idAllocation !== "ledger") {
    errors.push('config: `idAllocation` must be "scan" or "ledger" when present');
  }
  if (Object.hasOwn(cfg, "idLedgerRef")) {
    const problem = ledgerRefProblem(cfg.idLedgerRef);
    if (problem) errors.push(`config: \`idLedgerRef\` ${problem}`);
  }
  if (cfg.idAllocation !== "ledger") return;
  // Checked on the text (after the trailing-separator cleanup) with the platform's own path rules (as paths() joins it), so `check` stays git-free. On POSIX a backslash is an ordinary name character. Writes under .git could corrupt the ledger ref.
  if (typeof cfg.tasksDir === "string" && normalize(cfg.tasksDir.replace(/[/\\]+$/, "")).split(sep)[0].toLowerCase() === ".git") {
    errors.push("config: `tasksDir` must not be inside the repository's `.git` directory when `idAllocation` is \"ledger\"");
  }
  if (typeof cfg.idPrefix === "string" && cfg.idPrefix && !PLAIN_PREFIX_RE.test(cfg.idPrefix)) {
    errors.push("config: `idPrefix` must be a letter followed by letters or digits when `idAllocation` is \"ledger\"");
  }
  if (Number.isInteger(cfg.idWidth) && cfg.idWidth > 9) {
    errors.push("config: `idWidth` must be at most 9 when `idAllocation` is \"ledger\"");
  }
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

// True when a string is a syntactically valid handle. The charset keeps a handle safe
// inside the inline serialization of `collaborators` (no comma/bracket), so any writer
// emitting a handle to a file MUST enforce it — not only the roster loader. Historical
// (closed-item) assignees skip roster membership but still must round-trip (SPEC §7.2).
export function isValidHandle(handle) {
  return typeof handle === "string" && HANDLE_RE.test(handle.trim());
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
    if (!isValidHandle(handle)) errors.push(`${at}: \`handle\` "${handle}" must use only letters, digits, ., _, -`);
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
  const text = `${emoji}${it._effortLabel} · ${it.effort}`;
  // Ledger mode keeps configured text on one line, so it cannot form a marker line.
  return cfg.idAllocation === "ledger" ? text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, " ") : text;
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

// The scan-mode id pattern, as readBacklog reads it from the config (the prefix is not
// escaped). The one owner for item checks, filenames and the MCP prompts (TRL0040).
export const scanIdPattern = (cfg) => `${cfg.idPrefix}\\d{${cfg.idWidth}}`;

// The per-item checks, shared by readBacklog and the ledger create preflight (TRL0037).
function makeValidators(cfg, roster, ids) {
  const idRe = new RegExp(`^${scanIdPattern(cfg)}$`);
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
  //
  // With `legacy` (TRL0039): a blank string counts as missing on every closed item, and
  // an item that `qualifies` (below) may omit all four.
  const legacy = cfg.legacy;
  const blank = (v) => typeof v === "string" && !v.trim();
  const missing = (v) => v === undefined || v === "" || (legacy && blank(v));
  const checkHistorical = (it, err, qualifies = false) => {
    if (qualifies) {
      // A qualifying item may omit or blank `summary`, but a falsy non-blank value such as 0 still fails.
      if (it.summary !== undefined && !it.summary && !blank(it.summary)) err("missing `summary`");
      return;
    }
    if (!it.summary || (legacy && blank(it.summary))) err("missing `summary`");
    if (missing(it.milestone)) err("missing `milestone`");
    if (missing(it.priority)) err("missing `priority`");
    if (missing(it.effort)) err("missing `effort`");
  };

  // A closed item from before adoption: its id is at or below `legacy.through` and its
  // close date is a real date before `legacy.closedBefore`. The id comes from the
  // filename (it.id can be absent); the plain prefix makes the digit suffixes
  // fixed-width, so a lexical compare is exact. Never `Number`: wide ids pass 2^53.
  const qualifiesAsLegacy = (it, dateField) => {
    if (!legacy) return false;
    const suffix = (id) => id.slice(cfg.idPrefix.length);
    if (suffix(it._file.replace(/\.md$/, "")) > suffix(legacy.through)) return false;
    return isRealDate(it[dateField]) && it[dateField] < legacy.closedBefore;
  };

  // The close date: the `YYYY-MM-DD` shape today; with `legacy` it must also be real,
  // because qualifying depends on it.
  const closeDateProblem = (value, field) => {
    if (!isoDate(value)) return `\`${field}\` must be an ISO date (YYYY-MM-DD)`;
    if (legacy && !isRealDate(value)) return `\`${field}\` must be a real calendar date`;
    return null;
  };

  // Make a qualifying item's blank descriptive fields missing, so every renderer sees
  // the same item. Archived effort display keys would otherwise survive the read, so
  // they go whatever the effort value; attachEffort sets them again when it resolves.
  const clearLegacyBlanks = (it) => {
    for (const k of ["summary", "milestone", "priority", "effort"]) if (blank(it[k]) || it[k] === "") delete it[k];
    for (const k of ["_effortLabel", "_effortEmoji", "_effortImage"]) delete it[k];
  };

  // Owner/collaborator validation (SPEC §5.1, §7.2, §8.3). On **every** item the
  // values must be syntactically valid handles — a handle is charset-constrained even
  // when historical, so the closed-item exemption is from roster *membership*, not from
  // being a handle (else a hand-authored `owner: Jane Doe` would pass `--check`).
  // **Active** items additionally require an ACTIVE roster member; on closed items
  // membership is not re-checked, so a member who has since gone inactive or left the
  // roster still validates. Both fields are optional.
  const validateAssignees = (it, err, active) => {
    if (it.owner !== undefined && it.owner !== "") {
      if (!isValidHandle(it.owner)) err(`owner "${it.owner}" is not a valid handle (use letters, digits, ., _, -)`);
      else if (active && !findActiveMember(roster, it.owner)) err(`owner "${it.owner}" is not an active roster member`);
    }
    if (it.collaborators !== undefined) {
      if (!Array.isArray(it.collaborators)) err("`collaborators` must be a list of handles");
      else for (const c of it.collaborators) {
        if (!isValidHandle(c)) err(`collaborator "${c}" is not a valid handle (use letters, digits, ., _, -)`);
        else if (active && !findActiveMember(roster, c)) err(`collaborator "${c}" is not an active roster member`);
      }
    }
  };

  const checkActive = (it, err) => {
    checkCommon(it, "active", err);
    if (!it.summary) err("missing `summary`");
    if (!cfg.priorities.includes(it.priority)) err(`priority must be one of ${cfg.priorities.join(", ")}`);
    attachEffort(it, err);
    if (!cfg.milestones.includes(it.milestone)) err(`milestone must be one of ${cfg.milestones.join(", ")}`);
    validateAssignees(it, err, true);
  };
  return { checkActive, checkCommon, checkHistorical, attachEffort, validateAssignees, qualifiesAsLegacy, closeDateProblem, clearLegacyBlanks };
}

// Problems an active item would have on re-read; used before a ledger id is claimed.
export function activeItemErrors(cfg, data, it) {
  const errors = [];
  makeValidators(cfg, data.roster, data.ids).checkActive(it, (m) => errors.push(m));
  return errors;
}

export function readBacklog(repoRoot, cfg) {
  const p = paths(repoRoot, cfg);
  const fileRe = new RegExp(`^(${scanIdPattern(cfg)})\\.md$`);
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
  const { checkActive, checkCommon, checkHistorical, attachEffort, validateAssignees, qualifiesAsLegacy, closeDateProblem, clearLegacyBlanks } = makeValidators(cfg, roster, ids);

  for (const it of active) checkActive(it, (m) => errors.push(`active/${it._file}: ${m}`));
  for (const it of completed) {
    const err = (m) => errors.push(`completed/${it._file}: ${m}`);
    checkCommon(it, "completed", err);
    const qualifies = qualifiesAsLegacy(it, "completed_on");
    checkHistorical(it, err, qualifies);
    if (qualifies) clearLegacyBlanks(it);
    attachEffort(it, null);
    const dateProblem = closeDateProblem(it.completed_on, "completed_on");
    if (dateProblem) err(dateProblem);
    validateAssignees(it, err, false);
  }
  for (const it of removed) {
    const err = (m) => errors.push(`removed/${it._file}: ${m}`);
    checkCommon(it, "removed", err);
    const qualifies = qualifiesAsLegacy(it, "removed_on");
    checkHistorical(it, err, qualifies);
    if (qualifies) clearLegacyBlanks(it);
    attachEffort(it, null);
    const dateProblem = closeDateProblem(it.removed_on, "removed_on");
    if (dateProblem) err(dateProblem);
    if (!it.removed_reason) err("missing `removed_reason`");
    validateAssignees(it, err, false);
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
  // `nextIdFloor` (TRL0032) reserves the low range for an imported band: the next
  // organically-created id is max(max+1, floor). Absent floor ⇒ the historical max+1.
  const floor = Number.isInteger(cfg.nextIdFloor) && cfg.nextIdFloor > 0 ? cfg.nextIdFloor : 0;
  return cfg.idPrefix + String(Math.max(max + 1, floor)).padStart(cfg.idWidth, "0");
}

// ------------------------------------------------------------- rendering
function cell(s) { return String(s ?? "").replace(/\|/g, "\\|"); }

// `literal` (ledger mode only, TRL0037) selects the whole-line marker regex below. The
// body is always inserted through a callback, so a title holding `$&` or `$1` stays
// text in every mode.
// Ledger mode matches each delimiter only as a whole line (trailing spaces and tabs
// allowed), so a title that holds the end marker as text cannot close the block
// early (TRL0037). Shared with the init preflight.
export function ledgerMarkerRe([begin, end]) {
  return new RegExp(`^${begin}[ \\t]*$[\\s\\S]*?^${end}[ \\t]*$`, "m");
}

function fillMarkers(text, [begin, end], body, where, errors, literal = false) {
  const re = literal
    ? ledgerMarkerRe([begin, end])
    : new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!re.test(text)) { errors.push(`${where}: generated markers not found (${begin} ... ${end})`); return text; }
  const filled = `${begin}\n${body}\n${end}`;
  // A callback keeps `$&` or `$1` in a title literal; a replacement string would expand it.
  return text.replace(re, () => filled);
}

// Link bases for the table builders. Committed files sit beside their items'
// folders; local files sit in `.generated/`, one level down (TRL0038).
const COMMITTED_LINKS = { active: "active/", completed: "tasks/", removed: "" };
const LOCAL_LINKS = { active: "../active/", completed: "../completed/tasks/", removed: "../removed/" };

function activeTable(items, cfg, base = COMMITTED_LINKS.active) {
  const rank = Object.fromEntries(cfg.priorities.map((p, i) => [p, i]));
  const rows = items.slice()
    .sort((a, b) => (rank[a.priority] - rank[b.priority]) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](${base}${it._file}) | ${cell(it.title)} | ${cell(it.owner ?? "")} | ${it.priority} | ${cell(effortCell(it, cfg))} |`);
  return ["| ID | Title | Owner | Priority | Effort |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function completedTable(items, base = COMMITTED_LINKS.completed) {
  if (!items.length) return "_No completed items yet._";
  const rows = items.slice()
    .sort((a, b) => String(b.completed_on ?? "").localeCompare(String(a.completed_on ?? "")) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](${base}${it.id}.md) | ${cell(it.title)} | ${cell(it.summary)} | ${cell(it.completed_on)} |`);
  return ["| ID | Title | Summary | Completed |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function removedTable(items, base = COMMITTED_LINKS.removed) {
  if (!items.length) return "_No removed items yet._";
  const rows = items.slice()
    .sort((a, b) => String(b.removed_on ?? "").localeCompare(String(a.removed_on ?? "")) || a.id.localeCompare(b.id))
    .map((it) => `| [${it.id}](${base}${it.id}.md) | ${cell(it.title)} | ${cell(it.summary)} | ${cell(it.removed_on)} | ${cell(it.removed_reason)} |`);
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

// `nextIdOverride` lets a caller outside the git-free core publish a different
// next id (TRL0037): `undefined` computes the scan value, an explicit `null`
// is emitted as `null`.
export function buildBacklogJson(cfg, data, { nextIdOverride } = {}) {
  const backlog = {
    prefix: cfg.idPrefix,
    milestones: cfg.milestones,
    nextId: nextIdOverride === undefined ? nextId(data.ids, cfg) : nextIdOverride,
    counts: { active: data.active.length, completed: data.completed.length, removed: data.removed.length },
    tasks: [
      ...data.active.map((a) => ({ id: a.id, title: a.title, status: "active", milestone: a.milestone, priority: a.priority, effort: a.effort, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary })),
      ...data.completed.map((a) => ({ id: a.id, title: a.title, status: "completed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary ?? null, completed_on: a.completed_on ?? null })),
      ...data.removed.map((a) => ({ id: a.id, title: a.title, status: "removed", milestone: a.milestone ?? null, priority: a.priority ?? null, effort: a.effort ?? null, ...effortFields(a, cfg), depends_on: a.depends_on ?? [], ...assigneeFields(a), summary: a.summary ?? null, removed_on: a.removed_on ?? null, removed_reason: a.removed_reason ?? null })),
    ],
  };
  return JSON.stringify(backlog, null, 2) + "\n";
}

const LOCAL_BLURB = "_Generated by `trellis generate` and ignored by git. Do not edit._";
// The first lines of each local Markdown output. Import reads them to tell a real
// generated file from a task that happens to sit at the same path.
export const LOCAL_TITLES = { index: "Backlog", completed: "Completed tasks", removed: "Removed tasks" };
export const localHead = (title) => `# ${title}\n\n${LOCAL_BLURB}\n`;

// Compute each generated artifact's path + new content. Pure except for reading
// the current files (needed to replace content between their markers).
export function generateArtifacts(repoRoot, cfg, data, { nextIdOverride } = {}) {
  const p = paths(repoRoot, cfg);
  const errors = [];
  const next = nextIdOverride === undefined ? nextId(data.ids, cfg) : nextIdOverride;
  const literal = cfg.idAllocation === "ledger";

  const milestoneBlock = (base) => {
    let out = "";
    for (const ms of cfg.milestones) {
      const items = data.active.filter((a) => a.milestone === ms);
      if (items.length) out += `\n### ${ms}\n\n${activeTable(items, cfg, base)}\n`;
    }
    return out;
  };

  // Local mode reads no file: each output is wholly generated, so it is a pure
  // function of the items and needs no markers (TRL0038).
  if (isLocalMode(cfg)) {
    const [index, completed, removed, backlog] = artifactSet(repoRoot, cfg).generated.map((e) => e.path);
    const head = localHead;
    const files = [
      { path: index, content: head("Backlog") + milestoneBlock(LOCAL_LINKS.active) },
      { path: completed, content: `${head("Completed tasks")}\n${completedTable(data.completed, LOCAL_LINKS.completed)}\n` },
      { path: removed, content: `${head("Removed tasks")}\n${removedTable(data.removed, LOCAL_LINKS.removed)}\n` },
      { path: backlog, content: buildBacklogJson(cfg, data, { nextIdOverride }) },
    ];
    return { files, nextId: next, errors };
  }

  const block = milestoneBlock(COMMITTED_LINKS.active);
  // The README publishes only the milestone tables; the next id lives in
  // backlog.json (SPEC §8.1/§8.2), so `next` below feeds only that artifact and
  // this function's return value (CLI/MCP callers), not the README body.
  const readmeBody = block;

  const readText = (path) => {
    if (existsSync(path)) return readFileSync(path, "utf8");
    errors.push(`missing ${relative(repoRoot, path)}`);
    return "";
  };

  const files = [
    { path: p.readme, content: fillMarkers(readText(p.readme), MARKERS.milestones, readmeBody, relative(repoRoot, p.readme), errors, literal) },
    { path: p.completedIndex, content: fillMarkers(readText(p.completedIndex), MARKERS.completed, completedTable(data.completed), relative(repoRoot, p.completedIndex), errors, literal) },
    { path: p.removedIndex, content: fillMarkers(readText(p.removedIndex), MARKERS.removed, removedTable(data.removed), relative(repoRoot, p.removedIndex), errors, literal) },
    { path: p.backlogJson, content: buildBacklogJson(cfg, data, { nextIdOverride }) },
  ];
  return { files, nextId: next, errors };
}

// ------------------------------------------- local-mode validation (TRL0038)
// The six generated-marker comments. In local mode no committed file may hold one
// on a line of its own: that is a half-finished switch from committed mode.
const MARKER_LINES = new Set(Object.values(MARKERS).flat());

// Reads a file only when it is a regular file (after following a link). A FIFO is
// opened non-blocking and refused from its fstat, so a README that is a pipe cannot hang.
function readRegularText(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// Errors for each author-owned file (README and the two index files) that holds a
// marker line, ignoring trailing spaces, tabs and `\r`. Text that merely mentions
// a marker is fine. An absent file is skipped; git is never consulted.
export function markerLineErrors(repoRoot, cfg) {
  const errors = [];
  for (const f of artifactSet(repoRoot, cfg).authorOwned) {
    let text;
    try {
      text = readRegularText(f.path);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") errors.push(`${f.rel}: cannot read (${e.message})`);
      continue;
    }
    const seen = new Set();
    for (const line of text.split("\n")) {
      const t = line.replace(/[ \t\r]+$/, "");
      if (MARKER_LINES.has(t) && !seen.has(t)) {
        seen.add(t);
        errors.push(`${f.rel}: holds the generated marker line ${t}, but \`generatedArtifacts\` is "local"; remove the generated block and its markers (the index is generated into ${GENERATED_DIR}/)`);
      }
    }
  }
  return errors;
}

// What `check` compares for the mode: committed mode returns the generator's own
// errors and the files to compare; local mode returns the marker errors and no
// files, since nothing generated is committed.
export function checkGenerated(repoRoot, cfg, data) {
  if (!isLocalMode(cfg)) {
    const { files, errors } = generateArtifacts(repoRoot, cfg, data);
    return { errors, files };
  }
  return { errors: markerLineErrors(repoRoot, cfg), files: [] };
}

// The one local-mode validation entry point, shared by CLI `check` and MCP
// `validate` so they cannot disagree. The caller has already loaded the config, so
// its errors come first; then the roster and items (readBacklog), then markers,
// with no early exit on item errors.
export function validateLocal(repoRoot, cfg) {
  const data = readBacklog(repoRoot, cfg);
  return { data, errors: [...data.errors, ...checkGenerated(repoRoot, cfg, data).errors] };
}
