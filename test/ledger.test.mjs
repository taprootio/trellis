// Behavior tests for the local id ledger (src/ledger.mjs, SPEC §3.1), run via
// `node --test`. Each test builds a throwaway git repo with linked worktrees and
// drives the module directly; the git-level seams use a `git` shim first on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, chmodSync, symlinkSync, readFileSync, existsSync, readdirSync, renameSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  LedgerError, testSeams, claim, through, seed, list, preview, readLedger, scanIds, ledgerIdMatcher, gitVersionSupported, refuseSymlinkedArtifacts,
} from "../src/ledger.mjs";

const LEDGER_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ledger.mjs")).href;
const REF = "refs/trellis/ids";
const BASE_CFG = {
  specVersion: "2.5", idPrefix: "DEMO", idWidth: 4, idAllocation: "ledger",
  milestones: ["Alpha"], priorities: ["High"], effort: [1, 2, 3],
};

const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `trellis-${name}-`)));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A clone with one commit, so linked worktrees can be added.
function makeClone(cfgOverrides = {}) {
  const dir = tmp("ledger");
  const root = join(dir, "main");
  mkdirSync(root);
  git(root, "init", "-q", "--ref-format=files", "-b", "main");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "user.email", "tester@example.com");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const cfg = { ...BASE_CFG, ...cfgOverrides };
  return {
    dir, root, cfg,
    lane(name) {
      const path = join(dir, name);
      git(root, "worktree", "add", "-q", "-b", name, path);
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const withClone = (fn, cfg) => {
  const c = makeClone(cfg);
  try { return fn(c); } finally { c.cleanup(); }
};

function item(wt, status, id, title = "A title") {
  const dir = join(wt, "trellis", ...(status === "completed" ? ["completed", "tasks"] : [status]));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n\nBody.\n`);
  return file;
}

const tip = (root, ref = REF) => git(root, "rev-parse", "--verify", "-q", ref);
const tipOrNull = (root, ref = REF) => { try { return tip(root, ref); } catch { return null; } };
const claimsText = (root) => git(root, "show", `${REF}:claims.tsv`);

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function assertRefused(fn, code, exitCode = 2) {
  assert.throws(fn, (e) => e instanceof LedgerError && e.code === code && e.exitCode === exitCode, `expected a ${code} refusal`);
}

// Add a competing ledger commit by claiming from another worktree.
const rival = (wt, cfg, title = "rival") => claim(wt, cfg, { title });

// ----------------------------------------------------------------- basics

test("claims hand out distinct consecutive ids from two worktrees", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    assert.equal(seed(root, cfg).created, true);
    const a = claim(root, cfg, { title: "first" });
    const b = claim(other, cfg, { title: "second" });
    const c = claim(root, cfg, { title: "third" });
    assert.deepEqual([a.id, b.id, c.id], ["DEMO0001", "DEMO0002", "DEMO0003"]);
    const rows = list(root, cfg).rows;
    assert.deepEqual(rows.map((r) => r.kind), ["claim", "claim", "claim"]);
    assert.deepEqual(rows.map((r) => r.branch), ["main", "lane", "main"]);
    assert.equal(git(root, "rev-list", "--count", REF), "4", "one commit per write, seed included");
    assert.ok(git(root, "reflog", "show", REF), "the ref keeps a reflog");
  });
});

test("claims run in parallel processes without a duplicate id", async () => {
  const c = makeClone();
  try {
    const other = c.lane("lane");
    seed(c.root, c.cfg);
    const runner = join(c.dir, "runner.mjs");
    writeFileSync(runner, `
      import { claim } from ${JSON.stringify(LEDGER_URL)};
      const [root, n] = process.argv.slice(2);
      const cfg = ${JSON.stringify(c.cfg)};
      const ids = [];
      for (let i = 0; i < Number(n); i++) ids.push(claim(root, cfg, { title: "p" + i }).id);
      console.log(JSON.stringify(ids));
    `);
    const run = (root) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [runner, root, "5"], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
    });
    const [x, y] = await Promise.all([run(c.root), run(other)]);
    const all = [...x, ...y].sort();
    assert.equal(new Set(all).size, 10);
    assert.deepEqual(all, Array.from({ length: 10 }, (_, i) => `DEMO${String(i + 1).padStart(4, "0")}`));
  } finally { c.cleanup(); }
});

test("a lost compare-and-swap retries (beforeUpdate)", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    seed(root, cfg);
    let rivalDone = false;
    const mine = claim(root, cfg, {
      title: "mine",
      beforeUpdate: () => { if (!rivalDone) { rivalDone = true; rival(other, cfg); } },
    });
    assert.equal(mine.attempts, 2);
    assert.equal(mine.id, "DEMO0002");
    assert.deepEqual(list(root, cfg).rows.map((r) => r.id), ["DEMO0001", "DEMO0002"]);
  });
});

test("a claim that hits a held ref lock with the tip unchanged retries", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const lock = join(common, "refs", "trellis", "ids.lock");
    const mine = claim(root, cfg, {
      title: "mine",
      // Attempt 1: another writer holds the lock, so update-ref fails with the tip
      // unchanged. Attempt 2: the lock is gone and the claim lands.
      beforeUpdate: ({ attempt }) => {
        if (attempt === 1) writeFileSync(lock, "");
        else rmSync(lock, { force: true });
      },
    });
    assert.equal(mine.attempts, 2);
    assert.equal(mine.id, "DEMO0001");
  });
});

test("retries run out with exit 1 when every attempt loses", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    seed(root, cfg);
    assertRefused(() => claim(root, cfg, { title: "mine", beforeUpdate: () => rival(other, cfg) }), "conflict", 1);
    assert.equal(list(root, cfg).rows.length, 10, "only the rival's claims landed");
  });
});

// A `git` first on PATH that runs a competing writer at a chosen moment, then
// the real git. The competitor runs with SHIM_OFF so it bypasses the shim.
function installShim(dir, { on, competitor }) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const mark = join(dir, "shim-mark");
  writeFileSync(mark, "armed");
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ -z "$SHIM_OFF" ] && [ -f "${mark}" ]; then
  for a in "$@"; do
    if [ "$a" = "${on}" ]; then
      rm -f "${mark}"
      ${on === "--exists" ? `"${real}" "$@"; st=$?; SHIM_OFF=1 "${process.execPath}" "${competitor}"; exit $st` : `SHIM_OFF=1 "${process.execPath}" "${competitor}"`}
    fi
  done
fi
exec "${real}" "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

test("a lost compare-and-swap retries (git shim)", { skip: process.platform === "win32" }, () => {
  const c = makeClone();
  try {
    const other = c.lane("lane");
    seed(c.root, c.cfg);
    const competitor = join(c.dir, "rival.mjs");
    writeFileSync(competitor, `import { claim } from ${JSON.stringify(LEDGER_URL)};
      claim(${JSON.stringify(other)}, ${JSON.stringify(c.cfg)}, { title: "shim rival" });`);
    const bin = installShim(c.dir, { on: "update-ref", competitor });
    const out = withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => claim(c.root, c.cfg, { title: "mine" }));
    assert.equal(out.attempts, 2);
    assert.equal(out.id, "DEMO0002");
  } finally { c.cleanup(); }
});

// ------------------------------------------------------------------- seed

test("seed is idempotent", () => {
  withClone(({ root, cfg }) => {
    const first = seed(root, cfg);
    const t = tip(root);
    const second = seed(root, cfg);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(tip(root), t);
    assert.equal(seed(root, cfg, { through: "DEMO0050" }).ignoredThrough, true, "an existing ledger ignores --through");
    assert.equal(tip(root), t);
  });
});

test("seed works in scan mode and before the config switches", () => {
  withClone(({ root, cfg }) => {
    assert.equal(seed(root, cfg).created, true);
  }, { idAllocation: "scan" });
});

test("seed records an id held only in a linked worktree, with its branch", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    item(root, "active", "DEMO0002", "On main");
    item(other, "active", "DEMO0007", "Only on the lane");
    seed(root, cfg);
    const rows = list(root, cfg).rows;
    assert.deepEqual(rows.map((r) => [r.id, r.kind, r.branch, r.title]), [
      ["DEMO0002", "seed", "main", "On main"],
      ["DEMO0007", "seed", "lane", "Only on the lane"],
    ]);
    assert.equal(claim(root, cfg, { title: "next" }).id, "DEMO0008");
  });
});

test("seed --through writes the through row in the seed commit; the next claim is above it", () => {
  withClone(({ root, cfg }) => {
    item(root, "active", "DEMO0003");
    seed(root, cfg, { through: "DEMO0040" });
    assert.equal(git(root, "rev-list", "--count", REF), "1");
    const rows = list(root, cfg).rows;
    assert.deepEqual(rows.map((r) => r.kind), ["seed", "through"]);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0041");
  });
});

test("seed titles are cleaned, and an unreadable or unsafe file gives '-' with the id kept", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg }) => {
    const odd = item(root, "active", "DEMO0001", "Tab\there and\x01control");
    const hidden = item(root, "active", "DEMO0002");
    // Root can read a mode-000 file, so only the other three cases hold for it.
    const asRoot = process.getuid && process.getuid() === 0;
    chmodSync(hidden, 0o000);
    const stagedOnly = item(root, "active", "DEMO0003");
    git(root, "add", stagedOnly);
    rmSync(stagedOnly);
    execFileSync("mkfifo", [join(root, "trellis", "active", "DEMO0004.md")]);
    try {
      seed(root, cfg);
    } finally { chmodSync(hidden, 0o644); }
    assert.ok(odd);
    const rows = list(root, cfg).rows;
    assert.deepEqual(rows.map((r) => r.id), ["DEMO0001", "DEMO0002", "DEMO0003", "DEMO0004"]);
    assert.equal(rows[0].title, "Tab here and control");
    if (!asRoot) assert.equal(rows[1].title, "-");
    assert.deepEqual(rows.slice(2).map((r) => r.title), ["-", "-"]);
  });
});

test("a seed that loses to another valid seed exits 0 and leaves the winner's tip", () => {
  const c = makeClone();
  try {
    const rivalClone = c.lane("lane");
    item(rivalClone, "active", "DEMO0009");
    const competitor = join(c.dir, "rival-seed.mjs");
    writeFileSync(competitor, `import { seed } from ${JSON.stringify(LEDGER_URL)};
      seed(${JSON.stringify(rivalClone)}, ${JSON.stringify(c.cfg)});`);
    const bin = installShim(c.dir, { on: "--exists", competitor });
    const out = withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => seed(c.root, c.cfg));
    assert.equal(out.created, false);
    assert.equal(out.tip, tip(c.root), "the winner's tip is untouched");
    assert.equal(git(c.root, "rev-list", "--count", REF), "1");
  } finally { c.cleanup(); }
});

test("two parallel seed processes leave one seed commit", async () => {
  const c = makeClone();
  try {
    const runner = join(c.dir, "seeder.mjs");
    writeFileSync(runner, `import { seed } from ${JSON.stringify(LEDGER_URL)};
      seed(process.argv[2], ${JSON.stringify(c.cfg)});`);
    const run = () => new Promise((resolve) => spawn(process.execPath, [runner, c.root], { stdio: "inherit" }).on("exit", resolve));
    const codes = await Promise.all([run(), run()]);
    assert.deepEqual(codes, [0, 0]);
    assert.equal(git(c.root, "rev-list", "--count", REF), "1");
  } finally { c.cleanup(); }
});

test("a seed that fails on a lock exits 1 and writes nothing", () => {
  withClone(({ root, cfg }) => {
    const common = git(root, "rev-parse", "--git-common-dir");
    mkdirSync(join(root, common, "refs", "trellis"), { recursive: true });
    writeFileSync(join(root, common, "refs", "trellis", "ids.lock"), "");
    assertRefused(() => seed(root, cfg), "git_failed", 1);
    assert.equal(tipOrNull(root), null);
  });
});

// ---------------------------------------------------------------- through

test("through appends one line and the next claim is above it", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    through(root, cfg, "DEMO0100");
    const rows = list(root, cfg).rows;
    assert.deepEqual(rows.map((r) => [r.id, r.kind, r.branch, r.title]), [["DEMO0100", "through", "-", "-"]]);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0101");
  });
});

test("through racing a claim keeps both lines", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    seed(root, cfg);
    let raced = false;
    through(root, cfg, "DEMO0100", { beforeUpdate: () => { if (!raced) { raced = true; rival(other, cfg); } } });
    assert.deepEqual(list(root, cfg).rows.map((r) => r.kind), ["claim", "through"]);
  });
});

test("through and list refuse with the ref absent, naming --seed; through checks the id", () => {
  withClone(({ root, cfg }) => {
    for (const fn of [() => through(root, cfg, "DEMO0100"), () => list(root, cfg), () => claim(root, cfg, { title: "x" })]) {
      assert.throws(fn, (e) => e.exitCode === 2 && e.code === "missing_ledger" && e.message.includes("--seed"));
    }
    seed(root, cfg);
    for (const bad of ["TRL0100", "DEMO100", "demo0100", "DEMO0100\n", 5]) {
      assertRefused(() => through(root, cfg, bad), "invalid_request");
    }
  });
});

// ------------------------------------------------------- limits and floors

test("a floor-only ledger hands out the floor", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO1000");
  }, { nextIdFloor: 1000 });
});

test("at the width limit a claim exits 2 with no write and preview is null with the reason", () => {
  withClone(({ root, cfg }) => {
    item(root, "active", "DEMO99");
    seed(root, cfg);
    const t = tip(root);
    assertRefused(() => claim(root, cfg, { title: "x" }), "exhausted");
    assert.equal(tip(root), t);
    const p = preview(root, cfg);
    assert.equal(p.nextId, null);
    assert.match(p.note, /exhausted/);
  }, { idWidth: 2 });
});

test("preview returns the next id without changing the ref", () => {
  withClone(({ root, cfg }) => {
    assert.equal(preview(root, cfg).nextId, null);
    assert.match(preview(root, cfg).note, /trellis claim --seed/);
    assert.match(preview(root, cfg).note, /--through .*upper bound/);
    seed(root, cfg);
    const t = tip(root);
    const p = preview(root, cfg);
    assert.equal(p.nextId, "DEMO0001");
    assert.equal(tip(root), t);
  });
});

test("preview reports git unavailable instead of throwing", () => {
  withClone(({ root, cfg }) => {
    const empty = tmp("nopath");
    try {
      const p = withEnv({ PATH: empty }, () => preview(root, cfg));
      assert.equal(p.nextId, null);
      assert.equal(p.reason, "git_unavailable");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

// -------------------------------------------------------- mode and inputs

test("claim exits 2 in scan mode, and refuses a title that could forge a row", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    const t = tip(root);
    assertRefused(() => claim(root, { ...cfg, idAllocation: "scan" }, { title: "x" }), "invalid_request");
    for (const title of ["a\nb", "a\tb", "a\rb", "a\x00b", "", "   ", undefined, "x".repeat(201)]) {
      assertRefused(() => claim(root, cfg, { title }), "invalid_request");
    }
    assert.equal(tip(root), t);
  });
});

test("titles count code points; seed truncation never splits an emoji", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    // 200 emoji are 400 UTF-16 units but 200 code points, so they are accepted.
    assert.equal(claim(root, cfg, { title: "\u{1F600}".repeat(200) }).id, "DEMO0001");
    assertRefused(() => claim(root, cfg, { title: "\u{1F600}".repeat(201) }), "invalid_request");
  });
  withClone(({ root, cfg }) => {
    item(root, "active", "DEMO0001", "x".repeat(199) + "\u{1F600}tail");
    seed(root, cfg);
    const title = list(root, cfg).rows[0].title;
    assert.equal(title, "x".repeat(199) + "\u{1F600}");
    assert.ok(!/[\ud800-\udfff]/.test(title.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), "no lone surrogate");
  });
});

test("rows are never written with a prefix that is not plain", () => {
  for (const idPrefix of ["A,B", "R+", "A.B", "A B"]) {
    withClone(({ root, cfg }) => {
      assertRefused(() => seed(root, cfg), "invalid_request");
      assertRefused(() => seed(root, cfg, { through: "x" }), "invalid_request");
      assertRefused(() => through(root, cfg, `${idPrefix}0001`), "invalid_request");
      assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_request");
      assert.equal(tipOrNull(root), null);
    }, { idPrefix, idAllocation: "scan" });
  }
});

test("git without a configured identity can still claim", () => {
  const c = makeClone();
  try {
    const home = tmp("home");
    const cfgFile = join(home, "gitconfig");
    writeFileSync(cfgFile, "[user]\n\tuseConfigOnly = true\n");
    git(c.root, "config", "--unset", "user.name");
    git(c.root, "config", "--unset", "user.email");
    withEnv({ GIT_CONFIG_GLOBAL: cfgFile, GIT_CONFIG_NOSYSTEM: "1", HOME: home }, () => {
      seed(c.root, c.cfg);
      claim(c.root, c.cfg, { title: "anon" });
    });
    assert.equal(git(c.root, "log", "-1", "--format=%an <%ae>", REF), "trellis <trellis@localhost>");
    rmSync(home, { recursive: true, force: true });
  } finally { c.cleanup(); }
});

test("a custom idLedgerRef is used", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    assert.ok(tip(root, "refs/trellis/other"));
    assert.equal(tipOrNull(root, REF), null);
  }, { idLedgerRef: "refs/trellis/other" });
});

// ------------------------------------------------------- readLedger outcomes

const rawLedger = (root, text, { ref = REF, file = "claims.tsv", mode = "100644" } = {}) => {
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", root, "mktree"], { input: `${mode} blob ${blob}\t${file}\n`, encoding: "utf8" }).trim();
  const commit = git(root, "commit-tree", tree, "-m", "raw");
  git(root, "update-ref", ref, commit);
  return commit;
};

const HEADER = "id\tdate\tkind\tbranch\ttitle\n";

test("readLedger tells missing, unusable and valid apart", () => {
  withClone(({ root, cfg }) => {
    assert.deepEqual(readLedger(root, cfg), { missing: true });
    rawLedger(root, HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\tok\n");
    const ok = readLedger(root, cfg);
    assert.equal(ok.rows.length, 1);
    assert.equal(ok.tip, tip(root));
    rawLedger(root, "garbage\n");
    assert.ok(readLedger(root, cfg).unusable);
  });
});

test("a bad row, tree or tip makes the ledger unusable and every write refuses", () => {
  const bad = {
    "wrong header": "id\tdate\n",
    "missing trailing newline": HEADER.slice(0, -1),
    "four fields": HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\n",
    "six fields": HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\tt\textra\n",
    "bad id": HEADER + "TRL0001\t2026-11-19\tclaim\tmain\tt\n",
    "short id": HEADER + "DEMO001\t2026-11-19\tclaim\tmain\tt\n",
    "bad date": HEADER + "DEMO0001\t2026-02-30\tclaim\tmain\tt\n",
    "date out of range": HEADER + "DEMO0001\t2026-13-45\tclaim\tmain\tt\n",
    "bad kind": HEADER + "DEMO0001\t2026-11-19\tmystery\tmain\tt\n",
    "empty title": HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\t\n",
    "control in title": HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\tt\x01\n",
    "line separator in title": HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\tt\u2028u\n",
    "next-line character in branch": HEADER + "DEMO0001\t2026-11-19\tclaim\tma\u0085in\tt\n",
    "blank line": HEADER + "\n",
    "leading BOM": "\uFEFF" + HEADER,
    "through row with a branch": HEADER + "DEMO0001\t2026-11-19\tthrough\tmain\t-\n",
  };
  for (const [name, text] of Object.entries(bad)) {
    withClone(({ root, cfg }) => {
      const commit = rawLedger(root, text);
      assert.ok(readLedger(root, cfg).unusable, name);
      assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
      assertRefused(() => seed(root, cfg), "invalid_ledger");
      assertRefused(() => through(root, cfg, "DEMO0009"), "invalid_ledger");
      assertRefused(() => list(root, cfg), "invalid_ledger");
      assert.equal(tip(root), commit, `${name}: ref unchanged`);
    });
  }
});

test("a tip that is not a commit, or whose tree is not one claims.tsv, is refused", () => {
  withClone(({ root, cfg }) => {
    const tree = git(root, "rev-parse", "HEAD^{tree}");
    git(root, "update-ref", REF, tree);
    assert.match(readLedger(root, cfg).unusable, /commit/);
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
    assert.equal(tip(root), tree);

    rawLedger(root, HEADER, { file: "other.tsv" });
    assert.match(readLedger(root, cfg).unusable, /exactly one/);
    rawLedger(root, HEADER, { mode: "100755" });
    assert.ok(readLedger(root, cfg).unusable);
    const twoFiles = git(root, "rev-parse", "HEAD^{tree}");
    const c2 = git(root, "commit-tree", twoFiles, "-m", "whole tree");
    git(root, "update-ref", REF, c2);
    assert.ok(readLedger(root, cfg).unusable);
  });
});

test("a symbolic ledger ref, even a dangling one, is refused and left alone", () => {
  withClone(({ root, cfg }) => {
    git(root, "symbolic-ref", REF, "refs/trellis/elsewhere");
    assert.match(readLedger(root, cfg).unusable, /symbolic/);
    assertRefused(() => seed(root, cfg), "invalid_ledger");
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
    assert.equal(git(root, "symbolic-ref", REF), "refs/trellis/elsewhere");
    assert.equal(tipOrNull(root, "refs/trellis/elsewhere"), null, "no write followed the link");

    rawLedger(root, HEADER, { ref: "refs/trellis/real" });
    git(root, "symbolic-ref", REF, "refs/trellis/real");
    assert.match(readLedger(root, cfg).unusable, /symbolic/);
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
  });
});

test("git unavailable is a refusal, not a crash", () => {
  withClone(({ root, cfg }) => {
    const empty = tmp("nopath");
    try {
      withEnv({ PATH: empty }, () => assertRefused(() => readLedger(root, cfg), "git_unavailable"));
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

test("a directory that is not a git work tree is refused", () => {
  const dir = tmp("plain");
  try {
    assertRefused(() => readLedger(dir, BASE_CFG), "not_a_git_repo");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the git version floor is 2.45.1", () => {
  assert.equal(gitVersionSupported("git version 2.44.1"), false, "no --show-ref-format before 2.45");
  assert.equal(gitVersionSupported("git version 2.45.1"), true);
  assert.equal(gitVersionSupported("git version 2.55.0"), true);
  assert.equal(gitVersionSupported("git version 2.39.3 (Apple Git-146)"), false);
  assert.equal(gitVersionSupported("git version 3.0.0"), true);
  assert.equal(gitVersionSupported("git version 2.45.1.windows.1"), true);
  assert.equal(gitVersionSupported("git version 2.45.0"), false, "2.45.0 is below the floor");
  assert.equal(gitVersionSupported("git version 2.45.0.windows.1"), false);
  assert.equal(gitVersionSupported("not git"), false);
});

// ----------------------------------------------------------- worktree scan

test("a worktree path containing a newline is scanned", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg, dir }) => {
    const odd = join(dir, "with\nnewline");
    git(root, "worktree", "add", "-q", "-b", "odd", odd);
    item(odd, "active", "DEMO0012");
    seed(root, cfg);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0013");
  });
});

test("a missing worktree directory is skipped", () => {
  withClone(({ root, cfg, lane }) => {
    const gone = lane("gone");
    rmSync(gone, { recursive: true, force: true });
    seed(root, cfg);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0001");
  });
});

test("the scan counts the index and HEAD, not just the disk (seed and claim)", () => {
  const setups = {
    "staged item whose disk copy is gone": (wt) => {
      const f = item(wt, "active", "DEMO0020");
      git(wt, "add", f);
      rmSync(f);
    },
    "committed item whose deletion is staged": (wt) => {
      const f = item(wt, "active", "DEMO0020");
      git(wt, "add", f);
      git(wt, "commit", "-q", "-m", "item");
      git(wt, "rm", "-q", "--cached", f);
      rmSync(f);
    },
  };
  for (const [name, setup] of Object.entries(setups)) {
    withClone(({ root, cfg, lane }) => {
      setup(lane("lane"));
      seed(root, cfg);
      assert.deepEqual(list(root, cfg).rows.map((r) => [r.id, r.title]), [["DEMO0020", "-"]], `${name}: seed`);
    });
    withClone(({ root, cfg, lane }) => {
      seed(root, cfg);
      setup(lane("lane"));
      assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0021", `${name}: claim`);
    });
  }
});

// A commit whose tree holds one task file, built with plumbing only.
function commitWithItem(root, id) {
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8" }).trim();
  const mk = (input) => execFileSync("git", ["-C", root, "mktree"], { input, encoding: "utf8" }).trim();
  const active = mk(`100644 blob ${blob}\t${id}.md\n`);
  const trellis = mk(`040000 tree ${active}\tactive\n`);
  const top = mk(`040000 tree ${trellis}\ttrellis\n`);
  return git(root, "commit-tree", top, "-m", "items");
}

test("an unborn worktree counts its staged item, never a tag named HEAD", () => {
  withClone(({ root, cfg, dir }) => {
    git(root, "update-ref", "refs/tags/HEAD", commitWithItem(root, "DEMO0050"));
    const orphan = join(dir, "orphan");
    git(root, "worktree", "add", "-q", "--detach", orphan);
    git(orphan, "checkout", "-q", "--orphan", "orphan");
    git(orphan, "rm", "-rf", "-q", "--cached", ".");
    const f = item(orphan, "active", "DEMO0003");
    git(orphan, "add", f);
    const scan = scanIds(orphan, cfg);
    assert.deepEqual([...scan.index], ["DEMO0003"]);
    assert.deepEqual([...scan.head], []);
    seed(root, cfg);
    assert.deepEqual(list(root, cfg).rows.map((r) => r.id), ["DEMO0003"]);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0004");
  });
});

test("a detached HEAD reads the detached commit, not a tag named HEAD", () => {
  withClone(({ root, cfg, dir }) => {
    git(root, "update-ref", "refs/tags/HEAD", commitWithItem(root, "DEMO0060"));
    const detached = join(dir, "detached");
    git(root, "worktree", "add", "-q", "--detach", detached, commitWithItem(root, "DEMO0009"));
    const scan = scanIds(detached, cfg);
    assert.deepEqual([...scan.head], ["DEMO0009"]);
  });
});

test("scanIds returns the disk, index, skip-worktree and HEAD sets separately", () => {
  withClone(({ root, cfg }) => {
    const kept = item(root, "active", "DEMO0001");
    const skipped = item(root, "completed", "DEMO0002");
    const unstaged = item(root, "removed", "DEMO0003");
    git(root, "add", kept, skipped);
    git(root, "commit", "-q", "-m", "items");
    git(root, "update-index", "--skip-worktree", skipped);
    rmSync(skipped);
    const scan = scanIds(root, cfg);
    assert.deepEqual([...scan.disk].sort(), ["DEMO0001", "DEMO0003"]);
    assert.deepEqual([...scan.index].sort(), ["DEMO0001", "DEMO0002"]);
    assert.deepEqual([...scan.skipWorktree], ["DEMO0002"]);
    assert.deepEqual([...scan.head].sort(), ["DEMO0001", "DEMO0002"]);
    assert.ok(unstaged);
  });
});

test("ledgerIdMatcher escapes the prefix", () => {
  const m = ledgerIdMatcher({ idPrefix: "R+", idWidth: 4 });
  assert.equal(m.test("R+0001"), true);
  assert.equal(m.test("RR0001"), false);
  assert.equal(m.test("R+00012"), false);
});

test("the allocator ignores GIT_INDEX_FILE and sees a worktree's real index", () => {
  withClone(({ root, cfg, lane, dir }) => {
    const other = lane("lane");
    const f = item(other, "active", "DEMO0030");
    git(other, "add", f);
    rmSync(f);
    const alt = join(dir, "alt-index");
    execFileSync("git", ["-C", root, "read-tree", "--empty"], { env: { ...process.env, GIT_INDEX_FILE: alt } });
    withEnv({ GIT_INDEX_FILE: alt }, () => {
      seed(root, cfg);
      assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0031");
      git(other, "config", "core.sparseCheckout", "true");
      assertRefused(() => claim(root, cfg, { title: "y" }), "unsupported_layout");
    });
  });
});

// --------------------------------------------------------- layout refusals

// The refusal leaves the ledger as it was.
function refusedAndUnchanged(root, cfg, code = "unsupported_layout") {
  const t = tip(root);
  assertRefused(() => claim(root, cfg, { title: "x" }), code);
  assertRefused(() => through(root, cfg, "DEMO0090"), code);
  assert.equal(tip(root), t);
}

test("sparse checkout is refused, even with a config override that hides it", () => {
  withClone(({ root, cfg, lane }) => {
    const other = lane("lane");
    seed(root, cfg);
    git(other, "config", "core.sparseCheckout", "true");
    refusedAndUnchanged(root, cfg);
    withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sparseCheckout", GIT_CONFIG_VALUE_0: "false" }, () => {
      refusedAndUnchanged(root, cfg);
    });
    assert.match(preview(root, cfg).note, /sparse/);
    assertRefused(() => seed(root, { ...cfg, idLedgerRef: "refs/trellis/fresh" }), "unsupported_layout");
  });
});

test("a symlinked task folder is refused", () => {
  withClone(({ root, cfg, lane, dir }) => {
    const other = lane("lane");
    seed(root, cfg);
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(other, "trellis"));
    symlinkSync(elsewhere, join(other, "trellis", "active"));
    refusedAndUnchanged(root, cfg);
  });
});

test("an absent completed/tasks is fine; a dangling symlink there is refused", () => {
  withClone(({ root, cfg, lane, dir }) => {
    const other = lane("lane");
    mkdirSync(join(root, "trellis", "active"), { recursive: true });
    seed(root, cfg);
    assert.equal(claim(root, cfg, { title: "ok" }).id, "DEMO0001");
    mkdirSync(join(other, "trellis", "completed"), { recursive: true });
    symlinkSync(join(dir, "nowhere"), join(other, "trellis", "completed", "tasks"));
    refusedAndUnchanged(root, cfg);
  });
});

test("a served root that is not the worktree root is refused", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    mkdirSync(join(root, "sub"));
    assertRefused(() => claim(join(root, "sub"), cfg, { title: "x" }), "unsupported_layout");
  });
});

test("a case alias of a status folder refuses before allocating", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8" }).trim();
    const path = "trellis/Active/DEMO0005.md";
    git(root, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
    git(root, "commit", "-q", "-m", "alias");
    git(root, "update-index", "--force-remove", path);
    refusedAndUnchanged(root, cfg);
  });
});

test("an alias is found when case folding changes the folder name's length", (t) => {
  withClone(({ root, cfg }) => {
    const dotted = { ...cfg, tasksDir: "\u0130" };
    seed(root, dotted);
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "x\n", encoding: "utf8" }).trim();
    // "i" plus a combining dot is what the capital dotted I folds to; it is longer.
    const path = "i\u0307/active/DEMO0005.md";
    try {
      git(root, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
    } catch (e) {
      t.skip(`git or this filesystem cannot hold the path: ${e.message}`);
      return;
    }
    refusedAndUnchanged(root, dotted);
  });
});

test("claim, seed and list leave unrelated refs and the working tree alone", () => {
  withClone(({ root, cfg }) => {
    const before = git(root, "for-each-ref", "--format=%(refname) %(objectname)");
    seed(root, cfg);
    claim(root, cfg, { title: "x" });
    const after = git(root, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => !l.startsWith(REF));
    assert.equal(after.join("\n"), before);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.ok(existsSync(join(root, "README.md")) && readFileSync(join(root, "README.md"), "utf8") === "x\n");
  });
});

// ------------------------------------------------- external review round 1

test("a tasksDir written as ./trellis still sees index-only and HEAD-only ids", () => {
  withClone(({ root, cfg }) => {
    const dotCfg = { ...cfg, tasksDir: "./trellis" };
    const committed = item(root, "active", "DEMO0009");
    git(root, "add", committed);
    git(root, "commit", "-q", "-m", "item");
    git(root, "rm", "-q", committed);
    const staged = item(root, "active", "DEMO0007");
    git(root, "add", staged);
    rmSync(staged);
    const scan = scanIds(root, dotCfg);
    assert.deepEqual([...scan.index], ["DEMO0007"]);
    assert.deepEqual([...scan.head], ["DEMO0009"]);
    seed(root, dotCfg);
    assert.equal(claim(root, dotCfg, { title: "next" }).id, "DEMO0010");
  });
});

test("a ref file git cannot read makes the ledger unusable with git's message", () => {
  withClone(({ root, cfg }) => {
    mkdirSync(join(root, ".git", "refs", "trellis"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "trellis", "ids"), "garbage\n");
    assert.match(readLedger(root, cfg).unusable, /failed to look up reference/);
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
    assertRefused(() => seed(root, cfg), "invalid_ledger");
    assert.equal(preview(root, cfg).nextId, null);
    assert.equal(preview(root, cfg).reason, "invalid_ledger");
  });
});

test("a served root whose path ends in a space is not refused", () => {
  const dir = tmp("ledger-space");
  try {
    const root = join(dir, "spaced ");
    mkdirSync(root);
    git(root, "init", "-q", "--ref-format=files", "-b", "main");
    git(root, "config", "user.name", "Tester");
    git(root, "config", "user.email", "tester@example.com");
    writeFileSync(join(root, "README.md"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    seed(root, BASE_CFG);
    assert.equal(claim(root, BASE_CFG, { title: "ok" }).id, "DEMO0001");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a task folder the scan cannot read is a layout refusal, not a crash", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root can read a mode-000 folder");
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    const file = item(root, "active", "DEMO0001");
    const dir = dirname(file);
    chmodSync(dir, 0o000);
    try {
      const before = tip(root);
      assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
      assert.equal(tip(root), before);
      const p = preview(root, cfg);
      assert.equal(p.nextId, null);
      assert.equal(p.reason, "unsupported_layout");
    } finally { chmodSync(dir, 0o755); }
  });
});

test("a claim that would outgrow the reader's buffer is refused before any write", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    claim(root, cfg, { title: "fits" });
    const before = tip(root);
    assertRefused(() => claim(root, cfg, { title: "too big", maxBytes: 50 }), "ledger_too_large");
    assertRefused(() => through(root, cfg, "DEMO0500", { maxBytes: 50 }), "ledger_too_large");
    assert.equal(tip(root), before);
    assert.equal(claim(root, cfg, { title: "still fine" }).id, "DEMO0002");
  });
});

// ------------------------------------------------- external review round 2

const posixOnly = { skip: process.platform === "win32" && "a backslash is a separator on Windows" };

test("a tasksDir with a backslash is one folder name on POSIX, on disk and in git", posixOnly, () => {
  const cfgOver = { tasksDir: "a\\b" };
  const file = (wt) => {
    const dir = join(wt, "a\\b", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "DEMO0005.md"), "---\nid: DEMO0005\ntitle: T\nstatus: active\n---\n");
    return join(dir, "DEMO0005.md");
  };
  withClone(({ root, cfg }) => {
    file(root);
    assert.deepEqual([...scanIds(root, cfg).disk], ["DEMO0005"]);
  }, cfgOver);
  withClone(({ root, cfg }) => {
    const f = file(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "item");
    rmSync(f);
    const scan = scanIds(root, cfg);
    assert.deepEqual([[...scan.index], [...scan.head]], [["DEMO0005"], ["DEMO0005"]]);
  }, cfgOver);
});

test("a branch name ending in a non-breaking space is recorded whole", () => {
  withClone(({ root, cfg }) => {
    const name = "feat ";
    git(root, "checkout", "-q", "-b", name);
    seed(root, cfg);
    claim(root, cfg, { title: "nbsp" });
    assert.equal(list(root, cfg).rows[0].branch, name);
  });
});

test("an fsmonitor command and a reference-transaction hook are never run by the ledger", posixOnly, () => {
  withClone(({ root, cfg }) => {
    const marks = join(root, "..", "marks");
    mkdirSync(marks);
    const script = (name) => {
      const p = join(root, "..", name);
      writeFileSync(p, `#!/bin/sh\necho x >> ${JSON.stringify(join(marks, name))}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    git(root, "config", "core.fsmonitor", script("fsmonitor.sh"));
    const hook = join(root, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\necho x >> ${JSON.stringify(join(marks, "hook"))}\n`);
    chmodSync(hook, 0o755);
    // Plain git runs both, so the markers prove the setup works.
    git(root, "status");
    git(root, "update-ref", "refs/probe", "HEAD");
    assert.ok(existsSync(join(marks, "fsmonitor.sh")) && existsSync(join(marks, "hook")));
    rmSync(marks, { recursive: true });
    mkdirSync(marks);
    seed(root, cfg);
    claim(root, cfg, { title: "quiet" });
    assert.deepEqual(readdirSync(marks), []);
  });
});

test("a claims.tsv over the reader limit is unusable, not a failure", () => {
  withClone(({ root, cfg }) => {
    const big = join(root, "..", "big");
    writeFileSync(big, Buffer.alloc(257 * 1024 * 1024, 0x61));
    const blob = git(root, "hash-object", "-w", big);
    const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\tclaims.tsv\n`, encoding: "utf8" }).trim();
    const commit = git(root, "commit-tree", tree, "-m", "big");
    git(root, "update-ref", REF, commit);
    const r = readLedger(root, cfg);
    assert.match(r.unusable, /too large/);
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
  });
});

