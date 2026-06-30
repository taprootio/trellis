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
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";
import { optionToken, requiredValue, resolveRepoRoot, showHelp, usageError } from "../src/cli.mjs";

const HELP = `ai-trellis generate/check — validate and regenerate Trellis artifacts

Usage:
  ai-trellis generate [--target <repo>]
  ai-trellis check [--target <repo>]
  node scripts/backlog-readme.mjs [--check] [--target <repo>]

Flags:
  --target <repo>  repo root to operate on (default: cwd)
  --repo <repo>    alias for --target
  --check          validate only; fail if generated files are stale
  -h, --help       show this help
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

const data = readBacklog(repoRoot, cfg);
if (data.errors.length) die(data.errors);

const { files, nextId, errors } = generateArtifacts(repoRoot, cfg, data);
if (errors.length) die(errors);

if (isCheck) {
  const stale = files.filter((f) => (existsSync(f.path) ? readFileSync(f.path, "utf8") : "") !== f.content);
  if (stale.length) {
    for (const f of stale) console.error(`${rel(f.path)} is stale - run: npx ai-trellis generate`);
    process.exit(1);
  }
  console.log("Backlog check OK.");
} else {
  for (const f of files) writeFileSync(f.path, f.content);
  console.log(`Backlog OK: ${data.active.length} active, ${data.completed.length} completed, ${data.removed.length} removed. Next id: ${nextId}`);
}
