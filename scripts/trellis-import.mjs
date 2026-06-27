#!/usr/bin/env node
// Trellis import CLI — a thin wrapper over the engine in src/import.mjs.
//
//   node scripts/trellis-import.mjs <source> --mapping <file.json> [flags]
//
// Imports an existing backlog (at <source>) into the target Trellis repo using a
// declarative mapping (see src/import.mjs for the shape). DRY-RUN BY DEFAULT — it
// prints the plan, the id map, and per-field warnings without writing; pass
// --apply to actually write items and regenerate. The source tree is never
// modified. Logic lives in src/import.mjs so the MCP import tool (TRL0022) can
// share it; this stays dependency-free. No source-specific mapping ships here —
// bring your own with --mapping; named profiles are TRL0022.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyImport } from "../src/import.mjs";

const HELP = `trellis import — import an existing backlog into Trellis

Usage:
  node scripts/trellis-import.mjs <source> --mapping <file.json> [flags]

Flags:
  --mapping <file>   declarative mapping file (JSON) describing the source schema (required)
  --target <dir>     target Trellis repo (default: ".")
  --apply            write items and regenerate (default: dry-run, write nothing)
  --dry-run          report the plan only (the default)
  -h, --help         show this help

The source tree is read-only. Ids are assigned fresh-sequentially from the target's
next id; colliding source ids are deduped and depends_on is rewritten accordingly.
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

function loadMapping(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`error: cannot read mapping file ${file}: ${e.message}`); process.exit(2); }
  try { return JSON.parse(text); } catch (e) { console.error(`error: mapping file ${file} is not valid JSON: ${e.message}`); process.exit(2); }
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
if (!source) { console.error("error: a <source> path is required\n"); process.stdout.write(HELP); process.exit(2); }
if (!opts.mapping) { console.error("error: --mapping <file.json> is required"); process.exit(2); }

const mapping = loadMapping(opts.mapping);
const sourceRoot = resolve(source);
const targetRoot = resolve(opts.target || ".");
const dryRun = !opts.apply; // dry-run by default; --apply opts into writing

const { summary } = applyImport(targetRoot, sourceRoot, mapping, { dryRun });
report(targetRoot, summary, dryRun);
process.exit(summary.errors.length ? 1 : 0);