// ------------------------------------------------ external review round 3

test("a separate git dir is refused, since git lists the metadata directory as the primary worktree", () => {
  const dir = tmp("sepgit");
  try {
    const root = join(dir, "work");
    mkdirSync(root);
    git(root, "init", "-q", "--ref-format=files", "-b", "main", "--separate-git-dir", join(dir, "meta"));
    git(root, "config", "user.name", "Tester");
    git(root, "config", "user.email", "tester@example.com");
    writeFileSync(join(root, "README.md"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    assertRefused(() => seed(root, BASE_CFG), "unsupported_layout");
    assert.equal(tipOrNull(root), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a worktree behind an inaccessible parent refuses allocation instead of being dropped", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  withClone(({ root, cfg, dir }) => {
    const parent = join(dir, "closed");
    mkdirSync(parent);
    const path = join(parent, "lane");
    git(root, "worktree", "add", "-q", "-b", "lane", path);
    seed(root, cfg);
    const before = tip(root);
    chmodSync(parent, 0o000);
    try {
      assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
    } finally { chmodSync(parent, 0o755); }
    assert.equal(tip(root), before);
  });
});

test("a branch name that is not valid UTF-8 refuses allocation", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    const before = tip(root);
    const head = join(git(root, "rev-parse", "--absolute-git-dir"), "HEAD");
    writeFileSync(head, Buffer.concat([Buffer.from("ref: refs/heads/bad"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));
    assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
    assert.equal(tip(root), before);
  });
});

test("the branch recorded for a claim ignores a tag with the same name", () => {
  withClone(({ root, cfg }) => {
    git(root, "tag", "main");
    seed(root, cfg);
    claim(root, cfg, { title: "x" });
    assert.equal(list(root, cfg).rows[0].branch, "main");
  });
});

test("titles reject Unicode line separators, and seed titles are cleaned the same way", () => {
  withClone(({ root, cfg }) => {
    mkdirSync(join(root, "trellis", "active"), { recursive: true });
    for (const bad of ["a\u2028b", "a\u2029b", "a\u0085b", "a\u009fb"]) {
      assertRefused(() => claim(root, cfg, { title: bad }), "invalid_request");
    }
    item(root, "active", "DEMO0005", "one\u0085two");
    seed(root, cfg);
    const rows = list(root, cfg).rows;
    assert.equal(rows[0].title, "one two");
    assert.equal(claim(root, cfg, { title: "next" }).id, "DEMO0006");
  });
});

// ------------------------------------------------ external review round 8

test("a worktree that vanishes before its path is resolved is a layout refusal, and the preview says why", () => {
  withClone(({ root, cfg, lane }) => {
    seed(root, cfg);
    const path = lane("gone");
    testSeams.beforeResolve = (w) => { if (w.path === realpathSync(path)) rmSync(path, { recursive: true, force: true }); };
    try {
      const before = tip(root);
      const p = preview(root, cfg);
      assert.equal(p.nextId, null);
      assert.equal(p.reason, "unsupported_layout");
      assert.equal(tip(root), before);
    } finally { testSeams.beforeResolve = null; }
  });
});

test("a preview refuses a current branch that a claim would refuse (line separator in the name)", () => {
  withClone(({ root, cfg }) => {
    seed(root, cfg);
    git(root, "checkout", "-q", "-b", "a\u2028b"); // git allows this name, so no seam is needed
    const p = preview(root, cfg);
    assert.equal(p.nextId, null);
    assert.equal(p.reason, "invalid_request");
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_request");
  });
});

// ------------------------------------------------ external review round 4

const unprivileged = process.platform === "win32" || process.getuid?.() === 0;

test("a prunable worktree whose path still exists refuses allocation, and a gone one is skipped", { skip: unprivileged }, () => {
  withClone(({ root, cfg, lane }) => {
    const path = lane("lane");
    seed(root, cfg);
    const before = tip(root);
    chmodSync(path, 0o000);
    try {
      const listing = git(root, "worktree", "list", "--porcelain");
      assert.match(listing, /prunable/, "git marks the unreadable checkout prunable");
      assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
    } finally { chmodSync(path, 0o755); }
    assert.equal(tip(root), before);
    rmSync(path, { recursive: true, force: true });
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0001", "a removed checkout no longer blocks");
  });
});

test("an unreadable worktree registry refuses allocation", { skip: unprivileged }, () => {
  withClone(({ root, cfg, lane }) => {
    lane("lane");
    seed(root, cfg);
    const before = tip(root);
    const registry = join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktrees");
    for (const target of [join(registry, "lane", "gitdir"), registry]) {
      chmodSync(target, 0o000);
      try {
        assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
      } finally { chmodSync(target, target === registry ? 0o755 : 0o644); }
    }
    assert.equal(tip(root), before);
    assert.equal(claim(root, cfg, { title: "x" }).id, "DEMO0001");
  });
});

test("an empty or missing gitdir file in a registration directory refuses allocation", () => {
  for (const mode of ["empty", "missing"]) {
    withClone(({ root, cfg, lane }) => {
      lane("lane");
      seed(root, cfg);
      const before = tip(root);
      const file = join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktrees", "lane", "gitdir");
      if (mode === "empty") writeFileSync(file, ""); else rmSync(file);
      assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
      assert.equal(tip(root), before, mode);
    });
  }
});

test("a branch name with a line separator refuses a claim and is recorded as - by a seed", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg, lane }) => {
    const bad = "a b";
    const path = join(root, "..", "badlane");
    git(root, "worktree", "add", "-q", "-b", bad, path);
    item(path, "active", "DEMO0007");
    seed(root, cfg);
    assert.equal(list(root, cfg).rows.find((r) => r.id === "DEMO0007").branch, "-");
    const before = tip(root);
    assertRefused(() => claim(path, cfg, { title: "x" }), "invalid_request");
    assert.equal(tip(root), before);
  });
});

