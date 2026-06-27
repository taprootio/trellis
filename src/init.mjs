// Trellis init scaffolder (zero-dependency).
//
// Onboards any repo to the Trellis layout: writes trellis/backlog.config.json,
// the trellis/ layout, the generated index (filled by the TRL0002 core), the CI
// workflow, an AGENTS.md backlog block, and the process playbooks — idempotently,
// never clobbering existing files.
//
// The generator itself is NOT vendored. The onboarded repo runs Trellis via the
// package (TRL0010), so the scaffolded CI calls `npx trellis check` and the
// AGENTS block points at `npx trellis ...`. Like the core, every entry point
// takes an explicit targetRoot and holds no process-wide state, so the CLI and a
// future MCP tool (TRL0004) can share it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPEC_VERSION, DEFAULT_TASKS_DIR, CONFIG_DIR, MARKERS, loadConfig, readBacklog, generateArtifacts, attachEffortScale } from "./backlog.mjs";

// The config home is fixed at `trellis/backlog.config.json` (CONFIG_DIR),
// independent of `tasksDir`. A fresh scaffold writes a config that omits
// `tasksDir`, so its task tree defaults to `trellis/` too. But a *kept* existing
// config may set a custom `tasksDir`; init must scaffold the tree there, not at
// the default — otherwise it writes `trellis/*` skeletons that the core then
// fails to fill against the configured root, leaving a partial scaffold. So the
// tree/marker/generated paths derive from the effective config's root, while the
// config path stays fixed.
const CONFIG_REL = `${CONFIG_DIR}/backlog.config.json`;
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
const AGENTS_MARKERS = ["<!-- BEGIN TRELLIS -->", "<!-- END TRELLIS -->"];

// Process files copied verbatim from the Trellis install (sourceRoot). Their
// value is the loop, not the exact command names; the AGENTS block below carries
// the authoritative `npx trellis` commands for the onboarded repo.
const COPY_FILES = [
  "docs/playbooks/conventions.md",
  "docs/playbooks/work-task.md",
  "docs/playbooks/code-review.md",
  "docs/playbooks/pr-draft.md",
  ".github/pull_request_template.md",
];

// The marker-based generated indexes (skeleton-then-filled), each paired with the
// exact begin/end marker the core requires — the single source of truth shared by
// the skeletons and the preflight check. Derived from the effective backlog root.
const markerFiles = (root) => [
  [`${root}/README.md`, MARKERS.milestones],
  [`${root}/completed/index.md`, MARKERS.completed],
  [`${root}/removed/index.md`, MARKERS.removed],
];

