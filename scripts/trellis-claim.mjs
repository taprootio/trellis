#!/usr/bin/env node
// Trellis claim CLI — a thin wrapper over the id ledger in src/ledger.mjs.
//
//   node scripts/trellis-claim.mjs --title "<one line>" [--repo <path>]
//   node scripts/trellis-claim.mjs --seed [--through <ID>]
//   node scripts/trellis-claim.mjs --through <ID>
//   node scripts/trellis-claim.mjs --list
//
// Hands out task ids from a local git ledger (SPEC §3.1, TRL0037) so parallel
// worktrees never claim the same id. Exit 0 on success, 2 when refused with
// nothing written (wrong mode, no ledger, bad input), 1 when git or the retries
// fail. Logic lives in src/ledger.mjs so the MCP `claim_id` tool shares it.

import { loadConfig } from "../src/backlog.mjs";
import { optionToken, requiredValue, resolveRepoRoot, showHelp, usageError } from "../src/cli.mjs";
import { LedgerError, claim, through, seed, list } from "../src/ledger.mjs";

const HELP = `trellis claim — claim task ids from the local id ledger

Usage:
  trellis claim --title "<one line>"     claim the next id and print it
  trellis claim --seed [--through <ID>]  create the ledger from the ids in every worktree
  trellis claim --through <ID>           record every id up to <ID> as taken
  trellis claim --list                   print the ledger tip and its lines

Flags:
  --title <text>   one-line title for the claim (needs idAllocation "ledger")
  --seed           create the ledger when absent; works in either mode and is a no-op
                   when the ledger exists
  --through <ID>   high-water mark for ids held on branches no worktree has checked out
  --list           print the tip's object id, then every ledger line
  --target <repo>  repo root to operate on (default: cwd)
  --repo <repo>    alias for --target
  -h, --help       show this help

The ledger is the ref idLedgerRef (default refs/trellis/ids) in this clone. Nothing is
pushed. See SPEC.md §3.1 for the cutover and recovery rules.
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const { key, inline } = optionToken(a);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--seed": opts.seed = true; break;
      case "--list": opts.list = true; break;
      case "--title": case "--through": case "--target": case "--repo": {
        const next = requiredValue(argv, i, inline, key);
        opts[key === "--repo" ? "target" : key.slice(2)] = next.value;
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

const modes = [opts.title !== undefined && "--title", opts.seed && "--seed", opts.list && "--list"].filter(Boolean);
if (opts.through !== undefined && !opts.seed) modes.push("--through");
if (modes.length === 0) usageError("error: give one of --title, --seed, --through or --list (see --help)");
if (modes.length > 1) usageError(`error: ${modes.join(" and ")} cannot be combined`);

const repoRoot = resolveRepoRoot(opts.target);
const { cfg, warnings, errors } = loadConfig(repoRoot);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) { console.error(`error: config: ${errors.join("; ")}`); process.exit(2); }

try {
  if (opts.title !== undefined) {
    const out = claim(repoRoot, cfg, { title: opts.title });
    console.log(out.id);
  } else if (opts.seed) {
    const out = seed(repoRoot, cfg, { through: opts.through });
    if (out.created) {
      console.log(`Created the id ledger (${out.rows} row${out.rows === 1 ? "" : "s"}, tip ${out.tip.slice(0, 9)}).`);
    } else {
      console.log(`The id ledger already exists${out.raced ? " (another seed won the race)" : ""}; nothing was written.`);
      if (out.ignoredThrough) console.log("--through was ignored. To add a high-water mark to an existing ledger, run: trellis claim --through <ID>");
    }
  } else if (opts.through !== undefined) {
    const out = through(repoRoot, cfg, opts.through);
    console.log(`Recorded ${out.id} as a high-water mark (tip ${out.tip.slice(0, 9)}).`);
  } else {
    const out = list(repoRoot, cfg);
    console.log(`tip ${out.tip}`);
    console.log("id\tdate\tkind\tbranch\ttitle");
    for (const r of out.rows) console.log(`${r.id}\t${r.date}\t${r.kind}\t${r.branch}\t${r.title}`);
  }
} catch (e) {
  if (e instanceof LedgerError) { console.error(`error: ${e.message}`); process.exit(e.exitCode); }
  throw e;
}
