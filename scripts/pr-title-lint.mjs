#!/usr/bin/env node
// PR-title lint CLI — a thin wrapper over src/pr-title.mjs, run by the
// pr-title workflow on every pull_request.
//
//   PR_TITLE="TRL0016: add the lint" node scripts/pr-title-lint.mjs
//   PR_TITLE="DEMO0001: add the lint" trellis pr-title --repo <target>
//
// Reads the title from $PR_TITLE (set from the pull_request event title) and the
// id vocabulary from the target repo's backlog.config.json, then exits non-zero on any
// violation. Logic lives in src/pr-title.mjs so it stays dependency-free and
// `node --test`-able.

import { loadConfig } from "../src/backlog.mjs";
import { optionToken, requiredValue, resolveRepoRoot, showHelp, usageError } from "../src/cli.mjs";
import { lintPrTitle } from "../src/pr-title.mjs";

const HELP = `trellis pr-title — lint a pull request title

Usage:
  PR_TITLE="TASK0001: concise title" trellis pr-title [--repo <target>]

Flags:
  --repo <target>    repo root whose Trellis id vocabulary should be used (default: cwd)
  --target <target>  alias for --repo
  -h, --help         show this help
`;

function parseArgs(argv) {
  const opts = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const { key, inline } = optionToken(a);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--repo": case "--target": {
        const next = requiredValue(argv, i, inline, key);
        opts.repo = next.value;
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

const repoRoot = resolveRepoRoot(opts.repo);

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
