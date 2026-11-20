// Probes once whether this machine's git can run the id-ledger integration tests
// (git 2.45.1 or later, and `git init --ref-format=files` works). Suites skip only
// their ledger tests when it cannot, so scan-mode tests still run on older git.

import { test } from "node:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitVersionSupported } from "../src/ledger.mjs";

function probe() {
  const v = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (v.status !== 0 || !gitVersionSupported(v.stdout)) return false;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trellis-gitprobe-")));
  try {
    return spawnSync("git", ["-C", dir, "init", "-q", "--ref-format=files", "-b", "main"], { stdio: "ignore" }).status === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const ledgerGitSupported = probe();
export const ledgerSkipReason = ledgerGitSupported ? false : "needs git 2.45.1 or later with --ref-format=files";

// `git init` flags for a fixture: the files ref format only where git knows it.
export const initRefFormat = ledgerGitSupported ? ["--ref-format=files"] : [];

// `test` for ledger integration tests: skipped when git cannot run them.
export function ledgerTest(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const skip = opts.skip || ledgerSkipReason;
  return test(name, { ...opts, skip }, fn);
}
