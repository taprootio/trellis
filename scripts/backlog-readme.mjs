#!/usr/bin/env node
// Trellis backlog CLI — a thin wrapper over the reusable core in src/backlog.mjs.
//
//   node scripts/backlog-readme.mjs          # validate, then rewrite the generated files
//   node scripts/backlog-readme.mjs --check  # validate, fail if any generated file is stale
//
// Logic lives in src/backlog.mjs so the MCP server can share it. This stays
// dependency-free on purpose (see SPEC.md §5 / the front-matter parser).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, readBacklog, generateArtifacts } from "../src/backlog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isCheck = process.argv.includes("--check");
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
    for (const f of stale) console.error(`${rel(f.path)} is stale - run: npm run backlog:readme`);
    process.exit(1);
  }
  console.log("Backlog check OK.");
} else {
  for (const f of files) writeFileSync(f.path, f.content);
  console.log(`Backlog OK: ${data.active.length} active, ${data.completed.length} completed, ${data.removed.length} removed. Next id: ${nextId}`);
}
