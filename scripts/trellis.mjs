#!/usr/bin/env node
// Packaged Trellis CLI dispatcher.
//
// The subcommand wrappers keep their existing thin shape, while this file is the
// npm bin exposed by the `ai-trellis` package. Run from an installed package, paths
// below are package-relative; target repos are still resolved by each subcommand
// from cwd / --target / --repo.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HELP = `ai-trellis — file-based backlog toolkit

Usage:
  ai-trellis <command> [args]

Commands:
  init       scaffold Trellis into a repo
  import     import an existing backlog into a Trellis repo
  generate   validate and rewrite generated backlog artifacts
  check      validate and fail if generated artifacts are stale
  history    derive per-task history from git
  mcp        serve Trellis operations over MCP stdio
  pr-title   lint a PR title from PR_TITLE

Run "ai-trellis <command> --help" for command-specific options.
`;

const COMMANDS = {
  init: ["trellis-init.mjs"],
  import: ["trellis-import.mjs"],
  generate: ["backlog-readme.mjs"],
  check: ["backlog-readme.mjs", "--check"],
  history: ["trellis-history.mjs"],
  mcp: ["trellis-mcp.mjs"],
  "pr-title": ["pr-title-lint.mjs"],
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

const spec = COMMANDS[cmd];
if (!spec) {
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  process.exit(2);
}

const [script, ...prefixArgs] = spec;
const res = spawnSync(process.execPath, [join(here, script), ...prefixArgs, ...args], {
  stdio: "inherit",
});
if (res.error) {
  console.error(`error: failed to run ${cmd}: ${res.error.message}`);
  process.exit(1);
}
if (res.signal) {
  process.kill(process.pid, res.signal);
}
process.exit(res.status ?? 1);
