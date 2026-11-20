#!/usr/bin/env node
// Trellis backlog CLI — a thin wrapper over the reusable core in src/backlog.mjs.
//
//   node scripts/backlog-readme.mjs                    # rewrite generated files in cwd
//   node scripts/backlog-readme.mjs --check             # fail if any generated file is stale
//   node scripts/backlog-readme.mjs --target <repo>     # operate on another repo
//
// Logic lives in src/backlog.mjs so the MCP server can share it. This stays
// dependency-free on purpose (see SPEC.md §5 / the front-matter parser).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import { loadConfig, readBacklog, generateArtifacts, checkGenerated, validateLocal, isLocalMode } from "../src/backlog.mjs";
import { LedgerError, preview, refuseSymlinkedArtifacts, artifactPaths } from "../src/ledger.mjs";
import { outputPreflight, writeArtifactFiles } from "../src/local-output.mjs";
import { optionToken, requiredValue, resolveRepoRoot, showHelp, usageError } from "../src/cli.mjs";

const HELP = `trellis generate/check — validate and regenerate Trellis artifacts

Usage:
  trellis generate [--target <repo>]
  trellis check [--target <repo>]
  node scripts/backlog-readme.mjs [--check] [--target <repo>]

Flags:
  --target <repo>  repo root to operate on (default: cwd)
  --repo <repo>    alias for --target
  --check          validate only; fail if generated files are stale
                   (generatedArtifacts "local": validate config, roster and items
                   and scan for leftover generated markers; nothing is compared)
  -h, --help       show this help

With generatedArtifacts "local", generate writes index.md, completed.md,
removed.md and backlog.json under <tasksDir>/.generated/ instead of the
committed README and index files. That folder must be ignored by git.
`;

function parseArgs(argv) {
  const opts = { target: process.cwd(), check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const { key, inline } = optionToken(a);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--check": opts.check = true; break;
      case "--target": case "--repo": {
        const next = requiredValue(argv, i, inline, key);
        opts.target = next.value;
        i = next.index;
        break;
      }
      default:
        if (a.startsWith("-")) usageError(`Unknown flag: ${a}`);
        usageError(`Unexpected argument: ${a}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) showHelp(HELP);

const repoRoot = resolveRepoRoot(opts.target);
const isCheck = opts.check;
const rel = (p) => relative(repoRoot, p);

function die(errors) {
  console.error("Backlog validation failed:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const { cfg, warnings, errors: cfgErrors } = loadConfig(repoRoot);
for (const w of warnings) console.warn(`warning: ${w}`);
if (cfgErrors.length) die(cfgErrors);

const local = isLocalMode(cfg);

// A refused write (exit 2) names the problem and writes nothing.
function refuse(e) {
  if (!(e instanceof LedgerError)) throw e;
  console.error(e.message);
  process.exit(e.exitCode);
}

// Local mode and ledger mode refuse a bad output path, and local mode a leftover
// marker or an unignored output, before anything is rendered. The check stays
// git-free and read-only, so it skips this.
if (!isCheck) {
  try {
    outputPreflight(repoRoot, cfg);
    if (cfg.idAllocation === "ledger") refuseSymlinkedArtifacts(artifactPaths(repoRoot, cfg));
  } catch (e) {
    refuse(e);
  }
}

// Local check: config, roster, items and the marker scan, in one order; no
// generated file exists in git to compare.
if (isCheck && local) {
  const { errors } = validateLocal(repoRoot, cfg);
  if (errors.length) die(errors);
  console.log("Backlog check OK.");
  process.exit(0);
}

const data = readBacklog(repoRoot, cfg);
if (data.errors.length) die(data.errors);

// A local ledger repo publishes the ledger preview in its uncommitted backlog.json.
// The preview is read once, so the file and the printed note agree.
const pv = !isCheck && cfg.idAllocation === "ledger" ? preview(repoRoot, cfg) : null;
const nextIdOverride = local && pv ? pv.nextId : undefined;
const { files, nextId, errors } = isCheck ? checkGenerated(repoRoot, cfg, data) : generateArtifacts(repoRoot, cfg, data, { nextIdOverride });
if (errors.length) die(errors);

if (isCheck) {
  const stale = files.filter((f) => (existsSync(f.path) ? readFileSync(f.path, "utf8") : "") !== f.content);
  if (stale.length) {
    for (const f of stale) console.error(`${rel(f.path)} is stale - run: npx @taprootio/trellis generate`);
    process.exit(1);
  }
  console.log("Backlog check OK.");
} else {
  if (local) {
    try {
      for (const w of writeArtifactFiles(files).warnings) console.warn(`warning: ${w}`);
    } catch (e) {
      console.error(`Could not write the generated files: ${e.message}`);
      process.exit(1);
    }
  } else {
    for (const f of files) writeFileSync(f.path, f.content);
  }
  // In ledger mode ids come from `trellis claim`, so the scan value is not the next id.
  const idNote = pv ? pv.note : `Next id: ${nextId}`;
  console.log(`Backlog OK: ${data.active.length} active, ${data.completed.length} completed, ${data.removed.length} removed. ${idNote}`);
}
