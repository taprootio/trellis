#!/usr/bin/env node
// Trellis init CLI — a thin wrapper over the scaffolder in src/init.mjs.
//
//   node scripts/trellis-init.mjs [target] [flags]
//
// Onboards the target repo (default ".") to the Trellis layout. Vocabulary comes
// from flags with sensible defaults; when run interactively with the prefix or
// milestones omitted, it prompts for them. Idempotent — existing files are never
// clobbered (use --force to overwrite). Logic lives in src/init.mjs so the MCP
// server (TRL0004) can share it; this stays dependency-free.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { DEFAULTS, applyScaffold, resolveOptions, validateOptions } from "../src/init.mjs";

const HELP = `trellis init — scaffold the Trellis backlog into a repo

Usage:
  node scripts/trellis-init.mjs [target] [flags]

Flags:
  --prefix <P>          id prefix (default: ${DEFAULTS.prefix})
  --id-width <N>        zero-padded id digits (default: ${DEFAULTS.idWidth})
  --milestones <a,b,c>  ordered maturity milestones (default: ${DEFAULTS.milestones.join(",")})
  --priorities <a,b,c>  ordered priorities, highest first (default: ${DEFAULTS.priorities.join(",")})
  --effort <1,2,3>      canonical effort values (default: ${DEFAULTS.effort.join(",")})
  --force               overwrite existing files instead of skipping
  --dry-run             report what would change without writing
  -h, --help            show this help
`;

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {};
  const csv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  let target = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq !== -1 ? a.slice(eq + 1) : null;
    const next = () => (inline !== null ? inline : argv[++i]);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--force": opts.force = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--prefix": opts.prefix = next(); break;
      case "--id-width": opts.idWidth = Number(next()); break;
      case "--milestones": opts.milestones = csv(next()); break;
      case "--priorities": opts.priorities = csv(next()); break;
      // Keep non-numeric tokens as NaN (don't filter) so a typo like
      // `--effort 1,abc,3` is rejected by validateOptions, not silently dropped.
      case "--effort": opts.effort = csv(next()).map(Number); break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        target = a;
    }
  }
  return { target, opts };
}

async function promptMissing(opts) {
  // Only prompt for the two the task calls out (prefix, milestones), and only
  // when interactive and not a dry run.
  if (opts.dryRun || !process.stdin.isTTY) return;
  if (opts.prefix && opts.milestones) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!opts.prefix) {
      const a = (await rl.question(`ID prefix [${DEFAULTS.prefix}]: `)).trim();
      if (a) opts.prefix = a;
    }
    if (!opts.milestones) {
      const a = (await rl.question(`Milestones [${DEFAULTS.milestones.join(",")}]: `)).trim();
      if (a) opts.milestones = a.split(",").map((x) => x.trim()).filter(Boolean);
    }
  } finally {
    rl.close();
  }
}

function report(targetRoot, summary, dryRun) {
  // Fatal errors → never claim success. "Refused" if nothing was written;
  // "did not complete" if some files landed before a fatal generate failure.
  if (summary.errors.length) {
    const wroteSomething = summary.created.length || summary.appended.length || summary.generated.length;
    console.error(wroteSomething
      ? `Scaffold of ${targetRoot} did not complete:`
      : `Refused to scaffold ${targetRoot} — wrote nothing:`);
    for (const e of summary.errors) console.error(`  - ${e}`);
    return;
  }
  const verb = dryRun ? "Would scaffold" : "Scaffolded";
  console.log(`${verb} Trellis into ${targetRoot}${dryRun ? " (dry run)" : ""}`);
  const line = (label, items) => { if (items.length) console.log(`  ${label} (${items.length}): ${items.join(", ")}`); };
  line(dryRun ? "create" : "created", summary.created);
  line(dryRun ? "append" : "appended", summary.appended);
  line(dryRun ? "regenerate" : "generated", summary.generated);
  line("skipped", summary.skipped);
  // Remaining warnings are benign (e.g. a missing copy source) — the scaffold
  // still completed, so they do not change the exit code.
  for (const w of summary.warnings) console.warn(`  warning: ${w}`);
  if (!dryRun) console.log("Done. Next: add a task under trellis/active/, then `npx trellis generate`.");
}

const { target, opts } = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

await promptMissing(opts);

const optErrors = validateOptions(resolveOptions(opts));
if (optErrors.length) {
  for (const e of optErrors) console.error(`error: ${e}`);
  process.exit(2);
}

const targetRoot = resolve(target);
const { summary } = applyScaffold(targetRoot, opts, { dryRun: !!opts.dryRun }, sourceRoot);
report(targetRoot, summary, !!opts.dryRun);
// Exit non-zero only on a fatal error (refusal or generate failure); a benign
// warning (e.g. a missing copy source) on a completed scaffold exits 0.
process.exit(summary.errors.length ? 1 : 0);
