#!/usr/bin/env node
// Trellis import CLI — a thin wrapper over the engine in src/import.mjs.
//
//   node scripts/trellis-import.mjs <source> (--profile <name> | --mapping <file>) [flags]
//
// Imports an existing backlog (at <source>) into the target Trellis repo using a
// declarative mapping — either a built-in named profile (--profile, see
// src/profiles.mjs) or your own mapping file (--mapping, see src/import.mjs for the
// shape). DRY-RUN BY DEFAULT — it prints the plan, the id map, and per-field
// warnings without writing; pass --apply to actually write items and regenerate.
// The source tree is never modified. Logic lives in src/import.mjs and
// src/profiles.mjs so the MCP import tool and `init --import` share it; this stays
// dependency-free.

import { resolve } from "node:path";
import { applyImport } from "../src/import.mjs";
import { loadProfile, loadMappingFile, listProfiles } from "../src/profiles.mjs";

const HELP = `trellis import — import an existing backlog into Trellis

Usage:
  node scripts/trellis-import.mjs <source> (--profile <name> | --mapping <file>) [flags]

Flags:
  --profile <name>   built-in source-mapping profile (see --list-profiles)
  --mapping <file>   declarative mapping file (JSON) describing the source schema
  --target <dir>     target Trellis repo (default: ".")
  --apply            write items and regenerate (default: dry-run, write nothing)
  --dry-run          report the plan only (the default)
  --list-profiles    list the built-in profiles and exit
  -h, --help         show this help

Provide exactly one of --profile or --mapping. The source tree is read-only; ids
are assigned fresh-sequentially from the target's next id, colliding source ids are
deduped, and depends_on is rewritten accordingly. Relative <source> paths resolve
against the target repo.
`;

function parseArgs(argv) {
  const opts = {};
  let source;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq !== -1 ? a.slice(eq + 1) : null;
    const next = () => (inline !== null ? inline : argv[++i]);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--apply": opts.apply = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--list-profiles": opts.listProfiles = true; break;
      case "--profile": opts.profile = next(); break;
      case "--mapping": opts.mapping = next(); break;
      case "--target": opts.target = next(); break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        if (source === undefined) source = a;
        else { console.error(`Unexpected extra argument: ${a}`); process.exit(2); }
    }
  }
  return { source, opts };
}

function report(targetRoot, summary, dryRun) {
  if (summary.errors.length) {
    const wrote = summary.created.length || summary.generated.length;
    console.error(wrote ? `Import of ${targetRoot} did not complete:` : `Refused to import into ${targetRoot} — wrote nothing:`);
    for (const e of summary.errors) console.error(`  - ${e}`);
    // Even on refusal, the id map + warnings help the user fix the mapping — e.g.
    // see which source ids collided behind an ambiguous depends_on.
    if (summary.idMap.length) {
      console.error("  id map:");
      for (const m of summary.idMap) console.error(`    ${m.sourceId} (${m.sourceFile}) → ${m.newId}`);
    }
    for (const w of summary.warnings) console.warn(`  warning: ${w}`);
    return;
  }
  const c = summary.counts || { total: 0, active: 0, completed: 0, removed: 0 };
  const verb = dryRun ? "Would import" : "Imported";
  console.log(`${verb} ${c.total} item${c.total === 1 ? "" : "s"} into ${targetRoot}${dryRun ? " (dry run)" : ""}`);
  console.log(`  counts: ${c.active} active, ${c.completed} completed, ${c.removed} removed`);
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
  if (summary.generated.length) console.log(`  ${dryRun ? "regenerate" : "generated"} (${summary.generated.length}): ${summary.generated.join(", ")}`);
  for (const w of summary.warnings) console.warn(`  warning: ${w}`);
  if (!dryRun) console.log(`Done. Review ${summary.root}/, then commit.`);
  else console.log("Dry run — nothing written. Re-run with --apply to write.");
}

const { source, opts } = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

if (opts.listProfiles) {
  const profiles = listProfiles();
  if (!profiles.length) { console.log("No built-in profiles found."); process.exit(0); }
  console.log("Built-in profiles:");
  for (const p of profiles) console.log(`  ${p.name}${p.description ? ` — ${p.description}` : ""}`);
  process.exit(0);
}

if (!source) { console.error("error: a <source> path is required\n"); process.stdout.write(HELP); process.exit(2); }
// Exactly one of --profile / --mapping (XOR via boolean coercion).
if (!!opts.profile === !!opts.mapping) {
  console.error("error: provide exactly one of --profile <name> or --mapping <file.json>");
  process.exit(2);
}

const { mapping, error } = opts.profile ? loadProfile(opts.profile) : loadMappingFile(opts.mapping);
if (error) { console.error(`error: ${error}`); process.exit(2); }

const targetRoot = resolve(opts.target || ".");
const sourceRoot = resolve(targetRoot, source); // relative <source> resolves against the target repo
const dryRun = opts.dryRun || !opts.apply; // dry-run by default; --apply writes, but an explicit --dry-run always wins

const { summary } = applyImport(targetRoot, sourceRoot, mapping, { dryRun });
report(targetRoot, summary, dryRun);
process.exit(summary.errors.length ? 1 : 0);
