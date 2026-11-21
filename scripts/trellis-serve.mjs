#!/usr/bin/env node
// Trellis serve CLI (TRL0005): a local, read-only viewer for one or more backlogs.
//
//   trellis serve [--config <file>] [--repo|--target <path>] [--port <n>] [--bind <address>]
//                 [--allow-host <name>]...
//
// `runServe` returns an exit code (a number) or a running server handle and never calls
// process.exit, so tests drive it in-process. Exit 2 is a usage error, 1 a config, build or
// listen failure.

import { existsSync, realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { optionToken } from "../src/cli.mjs";
import {
  DEFAULT_BIND, DEFAULT_PORT, ViewerConfigError, findConfigFile, isLoopbackBind, loadViewerConfig, normalizeHost, singleRepoConfig,
} from "../src/viewer/config.mjs";
import { DEFAULT_DIST_DIR, startViewer } from "../src/viewer/server.mjs";

export const HELP = `trellis serve — a local, read-only viewer for one or more backlogs

Usage:
  trellis serve [--config <file>] [--repo <path>] [--port <n>] [--bind <address>] [--allow-host <name>]...

Flags:
  --config <file>     viewer config (JSON); cannot be combined with --repo
  --repo <path>       serve that one repo, as a one-entry config
  --target <path>     alias for --repo
  --port <n>          port to listen on (default 4747; 0 picks a free one)
  --bind <address>    address to listen on (default 127.0.0.1); a non-loopback address
                      exposes the backlogs beyond this machine and prints a warning
  --allow-host <name> accept this Host name too (repeatable); adds to the config's allowedHosts
  -h, --help          show this help

Without --config or --repo the config is $TRELLIS_VIEWER_CONFIG, then
$XDG_CONFIG_HOME/trellis/viewer.json, then ~/.config/trellis/viewer.json. When none exists,
the current directory's repo is served.

The config is read once at startup; restart the viewer after changing it. Each backlog shows
its repo's main worktree, so reading needs git 2.36 or later (git worktree list
--porcelain -z). A backlog with idAllocation "ledger" needs git 2.45.1 or later with the
files ref format for its next id; without that the next id is shown as unknown.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const { key, inline } = optionToken(a);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--config": case "--repo": case "--target": case "--port": case "--bind": case "--allow-host": {
        const value = inline !== null ? inline : argv[i + 1];
        if (value === undefined || value === "" || (inline === null && value.startsWith("-"))) throw new UsageError(`error: ${key} requires a value`);
        if (inline === null) i++;
        if (key === "--allow-host") opts.allowHosts.push(value);
        else if (key === "--target" || key === "--repo") {
          if (opts.repo !== undefined) throw new UsageError("error: give --repo (or --target) once");
          opts.repo = value;
        } else opts[key.slice(2)] = value;
        break;
      }
      default:
        throw new UsageError(a.startsWith("-") ? `Unknown flag: ${a}` : `Unexpected argument: ${a}`);
    }
  }
  if (opts.repo !== undefined && opts.config !== undefined) throw new UsageError("error: --repo and --config cannot be combined");
  if (opts.port !== undefined && !(/^\d+$/.test(opts.port) && Number(opts.port) <= 65535)) throw new UsageError("error: --port must be a number from 0 to 65535");
  return opts;
}

export async function runServe(argv, {
  distDir = DEFAULT_DIST_DIR, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), env = process.env,
  homedir = osHomedir(), watch = true,
} = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(e.message);
    return 2;
  }
  if (opts.help) { stdout.write(HELP); return 0; }

  const extraHosts = [];
  for (const h of opts.allowHosts) {
    const name = normalizeHost(h);
    if (name === null) { err(`error: --allow-host ${h} must be a bare host name`); return 2; }
    extraHosts.push(name);
  }

  let config;
  let configNote;
  try {
    if (opts.config !== undefined) {
      const file = resolve(cwd, opts.config);
      if (!existsSync(file)) throw new ViewerConfigError(`config file not found: ${file}`);
      config = loadViewerConfig(file, { homedir });
      configNote = `config: ${file}`;
    } else if (opts.repo !== undefined) {
      config = singleRepoConfig(opts.repo, { cwd });
    } else {
      const file = findConfigFile({ cwd, env, homedir });
      if (file) { config = loadViewerConfig(file, { homedir }); configNote = `config: ${file}`; } else config = singleRepoConfig(".", { cwd });
    }
  } catch (e) {
    if (!(e instanceof ViewerConfigError)) throw e;
    err(`error: ${e.message}`);
    return 1;
  }
  configNote ??= `no config file; serving ${config.backlogs[0].path}`;

  if (!existsSync(join(distDir, "index.html"))) {
    err(`error: the viewer is not built (no index.html in ${distDir}); run \`npm run build:viewer\``);
    return 1;
  }

  const port = opts.port !== undefined ? Number(opts.port) : config.port ?? DEFAULT_PORT;
  const bind = opts.bind ?? config.bind ?? DEFAULT_BIND;
  let handle;
  try {
    handle = await startViewer({ entries: config.backlogs, port, bind, allowedHosts: [...config.allowedHosts, ...extraHosts], distDir, watch });
  } catch (e) {
    err(`error: cannot listen on ${bind}:${port} (${e.code || e.message})`);
    return 1;
  }
  out(`trellis viewer: ${handle.url}`);
  out(configNote);
  // Judge the address the socket got, not the bind string: a name or alias can resolve anywhere.
  const bound = handle.server.address().address;
  if (!isLoopbackBind(bound)) err(`warning: listening on ${bound}; the backlogs are exposed beyond this machine`);
  return handle;
}

// Run only as the entry point: `node scripts/trellis-serve.mjs` or `trellis serve`, where the
// dispatcher points argv[1] here. Importing this file (a test) starts nothing.
function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const result = await runServe(process.argv.slice(2));
  if (typeof result === "number") {
    process.exitCode = result;
  } else {
    const stop = () => { result.close().finally(() => process.exit(0)); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
