#!/usr/bin/env node
// Trellis history CLI — a thin wrapper over the deriver in src/history.mjs.
//
//   node scripts/trellis-history.mjs [<id>] [--repo <path>] [--json] [--write [--out <file>]]
//
// Reconstructs per-task change history from git (SPEC §8.4 — a derived, NON-gated
// report). With an <id>, shows that task's history; without, the whole repo. `--write`
// materializes history.json for a static viewer / site build. This report is volatile
// (commit times, authors) and is deliberately NOT part of `backlog:check` and NOT
// produced by `backlog:readme` — git, not Trellis, is the authoritative record. Logic
// lives in src/history.mjs so the MCP `history` tool shares it; this stays
// dependency-free.

import { resolve } from "node:path";
import { loadConfig } from "../src/backlog.mjs";
import { deriveTaskHistory, deriveAllHistory, materializeHistory, HistoryError } from "../src/history.mjs";

const HELP = `trellis history — git-derived per-task history

Usage:
  node scripts/trellis-history.mjs [<id>] [flags]

Flags:
  --repo <path>   repo root to derive from (default: cwd)
  --json          emit structured JSON instead of a human summary
  --write         materialize history.json (whole repo) for a static viewer / CI build
  --out <file>    output path for --write (default: <tasksDir>/history.json)
  -h, --help      show this help

With <id>: that task's entries (newest-first). Without: the whole repo. Entries are
{ id, commit, date, author, subject, reason }; reason is the Trellis-Reason commit
trailer when present, else the subject. This report is NOT gated by backlog:check.
`;

function parseArgs(argv) {
  const opts = {};
  let id;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq !== -1 ? a.slice(eq + 1) : null;
    const next = () => (inline !== null ? inline : argv[++i]);
    switch (key) {
      case "-h": case "--help": opts.help = true; break;
      case "--json": opts.json = true; break;
      case "--write": opts.write = true; break;
      case "--repo": opts.repo = next(); break;
      case "--out": opts.out = next(); break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        if (id === undefined) id = a;
        else { console.error(`Unexpected extra argument: ${a}`); process.exit(2); }
    }
  }
  return { id, opts };
}

const shortSha = (s) => s.slice(0, 9);
const shortDate = (s) => s.slice(0, 10);

function printTaskHuman(id, entries) {
  if (!entries.length) { console.log(`${id}: no recorded history (not committed yet).`); return; }
  console.log(`${id} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (newest first):`);
  for (const e of entries) {
    console.log(`  ${shortDate(e.date)}  ${shortSha(e.commit)}  ${e.author}`);
    console.log(`      ${e.subject}`);
    if (e.reason !== e.subject) console.log(`      reason: ${e.reason}`);
  }
}

function printAllHuman(tasks) {
  const ids = Object.keys(tasks);
  const entryCount = ids.reduce((n, k) => n + tasks[k].length, 0);
  console.log(`History — ${ids.length} task${ids.length === 1 ? "" : "s"}, ${entryCount} entr${entryCount === 1 ? "y" : "ies"}:`);
  for (const id of ids) {
    const es = tasks[id];
    if (!es.length) { console.log(`  ${id}  (no recorded history)`); continue; }
    const last = es[0];
    console.log(`  ${id}  ${es.length} entr${es.length === 1 ? "y" : "ies"}  last: ${shortDate(last.date)} ${last.author} — ${last.subject}`);
  }
}

const { id, opts } = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

const repoRoot = resolve(opts.repo || ".");
const { cfg, errors } = loadConfig(repoRoot);
if (errors.length) { console.error(`error: config: ${errors.join("; ")}`); process.exit(2); }

try {
  if (opts.write) {
    // Materializing is whole-repo by nature (keyed by every id); an id would imply a
    // partial file, so refuse it rather than silently ignore.
    if (id !== undefined) { console.error("error: --write materializes the whole repo; omit the <id>"); process.exit(2); }
    const res = materializeHistory(repoRoot, cfg, { out: opts.out });
    console.log(`Wrote ${res.path} — ${res.taskCount} task${res.taskCount === 1 ? "" : "s"}, ${res.entryCount} entr${res.entryCount === 1 ? "y" : "ies"} (${res.bytes} bytes).`);
    console.log("This is a regenerable, non-gated cache (git is authoritative); it is gitignored — regenerate at build time.");
  } else if (id !== undefined) {
    const { entries } = deriveTaskHistory(repoRoot, cfg, id);
    if (opts.json) process.stdout.write(JSON.stringify({ id, entries }, null, 2) + "\n");
    else printTaskHuman(id, entries);
  } else {
    const all = deriveAllHistory(repoRoot, cfg);
    if (opts.json) process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    else printAllHuman(all.tasks);
  }
} catch (e) {
  if (e instanceof HistoryError) { console.error(`error: ${e.message}`); process.exit(1); }
  throw e;
}
