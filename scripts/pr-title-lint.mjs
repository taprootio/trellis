#!/usr/bin/env node
// PR-title lint CLI — a thin wrapper over src/pr-title.mjs, run by the
// pr-title workflow on every pull_request.
//
//   PR_TITLE="TRL0016: add the lint" node scripts/pr-title-lint.mjs
//
// Reads the title from $PR_TITLE (set from the pull_request event title) and the
// id vocabulary from this repo's backlog.config.json, then exits non-zero on any
// violation. Logic lives in src/pr-title.mjs so it stays dependency-free and
// `node --test`-able.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/backlog.mjs";
import { lintPrTitle } from "../src/pr-title.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { cfg, warnings, errors: cfgErrors } = loadConfig(repoRoot);
for (const w of warnings) console.warn(`warning: ${w}`);
if (cfgErrors.length) {
  console.error("Cannot lint the PR title:\n" + cfgErrors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const title = process.env.PR_TITLE ?? "";
const { ok, errors } = lintPrTitle(title, cfg);
if (!ok) {
  console.error(`PR title does not conform to the standard:\n  title: ${JSON.stringify(title)}`);
  for (const e of errors) console.error("  - " + e);
  console.error("\nSee .github/pull_request_template.md / docs/playbooks/pr-draft.md.");
  process.exit(1);
}
console.log(`PR title OK: ${title}`);
