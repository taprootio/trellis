#!/usr/bin/env node
// Trellis init CLI — a thin wrapper over the scaffolder in src/init.mjs.
//
//   node scripts/trellis-init.mjs [target] [flags]
//
// Onboards the target repo (default ".") to the Trellis layout. Vocabulary comes
// from flags with sensible defaults; when run interactively with the prefix or
// milestones omitted, it prompts for them. Idempotent — existing files are never
// clobbered (use --force to overwrite). With `--import <path>` it then imports an
// existing backlog via a named profile or a mapping file — the onboard-a-repo-that-
// already-has-a-backlog on-ramp — reusing src/import.mjs and src/profiles.mjs. All
// logic lives under src/, so this stays free of third-party dependencies.

import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { DEFAULTS, applyScaffold, resolveOptions, validateOptions, retireSource } from "../src/init.mjs";
import { applyImport } from "../src/import.mjs";
import { loadProfile, loadMappingFile } from "../src/profiles.mjs";

const HELP = `trellis init — scaffold the Trellis backlog into a repo

Usage:
  node scripts/trellis-init.mjs [target] [flags]

Flags:
  --prefix <P>          id prefix (default: ${DEFAULTS.prefix})
  --id-width <N>        zero-padded id digits (default: ${DEFAULTS.idWidth})
  --milestones <a,b,c>  ordered maturity milestones (default: ${DEFAULTS.milestones.join(",")})
  --priorities <a,b,c>  ordered priorities, highest first (default: ${DEFAULTS.priorities.join(",")})
  --effort <1,2,3>      canonical effort values (default: ${DEFAULTS.effort.join(",")})
  --import <path>       after scaffolding, import an existing backlog at <path>
  --profile <name>      source-mapping profile for --import (trellis import --list-profiles)
  --mapping <file>      mapping file (JSON) for --import (alternative to --profile)
  --retire-source <p>   history-preservingly git-rm an imported source tree at <p>
                        (a separate, later step — see below; cannot combine with --import)
  --force               overwrite existing files instead of skipping
  --dry-run             report what would change without writing
  -h, --help            show this help

With --import, provide exactly one of --profile or --mapping; a relative <path>
resolves against the target repo. --dry-run previews the scaffold without writing;
preview the import plan itself with "trellis import --dry-run" on the initialized repo.

--retire-source removes the old source tree once the import is green and committed:
it stages a "git rm -r <p>" (history preserved) and leaves the deletion for you to
review and commit — it does not scaffold, import, or commit. Run it on its own, after
the import, never in the same command (--dry-run lists the files without touching git).
`;

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {};
  const csv = (s) => (s == null ? [] : s.split(",").map((x) => x.trim()).filter(Boolean));
  let target = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq !== -1 ? a.slice(eq + 1) : null;
    // Read a flag's value. `--flag=value` always uses the inline value; with the space
    // form, a following long-option token (`--x`) means the value was OMITTED — do not
    // swallow it. So `--retire-source --dry-run` is a missing path (caught as a usage
    // error) instead of a path literally named "--dry-run" with --dry-run silently lost,
    // which would turn an intended preview into a real staged `git rm`.
    const next = () => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--force": opts.force = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--import": opts.import = next(); break;
      case "--profile": opts.profile = next(); break;
      case "--mapping": opts.mapping = next(); break;
      case "--retire-source": opts.retireSource = next(); break;
      case "--prefix": opts.prefix = next(); break;
      case "--id-width": opts.idWidth = Number(next()); break;
      case "--milestones": opts.milestones = csv(next()); break;
      case "--priorities": opts.priorities = csv(next()); break;
      // Keep non-numeric tokens as NaN (don't filter) so a typo like
      // `--effort 1,abc,3` is rejected by validateOptions, not silently dropped.
      case "--effort": opts.effort = csv(next()).map(Number); break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        target = a;
    }
  }
  return { target, opts };
}

async function promptMissing(opts) {
  // Only prompt for the two the task calls out (prefix, milestones), and only
  // when interactive and not a dry run. A retire-only run doesn't scaffold, so it
  // never needs the vocabulary.
  if (opts.dryRun || opts.retireSource || !process.stdin.isTTY) return;
  if (opts.prefix && opts.milestones) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!opts.prefix) {
      const a = (await rl.question(`ID prefix [${DEFAULTS.prefix}]: `)).trim();
      if (a) opts.prefix = a;
    }
    if (!opts.milestones) {
      const a = (await rl.question(`Milestones [${DEFAULTS.milestones.join(",")}]: `)).trim();
      if (a) opts.milestones = a.split(",").map((x) => x.trim()).filter(Boolean);
    }
  } finally {
    rl.close();
  }
}

