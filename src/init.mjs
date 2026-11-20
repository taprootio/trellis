// Trellis init scaffolder (zero-dependency).
//
// Onboards any repo to the Trellis layout: writes trellis/backlog.config.json,
// the trellis/ layout, the generated index (filled by the TRL0002 core), the CI
// workflow, an AGENTS.md backlog block, and the process playbooks — idempotently,
// never clobbering existing files.
//
// The generator itself is NOT vendored. The onboarded repo runs Trellis via the
// package (TRL0010), so the scaffolded CI calls `npx @taprootio/trellis check` and the
// AGENTS block points at `npx @taprootio/trellis ...`. Like the core, every entry point
// takes an explicit targetRoot and holds no process-wide state, so the CLI and a
// future MCP tool (TRL0004) can share it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { SPEC_VERSION, DEFAULT_TASKS_DIR, CONFIG_DIR, MARKERS, GENERATED_DIR, ledgerMarkerRe, loadConfig, loadRoster, readBacklog, generateArtifacts, attachEffortScale, artifactSet, isLocalMode } from "./backlog.mjs";
import { OutputRefused, outputPreflight, previewNextId, writeArtifactFiles } from "./local-output.mjs";

// The config home is fixed at `trellis/backlog.config.json` (CONFIG_DIR),
// independent of `tasksDir`. A fresh scaffold writes a config that omits
// `tasksDir`, so its task tree defaults to `trellis/` too. But a *kept* existing
// config may set a custom `tasksDir`; init must scaffold the tree there, not at
// the default — otherwise it writes `trellis/*` skeletons that the core then
// fails to fill against the configured root, leaving a partial scaffold. So the
// tree/marker/generated paths derive from the effective config's root, while the
// config path stays fixed.
const CONFIG_REL = `${CONFIG_DIR}/backlog.config.json`;
// The team roster sits next to the config at the FIXED config home (SPEC §7.2),
// independent of tasksDir — it is authored input, not a generated artifact.
const TEAM_REL = `${CONFIG_DIR}/team.json`;
const tasksRootOf = (cfg) => (cfg && cfg.tasksDir) || DEFAULT_TASKS_DIR;

// Default per-repo vocabulary, overridable via options (CLI flags / prompts).
export const DEFAULTS = {
  prefix: "TASK",
  idWidth: 4,
  milestones: ["Alpha", "Beta", "v1", "Future"],
  priorities: ["High", "Medium", "Low"],
  effort: [1, 2, 3, 5, 8, 13, 21],
};

// Marked block appended to (or used to create) AGENTS.md.
export const AGENTS_MARKERS = ["<!-- BEGIN TRELLIS -->", "<!-- END TRELLIS -->"];

// Codex reads at most this many bytes of AGENTS.md; good-agent's `codex/size-budget`
// rule fails above it (TRL0040).
export const AGENTS_BYTE_LIMIT = 32768;

// Each starts its own output line, so tests and tools match a token, never prose.
export const INIT_TOKENS = {
  blockNotUpdated: "[trellis:block-not-updated]",
  carryOver: "[trellis:carry-over]",
  preview: "[trellis:preview]",
  size: "[trellis:size]",
};

// The warning printed wherever init prints a block for the owner to place by hand. With
// `bytesNeeded` it also says how big AGENTS.md would become.
export function carryOverWarning({ bytesNeeded } = {}) {
  const size = bytesNeeded === undefined ? "" : ` AGENTS.md would be ${bytesNeeded} bytes; the limit is ${AGENTS_BYTE_LIMIT}.`;
  return `${INIT_TOKENS.carryOver} Carry over the Loop contract values this repo already uses (branch-naming, gates, attribution) when you place the block.${size}`;
}