test("a claims.tsv that is not valid UTF-8 is an unusable ledger", () => {
  withClone(({ root, cfg }) => {
    rawLedger(root, Buffer.concat([Buffer.from(HEADER + "DEMO0001\t2026-11-19\tclaim\tmain\tbad"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));
    const before = tip(root);
    assert.match(readLedger(root, cfg).unusable, /UTF-8/);
    assertRefused(() => claim(root, cfg, { title: "x" }), "invalid_ledger");
    assert.equal(tip(root), before);
  });
});

test("refuseSymlinkedArtifacts refuses a symlink, dangling or not, and passes regular and absent files", { skip: process.platform === "win32" }, () => {
  withClone(({ root }) => {
    const dir = join(root, "trellis");
    mkdirSync(dir);
    writeFileSync(join(dir, "regular.json"), "{}");
    assert.doesNotThrow(() => refuseSymlinkedArtifacts([join(dir, "regular.json"), join(dir, "absent.json")]));
    symlinkSync(join(dir, "regular.json"), join(dir, "live.json"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling.json"));
    for (const name of ["live.json", "dangling.json"]) {
      assertRefused(() => refuseSymlinkedArtifacts([join(dir, name)]), "invalid_request");
    }
    mkdirSync(join(dir, "folder.json"));
    assertRefused(() => refuseSymlinkedArtifacts([join(dir, "folder.json")]), "invalid_request");
    execFileSync("mkfifo", [join(dir, "pipe.json")]);
    assertRefused(() => refuseSymlinkedArtifacts([join(dir, "pipe.json")]), "invalid_request");
  });
});

test("a branch field that is not a valid git branch name makes the ledger unusable", () => {
  withClone(({ root, cfg }) => {
    for (const branch of ["bad branch", "-x", "a..b", "x.lock", "@", "/lane", "lane/", "a//b"]) {
      rawLedger(root, HEADER + `DEMO0001\t2026-11-19\tclaim\t${branch}\tok\n`);
      assert.match(readLedger(root, cfg).unusable ?? "", /valid git branch name/, branch);
    }
    rawLedger(root, HEADER + "DEMO0001\t2026-11-19\tclaim\tfeature/x-1\tok\n");
    assert.equal(readLedger(root, cfg).unusable, undefined);
  });
});

test("a checkout moved by hand, with another clone at its old path, refuses allocation", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg, dir, lane }) => {
    const path = lane("lane");
    seed(root, cfg);
    assert.doesNotThrow(() => claim(root, cfg, { title: "ok" }));
    const moved = join(dir, "lane-moved");
    renameSync(path, moved);
    // A different clone now sits where the registration still points.
    mkdirSync(path);
    git(path, "init", "-q", "-b", "other");
    const before = tip(root);
    assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
    assert.equal(tip(root), before);
  });
});

// ------------------------------------------------ external review round 7

const relativePathsSupported = (() => {
  const c = makeClone();
  try {
    git(c.root, "worktree", "add", "-q", "--relative-paths", "-b", "probe", join(c.dir, "probe"));
    return true;
  } catch { return false; } finally { c.cleanup(); }
})();

test("a worktree registered with a relative gitdir path is accepted", { skip: (!relativePathsSupported && "git lacks worktree --relative-paths") || process.platform === "win32" }, () => {
  withClone(({ root, cfg, dir }) => {
    git(root, "worktree", "add", "-q", "--relative-paths", "-b", "rel", join(dir, "rel"));
    seed(root, cfg);
    assert.equal(claim(root, cfg, { title: "ok" }).id, "DEMO0001");
  });
});

test("two registrations for one checkout refuse allocation", { skip: process.platform === "win32" }, () => {
  withClone(({ root, cfg, lane }) => {
    lane("lane");
    seed(root, cfg);
    const worktrees = join(root, ".git", "worktrees");
    cpSync(join(worktrees, "lane"), join(worktrees, "lane2"), { recursive: true });
    const before = tip(root);
    assertRefused(() => claim(root, cfg, { title: "x" }), "unsupported_layout");
    assert.equal(tip(root), before);
  });
});
