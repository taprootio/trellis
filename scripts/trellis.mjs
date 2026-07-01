#!/usr/bin/env node
// Packaged Trellis CLI dispatcher.
//
// The subcommand wrappers keep their existing thin shape, while this file is the
// npm bin exposed by the `@taprootio/trellis` package. Run from an installed package, paths
// below are package-relative; target repos are still resolved by each subcommand
// from cwd / --target / --repo.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HELP = `trellis — file-based backlog toolkit

Usage:
  trellis <command> [args]

Commands:
  init       scaffold Trellis into a repo
  import     import an existing backlog into a Trellis repo
  generate   validate and rewrite generated backlog artifacts
  check      validate and fail if generated artifacts are stale
  history    derive per-task history from git
  mcp        serve Trellis operations over MCP stdio
  pr-title   lint a PR title from PR_TITLE

Run "trellis <command> --help" for command-specific options.
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
const scriptPath = join(here, script);
process.argv = [process.argv[0], scriptPath, ...prefixArgs, ...args];

try {
  await import(pathToFileURL(scriptPath).href);
} catch (e) {
  console.error(`error: failed to run ${cmd}: ${e && e.message ? e.message : String(e)}`);
  process.exit(1);
}