// The four generated artifacts, produced by the core after the skeletons land.
const generatedFiles = (root) => [...markerFiles(root).map(([rel]) => rel), `${root}/backlog.json`];

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
  if (data.errors.length) return [`target backlog has errors; fix them before init: ${data.errors.join("; ")}`];

  // A generated index we will KEEP must already carry its begin→end marker pair,
  // in order (begin before end), or the core can't fill it and the repo would
  // never be --check-green. Catch it here and refuse before writing. Under --force
  // we overwrite these files with fresh skeletons, so the check doesn't apply —
  // matching `begin[\s\S]*?end` in fillMarkers, an out-of-order or wrong-section
  // or unterminated pair fails.
  if (!force) {
    for (const [rel, [begin, end]] of markerFiles(root)) {
      const abs = join(targetRoot, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      const bi = text.indexOf(begin), ei = text.indexOf(end);
      if (bi === -1 || ei === -1 || bi >= ei) {
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

// Skeletons carry the exact begin/end markers from the core (via MARKERS), so the
// core can fill them and preflight can verify them with no string drift.
function markerSkeleton([begin, end], heading, blurb) {
  return `# ${heading}\n\n${blurb}\n\n${begin}\n${end}\n`;
}

function readmeSkeleton() {
  return markerSkeleton(
    MARKERS.milestones,
    "Backlog",
    "Managed with [Trellis](https://github.com/taprootio/trellis) — a file-based\n" +
      "backlog. See `AGENTS.md` for the schema and conventions. The tables below are\n" +
      "generated; do not hand-edit between the markers — edit the per-item files in\n" +
      "`active/`, then regenerate (`npx trellis generate`).",
  );
}

function completedSkeleton() {
  return markerSkeleton(
    MARKERS.completed,
    "Completed tasks",
    "Generated from `completed/tasks/`. Do not hand-edit between the markers — close\n" +
      "a task and regenerate (`npx trellis generate`).",
  );
}

function removedSkeleton() {
  return markerSkeleton(
    MARKERS.removed,
    "Removed tasks",
    "Generated from `removed/`. Do not hand-edit between the markers — remove a task\n" +
      "and regenerate (`npx trellis generate`).",
  );
}

function workflowContent() {
  // Job name `backlog` is the pinned required-check context (TRL0014). The check
  // runs via the Trellis package (TRL0010); it is red until that ships.
  return `name: Backlog Hygiene
on:
  pull_request:
  push:
    branches: [main]
jobs:
  backlog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npx --yes trellis check
`;
}

export function agentsBlock(o, root = DEFAULT_TASKS_DIR) {
  const [begin, end] = AGENTS_MARKERS;
  // A sample id (number 1, zero-padded to the repo's width) so the branch example
  // matches this repo's actual id format, not a hard-coded 4-digit one.
  const idExample = `${o.prefix.toLowerCase()}${String(1).padStart(o.idWidth, "0")}`;
  return `${begin}
## Backlog (Trellis)

This repo uses [Trellis](https://github.com/taprootio/trellis) for a file-based
backlog. Work items live in \`${root}/{active,completed/tasks,removed}/\` as
Markdown files with YAML front-matter; ids are \`${o.prefix}\` + ${o.idWidth} digits.

- \`${root}/README.md\`, \`${root}/backlog.json\`, and the
  \`${root}/completed/index.md\` / \`${root}/removed/index.md\` indexes are
  **generated** — never hand-edit between the \`BEGIN/END GENERATED\` markers.
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  \`trellis/backlog.config.json\` (the backlog root is \`trellis/\` by default;
  override it with a \`tasksDir\` key).
- After adding, moving, or editing an item, regenerate with \`npx trellis generate\`;
  CI runs \`npx trellis check\`.
- \`main\` is protected — work on a branch, open a PR, and let the backlog check
  gate the merge.
- Commit messages and PR descriptions carry no AI/co-author attribution — never
  add \`Co-Authored-By:\` trailers or "Generated with …" footers.

### Loop contract

The playbooks in \`docs/playbooks/\` are universal; they name **seam points** and
read this repo's values from here. See \`docs/playbooks/conventions.md\` for the
contract, then set these to match your tooling:

| seam point | this repo's value |
| --- | --- |
| \`regenerate\` | \`npx trellis generate\` |
| \`check\` | \`npx trellis check\` |
| \`branch-naming\` | \`<initials>/<id-lowercase>/<slug>\` (e.g. \`ab/${idExample}/short-slug\`) |
| \`gates\` | \`npx trellis check\` (plus this repo's tests/lint) |
| \`attribution\` | none — no \`Co-Authored-By:\` trailers or "Generated with …" footers |

See \`docs/playbooks/\` for the work-a-task and code-review loops.
${end}
`;
}

// Build the template files (everything except the generated artifacts, which the
// core fills in afterward). Returns [{ rel, content }].
function templateFiles(o, sourceRoot, root) {
  const files = [
    { rel: CONFIG_REL, content: configContent(o) },
    { rel: `${root}/active/.gitkeep`, content: "" },
    { rel: `${root}/completed/tasks/.gitkeep`, content: "" },
    { rel: `${root}/README.md`, content: readmeSkeleton() },
    { rel: `${root}/completed/index.md`, content: completedSkeleton() },
    { rel: `${root}/removed/index.md`, content: removedSkeleton() },
    { rel: ".github/workflows/backlog.yml", content: workflowContent() },
  ];
  const warnings = [];
  for (const rel of COPY_FILES) {
    const src = join(sourceRoot, rel);
    if (existsSync(src)) files.push({ rel, content: readFileSync(src, "utf8") });
    else warnings.push(`source not found, skipped copy: ${rel}`);
  }
  return { files, warnings };
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

  const actions = [];
  const { files, warnings } = templateFiles(o, sourceRoot, root);
  if (keepCfg && suppliedConflicts(opts, o)) {
    warnings.push(`existing backlog.config.json kept; its vocabulary governs (prefix \`${o.prefix}\`) — supplied flags ignored (use --force to overwrite)`);
  }

  for (const f of files) {
    const abs = join(targetRoot, f.rel);
    const exists = existsSync(abs);
    actions.push({
      rel: f.rel,
      content: f.content,
      action: exists && !force ? "skip" : "create",
    });
  }

  // AGENTS.md: create if absent, append the block if present without it, else skip.
  const agentsAbs = join(targetRoot, "AGENTS.md");
  const block = agentsBlock(o, root);
  if (!existsSync(agentsAbs)) {
    actions.push({ rel: "AGENTS.md", content: `# AGENTS\n\n${block}`, action: "create" });
  } else {
    const cur = readFileSync(agentsAbs, "utf8");
    if (cur.includes(AGENTS_MARKERS[0])) {
      actions.push({ rel: "AGENTS.md", content: "", action: "skip" });
    } else {
      const sep = cur.endsWith("\n") ? "\n" : "\n\n";
      actions.push({ rel: "AGENTS.md", content: cur + sep + block, action: "append" });
    }
  }

  return { options: o, resolved, actions, warnings, root };
}

// ---------------------------------------------------------------- apply
// Execute the plan, then run the TRL0002 core to fill the generated artifacts.
// Returns a summary { created, skipped, appended, generated, warnings }.
export function applyScaffold(targetRoot, opts = {}, { dryRun = false } = {}, sourceRoot) {
  // `errors` is fatal (the run did not produce a --check-green scaffold);
  // `warnings` is benign (e.g. a missing copy source). The CLI keys its exit code
  // and "Refused" banner off `errors`, never off `warnings`.
  const summary = { created: [], skipped: [], appended: [], generated: [], warnings: [], errors: [] };

  // planScaffold only reads, so the target stays untouched through every check
  // below — a rejected run leaves nothing behind. It also resolves the options
  // (no need to resolve again here).
  const { options, resolved, actions, warnings, root } = planScaffold(targetRoot, opts, sourceRoot);
  const GENERATED = generatedFiles(root); // artifact rel-paths under the effective backlog root
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

  summary.warnings.push(...warnings); // non-fatal (e.g. a missing copy source)

  // README and the two indexes are written as marker skeletons here, then filled
  // by the core below — so they are reported under `generated`, not created.
  const genSet = new Set(GENERATED);
  for (const a of actions) {
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
  } else {
    const { cfg, errors: cfgErrors } = loadConfig(targetRoot);
    const data = cfgErrors.length ? null : readBacklog(targetRoot, cfg);
    const genErrors = cfgErrors.length ? cfgErrors : data.errors;
    if (genErrors.length) {
      summary.errors.push(`generate failed: ${genErrors.join("; ")}`);
    } else {
      const { files, errors } = generateArtifacts(targetRoot, cfg, data);
      if (errors.length) {
        summary.errors.push(`generate failed: ${errors.join("; ")}`);
      } else {
        for (const f of files) writeFileSync(f.path, f.content);
        summary.generated.push(...GENERATED);
      }
    }
  }

  return { options, summary };
}