function report(targetRoot, summary, dryRun) {
  // Fatal errors → never claim success. "Refused" if nothing was written;
  // "did not complete" if some files landed before a fatal generate failure.
  if (summary.errors.length) {
    const wroteSomething = summary.created.length || summary.appended.length || summary.generated.length;
    console.error(wroteSomething
      ? `Scaffold of ${targetRoot} did not complete:`
      : `Refused to scaffold ${targetRoot} — wrote nothing:`);
    for (const e of summary.errors) console.error(`  - ${e}`);
    return;
  }
  const verb = dryRun ? "Would scaffold" : "Scaffolded";
  console.log(`${verb} Trellis into ${targetRoot}${dryRun ? " (dry run)" : ""}`);
  const line = (label, items) => { if (items.length) console.log(`  ${label} (${items.length}): ${items.join(", ")}`); };
  line(dryRun ? "create" : "created", summary.created);
  line(dryRun ? "append" : "appended", summary.appended);
  line(dryRun ? "regenerate" : "generated", summary.generated);
  line("skipped", summary.skipped);
  // Remaining warnings are benign (e.g. a missing copy source) — the scaffold
  // still completed, so they do not change the exit code.
  for (const w of summary.warnings) console.warn(`  warning: ${w}`);
  // Reconciliation checklist (TRL0027): stale backlog guidance for the agent to
  // rewrite. Advisory and report-only — init never edited these — so, like warnings,
  // it does not affect the exit code.
  if (summary.reconcile && summary.reconcile.length) {
    console.log(`  reconcile (${summary.reconcile.length}) — pre-Trellis backlog guidance to rewrite by hand (init left these untouched):`);
    for (const r of summary.reconcile) console.log(`    - ${r.file}: ${r.note}`);
  }
  if (!dryRun) {
    console.log(`Done. Next: add a task under ${summary.root}/active/, then \`npx trellis generate\`.`);
    console.log(`Then enable branch protection so the \`backlog\` check gates merges — see docs/branch-protection.md.`);
  }
}

// Usage errors for the --import on-ramp, validated before any write: --profile /
// --mapping only make sense with --import, and --import needs exactly one of them.
function importFlagErrors(opts) {
  const errors = [];
  const hasProfile = !!opts.profile, hasMapping = !!opts.mapping;
  if (!opts.import) {
    if (hasProfile || hasMapping) errors.push("--profile/--mapping only apply with --import <path>");
    return errors;
  }
  if (hasProfile === hasMapping) errors.push("--import requires exactly one of --profile <name> or --mapping <file>");
  return errors;
}

// --retire-source is a separate, later step — never automatic mid-import (TRL0027), so
// it cannot share a run with --import. Keyed on the flag's PRESENCE (not a truthy
// value): a valueless `--retire-source` (trailing flag, or `--retire-source=`) must be
// a usage error, not a silent fall-through to scaffolding.
function retireFlagErrors(opts) {
  if (!("retireSource" in opts)) return [];
  const errors = [];
  if (!opts.retireSource || !String(opts.retireSource).trim()) errors.push("--retire-source requires a path");
  if (opts.import) errors.push("--retire-source cannot be combined with --import — retire the source in a separate run after the import is committed");
  return errors;
}

// Concise report for the follow-on import (mirrors the trellis import CLI). Fatal
// errors never claim success; otherwise echo counts + the id map so the user can
// review before committing.
function reportImport(targetRoot, summary) {
  if (summary.errors.length) {
    const wrote = summary.created.length || summary.generated.length;
    console.error(wrote ? `Import into ${targetRoot} did not complete:` : `Refused to import into ${targetRoot} — wrote nothing:`);
    for (const e of summary.errors) console.error(`  - ${e}`);
    for (const w of summary.warnings) console.warn(`  warning: ${w}`);
    return;
  }
  const c = summary.counts || { total: 0, active: 0, completed: 0, removed: 0 };
  console.log(`Imported ${c.total} item${c.total === 1 ? "" : "s"} (${c.active} active, ${c.completed} completed, ${c.removed} removed).`);
  const pv = summary.provenance;
  if (pv && (pv.gitDated || pv.dateDefaulted || pv.effortEstimated)) {
    const parts = [];
    if (pv.gitDated) parts.push(`${pv.gitDated} git-dated`);
    if (pv.dateDefaulted) parts.push(`${pv.dateDefaulted} date-defaulted`);
    if (pv.effortEstimated) parts.push(`${pv.effortEstimated} effort-estimated`);
    console.log(`  estimated: ${parts.join(", ")}`);
  }
  if (summary.idMap.length) {
    console.log("  id map:");
    for (const m of summary.idMap) console.log(`    ${m.sourceId} (${m.sourceFile}) → ${m.newId}`);
  }
  for (const w of summary.warnings) console.warn(`  warning: ${w}`);
  console.log(`Done. Review ${summary.root}/, then commit.`);
}

