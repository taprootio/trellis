#!/usr/bin/env node
// PR-title lint CLI — a thin wrapper over src/pr-title.mjs, run by the
// pr-title workflow on every pull_request.
//
//   PR_TITLE="TRL0016: add the lint" node scripts/pr-title-lint.mjs
//   PR_TITLE="DEMO0001: add the lint" ai-trellis pr-title --repo <target>
//
// Reads the title from $PR_TITLE (set from the pull_request event title) and the
// id vocabulary from the target repo's backlog.config.json, then exits non-zero on any
// violation. Logic lives in src/pr-title.mjs so it stays dependency-free and
// `node --test`-able.

import { resolve } from "node:path";
import { loadConfig } from "../src/backlog.mjs";
import { lintPrTitle } from "../src/pr-title.mjs";

const HELP = `ai-trellis pr-title — lint a pull request title

Usage:
  PR_TITLE="TASK0001: concise title" ai-trellis pr-title [--repo <target>]

Flags:
  --repo <target>    repo root whose Trellis id vocabulary should be used (default: cwd)
  --target <target>  alias for --repo
  -h, --help         show this help
`;

function parseArgs(argv) {
  const opts = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq !== -1 ? a.slice(eq + 1) : null;
    const next = (flag) => {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined || v === "" || (inline === null && v.startsWith("-"))) {
        console.error(`error: ${flag} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--repo": case "--target": opts.repo = next(key); break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        console.error(`Unexpected argument: ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

const repoRoot = resolve(opts.repo);

const { cfg, warnings, errors: cfgErrors } = loadConfig(repoRoot);
for (const w of warnings) console.log(`warning: ${w}`);
if (cfgErrors.length) {
  console.error("Cannot lint the PR title:\n" + cfgErrors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const title = process.env.PR_TITLE ?? "";
const { ok, errors } = lintPrTitle(title, cfg);
if (!ok) {
  console.error(`PR title does not conform to the standard:\n  title: ${JSON.stringify(title)}`);
  for (const e of errors) console.error("  - " + e);
  console.error("\nSee .github/pull_request_template.md / trellis/playbooks/pr-draft.md.");
  process.exit(1);
}
console.log(`PR title OK: ${title}`);