// A repo that already runs good-agent has these files. Each counts only as a regular
// file, so a directory at the path is not a marker. Returns the matched path or null.
const GOOD_AGENT_MARKERS = ["good-agent.config.json", ".agents/skills/work-task/SKILL.md"];
export function detectGoodAgent(targetRoot) {
  return GOOD_AGENT_MARKERS.find((rel) => {
    try {
      return statSync(join(targetRoot, rel)).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

// Process files copied verbatim from the Trellis install (sourceRoot). Their
// value is the loop, not the exact command names; the AGENTS block below carries
// the authoritative `npx @taprootio/trellis` commands for the onboarded repo.
//
// The playbooks and branch-protection guide scaffold into the FIXED Trellis home
// (CONFIG_DIR), alongside backlog.config.json / team.json and independent of
// tasksDir — never into `docs/`, which a repo's static-site generator often
// publishes (TRL0028). They travel with the config, not the task tree, and the
// generator (which scans only active/, completed/tasks/, removed/) ignores them.
// The package ships these under templates/ so npm does not also include the live
// generated backlog index at trellis/README.md. In a source checkout, prefer the
// canonical in-repo files so Trellis keeps dogfooding the layout it emits.
const PLAYBOOK_FILES = [
  `${CONFIG_DIR}/playbooks/conventions.md`,
  `${CONFIG_DIR}/playbooks/work-task.md`,
  `${CONFIG_DIR}/playbooks/code-review.md`,
  `${CONFIG_DIR}/playbooks/pr-draft.md`,
];
const WORKFLOW_REL = ".github/workflows/backlog.yml";
const BRANCH_PROTECTION_REL = `${CONFIG_DIR}/branch-protection.md`;
const PR_TEMPLATE_REL = ".github/pull_request_template.md";
const COPY_FILES = [...PLAYBOOK_FILES, BRANCH_PROTECTION_REL, PR_TEMPLATE_REL];

// The parts `--skip` can leave out, each with the files it covers (TRL0040). One table
// for the CLI and `applyScaffold`. AGENTS.md sits outside `templateFiles`, so
// `planScaffold` applies the `agents` part itself.
export const SKIP_PARTS = {
  ci: [WORKFLOW_REL],
  "pr-template": [PR_TEMPLATE_REL],
  playbooks: PLAYBOOK_FILES,
  "branch-protection": [BRANCH_PROTECTION_REL],
  agents: ["AGENTS.md"],
};

// Option combinations the CLI and `applyScaffold` both refuse (one owner, TRL0040).
export function optionConflicts(skipParts, withPlaybooks) {
  return withPlaybooks && skipParts.includes("playbooks") ? ["--skip playbooks cannot be combined with --with-playbooks"] : [];
}

// Turns the raw `--skip` values (one per flag; undefined when the value was missing)
// into a deduplicated list of part names in table order, plus usage errors.
export function parseSkip(values = []) {
  const errors = [];
  const named = new Set();
  for (const v of values) {
    const names = v == null ? [] : String(v).split(",").map((x) => x.trim()).filter(Boolean);
    if (!names.length) errors.push("`--skip` needs a comma-separated list of parts");
    for (const n of names) {
      if (Object.hasOwn(SKIP_PARTS, n)) named.add(n);
      else errors.push(`unknown \`--skip\` part: ${n} (expected ${Object.keys(SKIP_PARTS).join(", ")})`);
    }
  }
  return { parts: Object.keys(SKIP_PARTS).filter((p) => named.has(p)), errors: [...new Set(errors)] };
}

function copySourcePath(sourceRoot, rel) {
  const local = join(sourceRoot, rel);
  if (existsSync(local)) return local;
  const packaged = join(sourceRoot, "templates", rel);
  return existsSync(packaged) ? packaged : null;
}

// The marker-based generated indexes (skeleton-then-filled), each paired with the
// exact begin/end marker the core requires — the single source of truth shared by
// the skeletons and the preflight check. Committed mode only; the paths come from
// the one mode-aware artifact set (TRL0038).
const posix = (rel) => rel.split(sep).join("/");
const markerFiles = (targetRoot, root) => {
  const [readme, completed, removed] = artifactSet(targetRoot, { tasksDir: root }).generated;
  return [
    [posix(readme.rel), MARKERS.milestones],
    [posix(completed.rel), MARKERS.completed],
    [posix(removed.rel), MARKERS.removed],
  ];
};

// The generated artifacts, produced by the core after the skeletons land: the four
// committed files, or the four under `.generated/` in local mode.
const generatedFiles = (targetRoot, root, local) =>
  artifactSet(targetRoot, { tasksDir: root, generatedArtifacts: local ? "local" : "committed" }).generated.map((e) => posix(e.rel));

export function resolveOptions(opts = {}) {
  // `=== undefined` throughout, never `||` / `&& .length`: a value that was
  // *provided but invalid* (width 0/NaN, or an all-non-numeric `--effort` that
  // parsed to []) must reach validateOptions, not be silently masked by the
  // default. Only an *omitted* (undefined) value falls back.
  const pick = (v, d) => (v === undefined ? d : v);
  return {
    prefix: pick(opts.prefix, DEFAULTS.prefix),
    idWidth: pick(opts.idWidth, DEFAULTS.idWidth),
    milestones: pick(opts.milestones, DEFAULTS.milestones),
    priorities: pick(opts.priorities, DEFAULTS.priorities),
    effort: pick(opts.effort, DEFAULTS.effort),
  };
}

// Validate the resolved vocabulary before any file is written, so a bad flag
// leaves the target untouched rather than half-scaffolded. Mirrors the core's
// config checks (SPEC.md §7).
export function validateOptions(o) {
  const errors = [];
  if (typeof o.prefix !== "string" || !o.prefix) errors.push("`--prefix` must be a non-empty string");
  if (!Number.isInteger(o.idWidth) || o.idWidth < 1) errors.push("`--id-width` must be a positive integer");
  if (!Array.isArray(o.milestones) || !o.milestones.length) errors.push("`--milestones` must be non-empty");
  if (!Array.isArray(o.priorities) || !o.priorities.length) errors.push("`--priorities` must be non-empty");
  if (!Array.isArray(o.effort) || !o.effort.length || !o.effort.every((n) => typeof n === "number" && Number.isFinite(n))) {
    errors.push("`--effort` must be a non-empty list of numbers");
  }
  return errors;
}

// Whether the init CLI should interactively prompt for the missing vocabulary
// (prefix/milestones). It must NOT prompt for a dry run, a retire-only run, or a
// non-interactive stdin — and only when something is actually missing. The retire check
// is keyed on the flag's PRESENCE, not a truthy value: a valueless `--retire-source`
// (a usage error) must not prompt for scaffold vocabulary it will never use before it
// reports the missing path. Pure (takes isTTY) so it is unit-testable without a terminal.
export function shouldPromptVocab(opts, isTTY) {
  if (opts.dryRun || "retireSource" in opts || opts.switchToLocal || !isTTY) return false;
  return !opts.prefix || !opts.milestones;
}

// Derive scaffold options from an existing (already-validated) config, so a kept
// config — not the supplied flags — governs the rendered templates and AGENTS
// block. Otherwise a repo with `idPrefix: DEMO` could get an AGENTS block saying
// ids are `TASK`.
function optionsFromConfig(cfg) {
  return {
    prefix: cfg.idPrefix,
    idWidth: cfg.idWidth,
    milestones: cfg.milestones,
    priorities: cfg.priorities,
    effort: cfg.effortValues && cfg.effortValues.length ? cfg.effortValues : cfg.effort,
  };
}

// True if the user explicitly supplied a vocabulary flag that disagrees with the
// effective (kept-config) value — used to warn that the flag was ignored.
function suppliedConflicts(opts, effective) {
  return ["prefix", "idWidth", "milestones", "priorities", "effort"].some(
    (k) => opts[k] !== undefined && JSON.stringify(opts[k]) !== JSON.stringify(effective[k]),
  );
}

// The in-memory config that will govern the target after init (loadConfig shape,
// including effortValues), built from the resolved options.
function effectiveConfig(o) {
  const cfg = {
    specVersion: SPEC_VERSION,
    idPrefix: o.prefix,
    idWidth: o.idWidth,
    milestones: o.milestones,
    priorities: o.priorities,
    effort: o.effort,
    effortValues: o.effort,
  };
  attachEffortScale(cfg); // match loadConfig's shape so readBacklog can resolve effort
  return cfg;
}

// Refuse to scaffold over a target whose *existing* backlog or config is already
// broken: validate any items already present against the config that will govern
// them after init (the existing one when we keep it, the resolved options when we
// write/overwrite it). Returns fatal messages; [] means safe to proceed. Read-only.
function preflight(targetRoot, options, force) {
  const hasCfg = existsSync(join(targetRoot, CONFIG_REL));
  const existing = loadConfig(targetRoot);
  let cfg;
  if (hasCfg && !force) {
    if (existing.errors.length) return [`existing backlog.config.json is invalid; fix it before init: ${existing.errors.join("; ")}`];
    cfg = existing.cfg;
  } else {
    cfg = effectiveConfig(options); // fresh target, or --force will overwrite it
  }
  const root = tasksRootOf(cfg); // a kept config may relocate the tree via tasksDir
  const data = readBacklog(targetRoot, cfg);
  // --force overwrites team.json with a fresh stub, so a pre-existing broken roster
  // must not block (mirrors force overwriting a broken config/index below). Item
  // errors still block — items are never overwritten. readBacklog bundles the roster
  // errors into data.errors, so subtract exactly those under force.
  let dataErrors = data.errors;
  if (force) {
    const rosterErrors = new Set(loadRoster(targetRoot).errors);
    dataErrors = dataErrors.filter((e) => !rosterErrors.has(e));
  }
  if (dataErrors.length) return [`target backlog has errors; fix them before init: ${dataErrors.join("; ")}`];

  // A generated index we will KEEP must already carry its begin→end marker pair,
  // in order (begin before end), or the core can't fill it and the repo would
  // never be --check-green. Catch it here and refuse before writing. Under --force
  // we overwrite these files with fresh skeletons, so the check doesn't apply —
  // matching `begin[\s\S]*?end` in fillMarkers, an out-of-order or wrong-section
  // or unterminated pair fails.
  // In local mode those files are author-owned and optional: nothing fills them.
  if (!force && !isLocalMode(cfg)) {
    for (const [rel, [begin, end]] of markerFiles(targetRoot, root)) {
      const abs = join(targetRoot, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      // A ledger-mode target is filled by whole delimiter lines, so check the same way.
      const bi = text.indexOf(begin), ei = text.indexOf(end);
      const ok = cfg.idAllocation === "ledger" ? ledgerMarkerRe([begin, end]).test(text) : bi !== -1 && ei !== -1 && bi < ei;
      if (!ok) {
        return [`${rel} exists but is missing its required \`${begin}\` … \`${end}\` markers in order; fix or remove it before init`];
      }
    }
  }
  return [];
}

// ------------------------------------------------------------- templates
function configContent(o) {
  return JSON.stringify(
    {
      specVersion: SPEC_VERSION,
      idPrefix: o.prefix,
      idWidth: o.idWidth,
      milestones: o.milestones,
      priorities: o.priorities,
      effort: o.effort,
    },
    null,
    2,
  ) + "\n";
}

// The team roster stub (SPEC §7.2): one INACTIVE placeholder member showing the shape
// (`handle`/`name`/optional `email`/`status`) without reading like a real teammate —
// an inactive member can't own active items, so it's clearly a stub to replace or
// delete rather than live config. Authored, not generated; left for the repo to edit.
// An unused roster keeps the scaffold --check-green (no task owns it).
function teamContent() {
  return JSON.stringify(
    { members: [{ handle: "example", name: "Example teammate (replace or delete)", email: "you@example.com", status: "inactive" }] },
    null,
    2,
  ) + "\n";
}

// Skeletons carry the exact begin/end markers from the core (via MARKERS), so the
// core can fill them and preflight can verify them with no string drift.
function markerSkeleton([begin, end], heading, blurb) {
  return `# ${heading}\n\n${blurb}\n\n${begin}\n${end}\n`;
}

// Under `--skip agents` there is no AGENTS.md block, so the README points at the spec.
function readmeSkeleton(omitAgents = false) {
  return markerSkeleton(
    MARKERS.milestones,
    "Backlog",
    "Managed with [Trellis](https://github.com/taprootio/trellis) — a file-based\n" +
      (omitAgents ? "backlog. See the [Trellis spec](https://github.com/taprootio/trellis/blob/main/SPEC.md)\nfor the schema and conventions." : "backlog. See `AGENTS.md` for the schema and conventions.") +
      " The tables below are\n" +
      "generated; do not hand-edit between the markers — edit the per-item files in\n" +
      "`active/`, then regenerate (`npx @taprootio/trellis generate`).",
  );
}

export function completedSkeleton() {
  return markerSkeleton(
    MARKERS.completed,
    "Completed tasks",
    "Generated from `completed/tasks/`. Do not hand-edit between the markers — close\n" +
      "a task and regenerate (`npx @taprootio/trellis generate`).",
  );
}

export function removedSkeleton() {
  return markerSkeleton(
    MARKERS.removed,
    "Removed tasks",
    "Generated from `removed/`. Do not hand-edit between the markers — remove a task\n" +
      "and regenerate (`npx @taprootio/trellis generate`).",
  );
}

function workflowContent() {
  // The job's explicit `name: backlog` is the pinned required-check context
  // (TRL0014, SPEC §10): the stable name a branch-protection rule requires, so a
  // workflow/job rename can't silently drop the gate. It is distinct from the
  // workflow's display name (`Backlog Hygiene`). Enable the gate against this
  // context with trellis/branch-protection.md. The check runs via the Trellis package
  // (TRL0010); it is red until that ships.
  return `name: Backlog Hygiene
on:
  pull_request:
  push:
    branches: [main]
jobs:
  backlog:
    name: backlog
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npx --yes @taprootio/trellis check
`;
}

// The AGENTS.md bullet that says which files are generated, per mode and block variant.
// One renderer owns every text: `--switch-to-local` replaces the committed text with the
// local one only on an exact match, so a hand-edited bullet is never overwritten (TRL0038).
// The compact variant belongs to the short block written for good-agent repos (TRL0040).
export function artifactBullet(root, mode = "committed", variant = "full") {
  if (variant === "compact") {
    if (mode === "local") {
      return `- The index and \`backlog.json\` are generated into the git-ignored \`${root}/${GENERATED_DIR}/\`
  folder by \`npx @taprootio/trellis generate\`; no committed file is generated.`;
    }
    return `- The \`${root}/\` README and index tables are generated between the \`BEGIN/END GENERATED\` markers; never hand-edit them.
  \`backlog.json\` is generated in full (it has no markers); the \`BEGIN GENERATED\` / \`END GENERATED\` markers apply only to the Markdown files.`;
  }
  if (mode === "local") {
    return `- The index and \`backlog.json\` are **generated** into the git-ignored
  \`${root}/${GENERATED_DIR}/\` folder by \`npx @taprootio/trellis generate\`; no committed
  file under \`${root}/\` is generated, so \`README.md\` and the index files are yours.`;
  }
  return `- \`${root}/README.md\`, \`${root}/backlog.json\`, and the
  \`${root}/completed/index.md\` / \`${root}/removed/index.md\` indexes are
  **generated** — never hand-edit between the \`BEGIN/END GENERATED\` markers.`;
}

// The Loop contract table, shared by the full and the compact block.
const loopTable = (idExample) => `| seam point | this repo's value |
| --- | --- |
| \`regenerate\` | \`npx @taprootio/trellis generate\` |
| \`check\` | \`npx @taprootio/trellis check\` |
| \`branch-naming\` | \`<initials>/<id-lowercase>/<slug>\` (e.g. \`ab/${idExample}/short-slug\`) |
| \`gates\` | \`npx @taprootio/trellis check\` (plus this repo's tests/lint) |
| \`attribution\` | none — no \`Co-Authored-By:\` trailers or "Generated with …" footers |`;

// The ledger-mode claim line (TRL0037), shared by both blocks. The full block makes it
// its own bullet; the compact block uses it as a sentence.
const CLAIM_LINE = 'Claim ids with `npx @taprootio/trellis claim --title "<one line>"`; never pick the next number by hand.';

// `parts` shapes a block: `ledger` adds the claim line, `skip` is the list of `--skip`
// part names (TRL0040). The defaults reproduce the original text byte for byte.
export function agentsBlock(o, root = DEFAULT_TASKS_DIR, mode = "committed", { ledger = false, skip = [] } = {}) {
  const [begin, end] = AGENTS_MARKERS;
  const has = (part) => !skip.includes(part);
  // A sample id (number 1, zero-padded to the repo's width) so the branch example
  // matches this repo's actual id format, not a hard-coded 4-digit one.
  const idExample = `${o.prefix.toLowerCase()}${String(1).padStart(o.idWidth, "0")}`;
  const regenerate = `- After adding, moving, or editing an item, regenerate with \`npx @taprootio/trellis generate\`${has("ci") ? ";\n  CI runs \`npx @taprootio/trellis check\`." : "."}`;
  const protectedBranch = (has("ci")
    ? "- `main` is protected — work on a branch, open a PR, and let the backlog check\n  (the pinned `backlog` job) gate the merge."
    : "- `main` is protected — work on a branch and open a PR.")
    + (has("branch-protection") ? " Enable the gate with the recipe in\n  `trellis/branch-protection.md` (GitHub plus GitLab/Bitbucket/Azure DevOps)." : "");
  const loopLead = has("playbooks")
    ? `The playbooks in \`trellis/playbooks/\` are universal; they name **seam points** and
read this repo's values from here. See \`trellis/playbooks/conventions.md\` for the
contract, then set these to match your tooling:`
    : "Set these seam points to match your tooling:";
  return `${begin}
## Backlog (Trellis)

This repo uses [Trellis](https://github.com/taprootio/trellis) for a file-based
backlog. Work items live in \`${root}/{active,completed/tasks,removed}/\` as
Markdown files with YAML front-matter; ids are \`${o.prefix}\` + ${o.idWidth} digits.

${ledger ? `- ${CLAIM_LINE}\n` : ""}${artifactBullet(root, mode)}
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  \`trellis/backlog.config.json\` (the backlog root is \`trellis/\` by default;
  override it with a \`tasksDir\` key).
- The team roster lives in \`trellis/team.json\` (members with a \`handle\`, \`name\`,
  optional \`email\`, and \`status\`). A task may set an optional \`owner\` (one handle)
  and \`collaborators\` (handles); on active items they must be active roster members.
${regenerate}
${protectedBranch}
- Commit messages and PR descriptions carry no AI/co-author attribution — never
  add \`Co-Authored-By:\` trailers or "Generated with …" footers.

### Loop contract

${loopLead}

${loopTable(idExample)}
${has("playbooks") ? "\nSee `trellis/playbooks/` for the work-a-task and code-review loops.\n" : ""}${end}
`;
}

// The short block for a repo that already runs good-agent: the loops live in its skills,
// so the block only names them, the claim line (ledger mode), the generated files and the
// Loop contract (TRL0040). The artifact bullet ends its item with a blank line so
// `--switch-to-local` can recognize and rewrite it.
export function compactBlock(o, root = DEFAULT_TASKS_DIR, mode = "committed", { ledger = false } = {}) {
  const [begin, end] = AGENTS_MARKERS;
  const idExample = `${o.prefix.toLowerCase()}${String(1).padStart(o.idWidth, "0")}`;
  return `${begin}
## Backlog (Trellis)

Backlog items live in \`${root}/\`; the config is \`trellis/backlog.config.json\`.
Task work follows good-agent's \`write-task\`, \`work-task\` and \`review-loop\` skills.

${ledger ? `- ${CLAIM_LINE}\n` : ""}${artifactBullet(root, mode, "compact")}

### Loop contract

${loopTable(idExample)}
${end}
`;
}

// Build the template files (everything except the generated artifacts, which the
// core fills in afterward). Returns [{ rel, content }].
function templateFiles(o, sourceRoot, root, local = false, omit = new Set()) {
  const files = [
    { rel: CONFIG_REL, content: configContent(o) },
    { rel: TEAM_REL, content: teamContent() },
    { rel: `${root}/active/.gitkeep`, content: "" },
    { rel: `${root}/completed/tasks/.gitkeep`, content: "" },
    // Local mode: the README and index files are author-owned, so init never creates them.
    ...(local ? [] : [
      { rel: `${root}/README.md`, content: readmeSkeleton(omit.has("AGENTS.md")) },
      { rel: `${root}/completed/index.md`, content: completedSkeleton() },
      { rel: `${root}/removed/index.md`, content: removedSkeleton() },
    ]),
    { rel: WORKFLOW_REL, content: workflowContent() },
  ].filter((f) => !omit.has(f.rel));
  const warnings = [];
  // An omitted part's source is never resolved, so it can never be reported missing.
  for (const rel of COPY_FILES.filter((r) => !omit.has(r))) {
    const src = copySourcePath(sourceRoot, rel);
    if (src) files.push({ rel, content: readFileSync(src, "utf8") });
    else warnings.push(`source not found, skipped copy: ${rel}`);
  }
  return { files, warnings };
}

// -------------------------------------------------------- reconciliation
// Root guidance files an onboarding agent typically keeps backlog instructions in.
// Bounded on purpose: a precise, low-false-positive scan beats a broad one, since
// the output is a checklist a human acts on (TRL0027).
const RECONCILE_FILES = ["AGENTS.md", "AI_GUIDELINES.md", "CLAUDE.md"];

// Strip Trellis's own appended block from AGENTS.md so the scan never flags the
// guidance init itself just wrote — only the author's surrounding prose is examined.
function stripTrellisBlock(text) {
  const [begin, end] = AGENTS_MARKERS;
  const bi = text.indexOf(begin);
  if (bi === -1) return text;
  const ei = text.indexOf(end, bi);
  if (ei === -1) return text;
  return text.slice(0, bi) + text.slice(ei + end.length);
}

// READ-ONLY scan for stale, pre-Trellis backlog guidance the agent should rewrite
// by hand. `init` reports; it never edits or deletes author prose (TRL0027). Returns
// [{ file, note }]. `root` is the effective backlog root; `importSource` (when set) is
// the repo-relative path just imported — a reference to it is the strongest signal a
// doc points at the now-retired backlog. Precision over recall: a false positive is
// only a line the agent skips.
export function scanReconcile(targetRoot, { root = DEFAULT_TASKS_DIR, importSource, excludeAgents = false } = {}) {
  const notes = [];
  const headingRe = /^[ \t]*#{1,6}[ \t]+(.*\bbacklog\b.*)$/im;
  for (const file of RECONCILE_FILES) {
    if (excludeAgents && file === "AGENTS.md") continue;
    const abs = join(targetRoot, file);
    if (!existsSync(abs)) continue;
    const authorText = file === "AGENTS.md" ? stripTrellisBlock(readFileSync(abs, "utf8")) : readFileSync(abs, "utf8");

    // (a) A backlog-ish heading in author prose that doesn't already point at the new
    // root — likely guidance still describing the old backlog. Suppress once the
    // author content references `<root>/`, i.e. it has already been reconciled.
    const m = authorText.match(headingRe);
    if (m && !authorText.includes(`${root}/`)) {
      notes.push({ file, note: `has a "${m[1].trim()}" section that looks like pre-Trellis backlog guidance — rewrite it to point at ${root}/ (init only appends its own block; it won't touch this)` });
    }

    // (b) A reference to the just-imported source path — the doc names the backlog
    // location that import copied out of and --retire-source can now remove.
    if (importSource && authorText.includes(importSource)) {
      notes.push({ file, note: `references the imported backlog path "${importSource}" — update or remove that reference now that items live under ${root}/` });
    }
  }
  return notes;
}

// The just-imported source as a repo-relative path, or undefined when no --import was
// given or the source sits outside the repo (it can't be named as a repo path then,
// so signal (b) above doesn't apply).
function importSourceRel(targetRoot, importOpt) {
  if (!importOpt) return undefined;
  const abs = isAbsolute(importOpt) ? importOpt : join(targetRoot, importOpt);
  const rel = relative(targetRoot, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel;
}

// ----------------------------------------------------------------- plan
// Compute the per-file actions without touching disk. `action` is one of
// create | skip | append (append is AGENTS.md only). force turns skip → create.
export function planScaffold(targetRoot, opts = {}, sourceRoot) {
  const resolved = resolveOptions(opts);
  const force = !!opts.force;

  // When a valid existing config is kept (no --force), it — not the supplied
  // flags — governs the repo, so render the config template and AGENTS block from
  // it. This keeps the AGENTS block's stated prefix consistent with backlog.config.json.
  const existing = loadConfig(targetRoot);
  const keepCfg = existsSync(join(targetRoot, CONFIG_REL)) && !existing.errors.length && !force;
  const o = keepCfg ? optionsFromConfig(existing.cfg) : resolved;
  // A kept config governs the backlog root via `tasksDir`; a fresh scaffold omits
  // it and defaults to `trellis/`. Every scaffolded tree path derives from this.
  const root = keepCfg ? tasksRootOf(existing.cfg) : DEFAULT_TASKS_DIR;
  // Local mode needs an existing local config (a fresh scaffold is always committed).
  const local = keepCfg && isLocalMode(existing.cfg);
  const keptCfg = keepCfg ? existing.cfg : null;

  const actions = [];
  // Good-agent already ships the loops, so detection leaves the playbooks out unless
  // `--with-playbooks` asks for them. An explicit `--skip playbooks` is reported as such.
  const explicit = opts.skip || [];
  const detected = detectGoodAgent(targetRoot);
  const withPlaybooks = !!opts.withPlaybooks;
  const byDetection = !!detected && !withPlaybooks;
  const playbooksOmittedBy = explicit.includes("playbooks") ? "skip" : byDetection ? "detection" : null;
  const omitted = Object.keys(SKIP_PARTS).filter((p) => explicit.includes(p) || (p === "playbooks" && byDetection));
  const omit = new Set(omitted.flatMap((p) => SKIP_PARTS[p]));
  const { files, warnings } = templateFiles(o, sourceRoot, root, local, omit);
  if (keepCfg && suppliedConflicts(opts, o)) {
    warnings.push(`existing backlog.config.json kept; its vocabulary governs (prefix \`${o.prefix}\`) — supplied flags ignored${Object.hasOwn(keptCfg, "legacy") ? "" : " (use --force to overwrite)"}`);
  }

  for (const f of files) {
    const abs = join(targetRoot, f.rel);
    const exists = existsSync(abs);
    let action = exists && !force ? "skip" : "create";
    // team.json holds authored roster data with no flag source, so a VALID existing
    // roster is preserved even under --force — overwriting it would drop real members
    // and could leave active owners dangling (a partial, broken scaffold). Only an
    // absent or broken roster is (re)written with the stub. Mirrors the AGENTS block,
    // which --force also never clobbers.
    if (f.rel === TEAM_REL && exists && loadRoster(targetRoot).errors.length === 0) {
      action = "skip";
    }
    actions.push({ rel: f.rel, content: f.content, action });
  }

  // AGENTS.md: create if absent, append the block if present without it, else skip.
  // `--skip agents` leaves it out entirely.
  const agentsAbs = join(targetRoot, "AGENTS.md");
  const parts = { ledger: !!keptCfg && keptCfg.idAllocation === "ledger", skip: omitted };
  const mode = local ? "local" : "committed";
  const block = byDetection ? compactBlock(o, root, mode, parts) : agentsBlock(o, root, mode, parts);
  // A result over Codex's byte budget is printed for the owner instead of written.
  const planAgents = (content, action) => {
    const bytesNeeded = Buffer.byteLength(content);
    if (bytesNeeded > AGENTS_BYTE_LIMIT) actions.push({ rel: "AGENTS.md", content: "", action: "print", reason: "size", block, bytesNeeded });
    else actions.push({ rel: "AGENTS.md", content, action });
  };
  if (omit.has("AGENTS.md")) {
    // No action: nothing is created, appended or printed for AGENTS.md.
  } else if (!existsSync(agentsAbs)) {
    planAgents(`# AGENTS\n\n${block}`, "create");
  } else {
    const cur = readFileSync(agentsAbs, "utf8");
    const [begin, end] = AGENTS_MARKERS;
    const bi = cur.indexOf(begin);
    // The END marker must follow the begin marker, or the block cannot be measured.
    const ei = bi === -1 ? -1 : cur.indexOf(end, bi);
    if (bi !== -1 && ei !== -1 && detected && withPlaybooks) {
      // Never rewrite an existing block: print the full block for the owner to place.
      const bytesNeeded = Buffer.byteLength(cur.slice(0, bi) + block.trimEnd() + cur.slice(ei + end.length));
      actions.push({ rel: "AGENTS.md", content: "", action: "print", reason: "existing-block", block, bytesNeeded });
    } else if (bi !== -1) {
      actions.push({ rel: "AGENTS.md", content: "", action: "skip" });
    } else {
      const sep = cur.endsWith("\n") ? "\n" : "\n\n";
      planAgents(cur + sep + block, "append");
    }
  }

  // When the size guard keeps the block out of AGENTS.md, a new README must not send readers there.
  const agentsPlan = actions.find((a) => a.rel === "AGENTS.md");
  const readmePlan = actions.find((a) => a.rel === `${root}/README.md`);
  if (agentsPlan && agentsPlan.action === "print" && agentsPlan.reason === "size" && readmePlan && readmePlan.action === "create") readmePlan.content = readmeSkeleton(true);

  // Read-only reconciliation scan (TRL0027): stale backlog guidance for the agent to
  // rewrite by hand. Advisory — kept separate from `warnings` (scaffold mechanics) and
  // from `errors` (it never blocks).
  const reconcile = scanReconcile(targetRoot, { root, importSource: importSourceRel(targetRoot, opts.import), excludeAgents: omit.has("AGENTS.md") });

  return { options: o, resolved, actions, warnings, root, reconcile, local, cfg: keptCfg, omitted, detected, playbooksOmittedBy };
}

// ---------------------------------------------------------------- apply
// Execute the plan, then run the TRL0002 core to fill the generated artifacts.
// Returns a summary { created, skipped, appended, generated, warnings }.
// `deferGenerate` (`init --import`, local mode) leaves the `.generated/` outputs to the
// import phase, so its source-overlap check runs before any output exists (TRL0038).
export function applyScaffold(targetRoot, opts = {}, { dryRun = false, deferGenerate = false } = {}, sourceRoot) {
  // `errors` is fatal (the run did not produce a --check-green scaffold);
  // `warnings` is benign (e.g. a missing copy source). The CLI keys its exit code
  // and "Refused" banner off `errors`, never off `warnings`.
  const summary = { created: [], skipped: [], appended: [], generated: [], omitted: [], printed: [], detected: null, playbooksOmittedBy: null, reconcile: [], warnings: [], errors: [] };

  // An unknown part name is refused before anything is planned or written.
  const parsedSkip = parseSkip(opts.skip || []);
  const conflicts = optionConflicts(parsedSkip.parts, !!opts.withPlaybooks);
  if (parsedSkip.errors.length || conflicts.length) {
    summary.errors.push(...parsedSkip.errors, ...conflicts);
    return { options: resolveOptions(opts), summary };
  }

  // planScaffold only reads, so the target stays untouched through every check
  // below — a rejected run leaves nothing behind. It also resolves the options
  // (no need to resolve again here).
  const { options, resolved, actions, warnings, root, reconcile, local, cfg: keptCfg, omitted, detected, playbooksOmittedBy } = planScaffold(targetRoot, { ...opts, skip: parsedSkip.parts }, sourceRoot);
  summary.omitted = omitted;
  summary.detected = detected;
  summary.playbooksOmittedBy = playbooksOmittedBy;
  summary.reconcile = reconcile; // advisory, populated even on a refusal (the CLI only prints it on success)
  const GENERATED = generatedFiles(targetRoot, root, local); // artifact rel-paths under the effective backlog root
  summary.root = root; // surfaced so the CLI can point at the actual scaffold root

  // Reject malformed *supplied* flags before any write — even when a kept config
  // means they won't be used to render, a bad flag is still a usage error.
  const optErrors = validateOptions(resolved);
  if (optErrors.length) {
    summary.errors.push(...optErrors);
    return { options, summary };
  }

  // Refuse to scaffold over an already-broken backlog/config — otherwise the
  // core-generate step below would fail and leave a half-written scaffold.
  const preErrors = preflight(targetRoot, options, !!opts.force);
  if (preErrors.length) {
    summary.errors.push(...preErrors);
    return { options, summary };
  }

  // Local mode: the shared writer preflight (leftover marker, sound output paths, every
  // output ignored and untracked) runs before anything is scaffolded. Init never edits
  // `.gitignore`; the refusal prints the line to add.
  if (local) {
    try {
      outputPreflight(targetRoot, keptCfg);
    } catch (e) {
      if (!(e instanceof OutputRefused)) throw e;
      summary.errors.push(e.message);
      return { options, summary };
    }
  }

  summary.warnings.push(...warnings); // non-fatal (e.g. a missing copy source)

  // README and the two indexes are written as marker skeletons here, then filled
  // by the core below — so they are reported under `generated`, not created.
  const genSet = new Set(GENERATED);
  // A print action is reported, never written, so it leaves the write loop below.
  for (const a of actions.filter((x) => x.action === "print")) summary.printed.push({ reason: a.reason, block: a.block, bytesNeeded: a.bytesNeeded });
  for (const a of actions.filter((x) => x.action !== "print")) {
    const isGen = genSet.has(a.rel);
    if (a.action === "skip") { if (!isGen) summary.skipped.push(a.rel); continue; }
    if (!dryRun) {
      const abs = join(targetRoot, a.rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content);
    }
    if (isGen) continue;
    (a.action === "append" ? summary.appended : summary.created).push(a.rel);
  }

  // Fill the generated artifacts via the shared core, so they are byte-identical
  // to what the onboarded repo's own generator would produce (--check-green). A
  // failure here is fatal, not benign: the repo would be left not --check-green,
  // so it goes to `errors` (preflight should already have caught the usual causes).
  if (dryRun) {
    summary.generated.push(...GENERATED);
  } else if (local && deferGenerate) {
    // The import regenerates the outputs once its own checks pass.
  } else {
    const { cfg, errors: cfgErrors } = loadConfig(targetRoot);
    const data = cfgErrors.length ? null : readBacklog(targetRoot, cfg);
    const genErrors = cfgErrors.length ? cfgErrors : data.errors;
    if (genErrors.length) {
      summary.errors.push(`generate failed: ${genErrors.join("; ")}`);
    } else {
      const { files, errors } = generateArtifacts(targetRoot, cfg, data, local ? { nextIdOverride: previewNextId(targetRoot, cfg) } : undefined);
      if (errors.length) {
        summary.errors.push(`generate failed: ${errors.join("; ")}`);
      } else {
        try {
          if (local) summary.warnings.push(...writeArtifactFiles(files).warnings);
          else for (const f of files) writeFileSync(f.path, f.content);
          summary.generated.push(...GENERATED);
        } catch (e) {
          if (!local) throw e;
          summary.errors.push(`generate failed: ${e.message}`);
        }
      }
    }
  }

  return { options, summary };
}

// --------------------------------------------------------- retire source
// Run git rooted at repoRoot with an arg array (NO shell). Mirrors src/history.mjs:
// capture stderr so the caller can classify a failure; never inherit it.
function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// First line of the most useful diagnostic from a failed git call.
function gitErr(e) {
  const s = (e && e.stderr ? String(e.stderr) : e && e.message ? e.message : String(e)).trim();
  return s.split("\n")[0] || "git error";
}

// History-preserving retirement of an imported source tree (TRL0027). Stages a
// `git rm -r` of <sourcePath> and leaves the deletion for the user to review and
// commit — it never creates a commit, mirroring how scaffold/import leave changes for
// review. Deliberately separate from import: run it as a late step once the import is
// green and committed, so the source tree is intact if anything rolls back.
//
// Refuses (writes nothing) unless the path is inside the repo, exists, the repo is a
// git work tree, and the path is git-tracked — a history-preserving removal needs a
// tracked path (git keeps the file's history after the staged deletion is committed),
// and an untracked path has no history to preserve. `dryRun` lists the tracked files
// without touching git. Returns { summary: { path, removed, errors, warnings } }.
export function retireSource(targetRoot, sourcePath, { dryRun = false } = {}) {
  const summary = { path: null, removed: [], errors: [], warnings: [] };
  if (!sourcePath || !String(sourcePath).trim()) {
    summary.errors.push("--retire-source requires a path");
    return { summary };
  }
  const abs = isAbsolute(sourcePath) ? sourcePath : join(targetRoot, sourcePath);
  const rel = relative(targetRoot, abs);
  // Stay inside the repo — never `git rm` a path outside the tree we were pointed at,
  // and never the repo root itself (empty rel).
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    summary.errors.push(`refusing to retire "${sourcePath}" — it is outside the repo (or is the repo root)`);
    return { summary };
  }
  summary.path = rel;
  if (!existsSync(abs)) {
    summary.errors.push(`nothing to retire at "${rel}" (path does not exist)`);
    return { summary };
  }
  // Must be a git work tree — retirement is history-preserving, so it needs git.
  try {
    if (git(targetRoot, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw new Error("not a work tree");
  } catch (e) {
    summary.errors.push(e && e.code === "ENOENT" ? "git is not available on PATH" : `not a git work tree: ${targetRoot}`);
    return { summary };
  }
  // The path must be tracked: `ls-files` lists exactly the tracked files under <rel>.
  // An untracked source has no history to preserve, and `git rm` would fail anyway.
  let tracked;
  try {
    tracked = git(targetRoot, ["ls-files", "-z", "--", rel]).split("\0").filter(Boolean);
  } catch (e) {
    summary.errors.push(`git ls-files failed: ${gitErr(e)}`);
    return { summary };
  }
  if (!tracked.length) {
    summary.errors.push(`"${rel}" is not tracked by git — nothing to retire (commit the import first; a history-preserving removal needs a tracked path)`);
    return { summary };
  }
  if (dryRun) {
    summary.removed = tracked;
    return { summary };
  }
  // `git rm -r` stages the deletion (index + working tree); the user reviews and commits.
  try {
    git(targetRoot, ["rm", "-r", "-q", "--", rel]);
  } catch (e) {
    summary.errors.push(`git rm failed: ${gitErr(e)}`);
    return { summary };
  }
  summary.removed = tracked;
  return { summary };
}