// Report for --retire-source. A refusal (errors) never claims success; otherwise echo
// the staged-but-uncommitted removal and steer the user to review + commit.
function reportRetire(summary, dryRun) {
  if (summary.errors.length) {
    console.error(`Refused to retire ${summary.path ? `"${summary.path}"` : "the source"} — nothing changed:`);
    for (const e of summary.errors) console.error(`  - ${e}`);
    return;
  }
  const n = summary.removed.length;
  const files = `${n} tracked file${n === 1 ? "" : "s"}`;
  if (dryRun) {
    // List the files: a dry run stages nothing, so there is no `git status` to inspect —
    // the report is the only place the user sees exactly what would be removed.
    console.log(`Would retire "${summary.path}" — git rm ${files} (dry run, nothing changed):`);
    for (const f of summary.removed) console.log(`    ${f}`);
    return;
  }
  console.log(`Retired "${summary.path}" — staged the removal of ${files} with git rm.`);
  console.log("Review with `git status`, then commit. Git preserves the history.");
}

const { target, opts } = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

await promptMissing(opts);

// Scaffold vocabulary is irrelevant to a retire-only run (it never scaffolds), so don't
// validate it there — mirrors promptMissing, which also skips on retire.
if (!("retireSource" in opts)) {
  const optErrors = validateOptions(resolveOptions(opts));
  if (optErrors.length) {
    for (const e of optErrors) console.error(`error: ${e}`);
    process.exit(2);
  }
}

const flagErrors = [...importFlagErrors(opts), ...retireFlagErrors(opts)];
if (flagErrors.length) {
  for (const e of flagErrors) console.error(`error: ${e}`);
  process.exit(2);
}

const targetRoot = resolve(target);
const dryRun = !!opts.dryRun;

// --retire-source: a deliberate, standalone step run after the import is committed. It
// does not scaffold or import — it stages a history-preserving `git rm` of the source.
// Keyed on presence (a valueless flag was already rejected by retireFlagErrors).
if ("retireSource" in opts) {
  const { summary: ret } = retireSource(targetRoot, opts.retireSource, { dryRun });
  reportRetire(ret, dryRun);
  process.exit(ret.errors.length ? 1 : 0);
}

const { summary } = applyScaffold(targetRoot, opts, { dryRun }, sourceRoot);
report(targetRoot, summary, dryRun);
// A failed scaffold (refusal or generate failure) is fatal and blocks any import.
if (summary.errors.length) process.exit(1);

// --import on-ramp: scaffold, then import an existing backlog in one command.
if (opts.import) {
  const { mapping, error } = opts.profile ? loadProfile(opts.profile) : loadMappingFile(opts.mapping);
  if (error) { console.error(`error: ${error}`); process.exit(2); }
  const importSource = isAbsolute(opts.import) ? opts.import : resolve(targetRoot, opts.import);
  if (dryRun) {
    // A dry run scaffolds nothing, so there is no initialized target to plan the
    // import against — report intent and point at `trellis import --dry-run` (which
    // previews the full plan against an initialized repo) rather than computing a
    // misleading plan here against a non-existent backlog.
    const via = opts.profile ? `profile ${opts.profile}` : `mapping ${opts.mapping}`;
    console.log(`Would then import from ${importSource} using ${via}.`);
    console.log("Re-run without --dry-run to scaffold and import, or run `trellis import --dry-run` on the initialized repo to preview the import plan.");
    process.exit(0);
  }
  const { summary: imp } = applyImport(targetRoot, importSource, mapping, { dryRun: false });
  reportImport(targetRoot, imp);
  process.exit(imp.errors.length ? 1 : 0);
}

// A benign warning (e.g. a missing copy source) on a completed scaffold exits 0.
process.exit(0);
