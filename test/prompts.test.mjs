// Behavior tests for the MCP prompts + resources (TRL0006), run via `node --test`.
// Scope is the dependency-free builders in src/prompts.mjs — the SDK wiring in
// scripts/trellis-mcp.mjs is a thin adapter (the broader CLI/MCP matrix is
// TRL0011). Each test scaffolds a throwaway Trellis repo with the init scaffolder
// (prefix DEMO), so the builders are exercised against a real repo's own files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { listResources, readResource, buildPrompt, RESOURCES, PROMPTS, PROMPT_TOKENS } from "../src/prompts.mjs";
import { TrellisError } from "../src/mcp.mjs";
import { loadConfig, readBacklog } from "../src/backlog.mjs";
import { TOOLS } from "../scripts/trellis-mcp.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// A fresh scaffolded repo (prefix DEMO). It carries the copied playbooks, config,
// AGENTS.md and PR template — but NOT SPEC.md (that does not travel via init).
function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), "trellis-prompts-"));
  applyScaffold(root, { prefix: "DEMO" }, {}, sourceRoot);
  return root;
}

test("listResources marks the catalog: playbooks/config/conventions/template available, spec not", () => {
  const root = freshRepo();
  try {
    const byUri = Object.fromEntries(listResources(root).map((r) => [r.uri, r.available]));
    assert.equal(byUri["trellis://config"], true);
    assert.equal(byUri["trellis://conventions"], true);
    assert.equal(byUri["trellis://playbook/work-task"], true);
    assert.equal(byUri["trellis://playbook/code-review"], true);
    assert.equal(byUri["trellis://playbook/pr-draft"], true);
    assert.equal(byUri["trellis://template/pull-request"], true);
    assert.equal(byUri["trellis://spec"], false, "SPEC.md does not travel via init (TRL0010)");
    assert.equal(Object.keys(byUri).length, RESOURCES.length, "every catalog entry is listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("served prompt/resource/tool metadata carries no repo-specific id prefix example", () => {
  // TRL0007: this catalog metadata is shown verbatim by MCP clients
  // (list_prompts/list_resources/list_tools) BEFORE buildPrompt injects the repo's
  // vocabulary, so it must not advertise the Trellis id prefix to an onboarded
  // repo's users. Covers prompts, resources, AND tool schemas (the surfaces three
  // review passes each found a leak in).
  const strings = [];
  for (const p of PROMPTS) {
    strings.push(p.name, p.title, p.description);
    for (const a of p.arguments) strings.push(a.name, a.description);
  }
  for (const r of RESOURCES) strings.push(r.name, r.title, r.description);
  for (const [name, def] of Object.entries(TOOLS)) {
    strings.push(name, def.description);
    for (const field of Object.values(def.inputSchema)) {
      if (field && typeof field.description === "string") strings.push(field.description);
    }
  }
  for (const s of strings) {
    assert.doesNotMatch(s, /TRL(xxxx|\d)/, `served metadata leaks the Trellis id prefix: "${s}"`);
  }
});

test("the MCP entrypoint boots when launched through a symlink (bin-style)", () => {
  // Regression guard: import.meta.url is already symlink-resolved, so the run-as-main
  // check must realpath argv[1] — otherwise an npx / node_modules/.bin launch (a
  // symlink) misses the guard and the server silently never boots.
  const dir = mkdtempSync(join(tmpdir(), "trellis-bin-"));
  const link = join(dir, "trellis-mcp");
  try {
    symlinkSync(join(sourceRoot, "scripts/trellis-mcp.mjs"), link);
    const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    assert.match(out, /trellis mcp — serve the Trellis backlog operations/, "a symlinked launch prints help, i.e. it booted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the conventions contract is an available resource and serves its content", () => {
  // TRL0007: the contract definition is exposed as its own trellis:// resource and
  // travels via init, so an MCP client can read the seam points behind the loop.
  const root = freshRepo();
  try {
    const byUri = Object.fromEntries(listResources(root).map((r) => [r.uri, r.available]));
    assert.equal(byUri["trellis://playbook/conventions"], true, "the conventions contract travels via init");
    const doc = readResource(root, "trellis://playbook/conventions");
    assert.equal(doc.mimeType, "text/markdown");
    assert.match(doc.text, /per-repo conventions contract/i);
    assert.match(doc.text, /`branch-naming`/, "enumerates the seam points");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readResource returns a file's content with its mimeType", () => {
  const root = freshRepo();
  try {
    const cfg = readResource(root, "trellis://config");
    assert.equal(cfg.mimeType, "application/json");
    assert.match(cfg.text, /"idPrefix": "DEMO"/, "serves this repo's own config");

    const pb = readResource(root, "trellis://playbook/work-task");
    assert.equal(pb.mimeType, "text/markdown");
    assert.match(pb.text, /# Playbook: work a task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readResource throws not_found for an absent file and an unknown uri", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => readResource(root, "trellis://spec"),
      (e) => e instanceof TrellisError && e.code === "not_found" && /unavailable/.test(e.message),
      "absent SPEC.md reports unavailable, not faked",
    );
    assert.throws(
      () => readResource(root, "trellis://nope"),
      (e) => e instanceof TrellisError && e.code === "not_found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt(work-task) embeds the playbook body and the repo's vocabulary", () => {
  const root = freshRepo();
  try {
    const p = buildPrompt(root, "work-task", { id: "DEMO0007" });
    assert.equal(p.description, PROMPTS.find((x) => x.name === "work-task").description);
    const text = p.messages[0].content.text;
    assert.equal(p.messages[0].role, "user");
    assert.match(text, /# Playbook: work a task/, "embeds the playbook verbatim");
    assert.match(text, /ids are `DEMO` \+ 4 digits/, "injects this repo's id vocabulary, not a baked-in one");
    assert.match(text, /work task \*\*DEMO0007\*\*/, "names the requested task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt(work-task) validates the id against this repo's format", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => buildPrompt(root, "work-task", {}),
      (e) => e instanceof TrellisError && /`id` is required/.test(e.message),
    );
    assert.throws(
      () => buildPrompt(root, "work-task", { id: "TRL0007" }), // wrong prefix for a DEMO repo
      (e) => e instanceof TrellisError && e.code === "invalid_request" && /invalid task id/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt(code-review) and (pr-draft) embed their playbooks and need no id", () => {
  const root = freshRepo();
  try {
    const cr = buildPrompt(root, "code-review", {}).messages[0].content.text;
    assert.match(cr, /# Playbook: code review/);
    assert.match(cr, /canonical JSON findings array/);

    const pr = buildPrompt(root, "pr-draft", {}).messages[0].content.text;
    assert.match(pr, /# Playbook: draft a PR title and description/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt degrades gracefully when the repo's config is unreadable", () => {
  // The vocabulary preamble (and work-task id check) read config live; a broken
  // config must fall back to pointing at AGENTS.md, not throw — so the loop stays
  // usable while the config is being fixed.
  const root = freshRepo();
  try {
    writeFileSync(join(root, "trellis", "backlog.config.json"), "{ not valid json");
    const text = buildPrompt(root, "code-review", {}).messages[0].content.text;
    assert.match(text, /the repo's `backlog\.config\.json` governs its vocabulary/);
    assert.match(text, /# Playbook: code review/, "still embeds the playbook");
    // work-task can't validate the id format without config, but must still build.
    const wt = buildPrompt(root, "work-task", { id: "ANYTHING1" }).messages[0].content.text;
    assert.match(wt, /work task \*\*ANYTHING1\*\*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrompt rejects an unknown prompt name", () => {
  const root = freshRepo();
  try {
    assert.throws(
      () => buildPrompt(root, "nope", {}),
      (e) => e instanceof TrellisError && e.code === "not_found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The packaged copies under templates/ are what `trellis init` ships to other repos, so
// they must stay byte-identical to the in-repo sources (TRL0038: both name what `check`
// verifies in each generated-artifacts mode).
test("each packaged playbook and the branch-protection guide match their source byte for byte", () => {
  const pairs = readdirSync(join(sourceRoot, "templates", "trellis", "playbooks"))
    .map((f) => `playbooks/${f}`)
    .concat("branch-protection.md");
  for (const rel of pairs) {
    assert.equal(
      readFileSync(join(sourceRoot, "templates", "trellis", rel), "utf8"),
      readFileSync(join(sourceRoot, "trellis", rel), "utf8"),
      `templates/trellis/${rel} must equal trellis/${rel}`,
    );
  }
});

// ----------------------------------- playbooks absent (TRL0040)
const PLAYBOOK_SEPARATOR = "--- playbook ---";
const NAMES = ["work-task", "code-review", "pr-draft"];
const argsFor = (name) => (name === "work-task" ? { id: "DEMO0001" } : {});
// A scaffolded repo with every playbook removed, optionally detected and without a PR template.
function bareRepo({ detected = false, template = true } = {}) {
  const root = freshRepo();
  rmSync(join(root, "trellis", "playbooks"), { recursive: true, force: true });
  if (!template) rmSync(join(root, ".github", "pull_request_template.md"));
  if (detected) writeFileSync(join(root, "good-agent.config.json"), "{}\n");
  return root;
}
const textOf = (root, name, args = argsFor(name)) => buildPrompt(root, name, args).messages[0].content.text;

test("a prompt with its playbook absent answers with a handoff, never a playbook body", () => {
  for (const detected of [true, false]) {
    for (const name of NAMES) {
      const root = bareRepo({ detected });
      try {
        const text = textOf(root, name);
        assert.equal(text.split("\n")[0], PROMPT_TOKENS.handoff);
        assert.ok(!text.includes(PLAYBOOK_SEPARATOR));
        if (detected) {
          if (name === "pr-draft") {
            assert.ok(text.includes("review-loop") && text.includes(PROMPT_TOKENS.prFlow));
            assert.ok(!text.includes("write-task") && !text.includes("work-task"));
          } else {
            for (const skill of ["write-task", "work-task", "review-loop"]) assert.ok(text.includes(skill), skill);
          }
        } else {
          assert.ok(text.includes("--with-playbooks"));
          assert.ok(!text.includes(PROMPT_TOKENS.prFlow));
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("the pr-draft handoff carries the no-template token exactly when the template is absent", () => {
  for (const detected of [true, false]) {
    for (const template of [true, false]) {
      const root = bareRepo({ detected, template });
      try {
        assert.equal(textOf(root, "pr-draft").includes(PROMPT_TOKENS.noTemplate), !template);
        assert.ok(!textOf(root, "code-review").includes(PROMPT_TOKENS.noTemplate));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("each prompt falls back on its own: a directory with only code-review.md still hands off work-task", () => {
  const root = bareRepo({ detected: true });
  try {
    mkdirSync(join(root, "trellis", "playbooks"));
    writeFileSync(join(root, "trellis", "playbooks", "code-review.md"), "# Playbook: code review\n");
    assert.ok(textOf(root, "code-review").includes(PLAYBOOK_SEPARATOR), "the present playbook is embedded");
    const text = textOf(root, "work-task");
    assert.equal(text.split("\n")[0], PROMPT_TOKENS.handoff);
    assert.ok(text.includes("write-task"));
    // The id is validated like the normal prompt's, and a valid one is named.
    assert.throws(() => textOf(root, "work-task", { id: "nope" }), (e) => e instanceof TrellisError && e.code === "invalid_request");
    assert.ok(text.includes("DEMO0001"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt ids: the literal format, or an existing task file that `check` reads, for a prefix with a regex character", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-prompts-"));
  try {
    applyScaffold(root, { prefix: "R+" }, {}, sourceRoot);
    writeFileSync(join(root, "trellis", "active", "RR0001.md"), "---\nid: RR0001\ntitle: Odd prefix\nstatus: active\nmilestone: Alpha\npriority: High\neffort: 3\ndepends_on: []\nsummary: Summary.\n---\n\nBody.\n");
    const { cfg } = loadConfig(root);
    assert.deepEqual(readBacklog(root, cfg).errors, [], "check accepts the id");
    for (const playbooks of [true, false]) {
      if (!playbooks) rmSync(join(root, "trellis", "playbooks"), { recursive: true });
      assert.ok(textOf(root, "work-task", { id: "R+0001" }).includes("R+0001"), "accepted by format");
      assert.ok(textOf(root, "work-task", { id: "RR0001" }).includes("RR0001"), "an existing file is served");
      for (const bad of ["RR0002", "nope"]) assert.throws(() => textOf(root, "work-task", { id: bad }), (e) => e instanceof TrellisError && e.code === "invalid_request", bad);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the missing-playbook recovery command names the served repo and keeps other skips", () => {
  const root = bareRepo();
  try {
    const text = textOf(root, "code-review");
    assert.ok(text.includes("--with-playbooks") && text.includes("--skip"));
    assert.ok(text.split("\n").includes(`run from: ${root}`), "the path is on its own line, not in a shell command");
    assert.ok(!text.includes(`"${root}"`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pr-draft handoff finds a repo-owned PR template in GitHub's standard places", () => {
  const cases = [
    [(r) => writeFileSync(join(r, "PULL_REQUEST_TEMPLATE.md"), "# t\n"), "PULL_REQUEST_TEMPLATE.md"],
    [(r) => { mkdirSync(join(r, "docs")); writeFileSync(join(r, "docs", "pull_request_template.md"), "# t\n"); }, "docs/pull_request_template.md"],
    [(r) => { mkdirSync(join(r, ".github", "PULL_REQUEST_TEMPLATE")); writeFileSync(join(r, ".github", "PULL_REQUEST_TEMPLATE", "a.md"), "# t\n"); }, ".github/PULL_REQUEST_TEMPLATE/"],
  ];
  cases.push([(r) => symlinkSync(join(r, "real.md"), join(r, "pull_request_template.md")), "pull_request_template.md"]);
  for (const detected of [true, false]) {
    for (const [seed, where] of cases) {
      const root = bareRepo({ detected, template: false });
      try {
        writeFileSync(join(root, "real.md"), "# t\n");
        seed(root);
        const text = textOf(root, "pr-draft");
        assert.ok(!text.includes(PROMPT_TOKENS.noTemplate), where);
        assert.ok(text.includes(where), where);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("the pr-draft catalog description is template-neutral, and a present playbook is embedded as before", () => {
  assert.doesNotMatch(PROMPTS.find((p) => p.name === "pr-draft").description, /conform to/);
  const root = freshRepo();
  try {
    const text = textOf(root, "pr-draft");
    assert.ok(text.includes(PLAYBOOK_SEPARATOR));
    assert.ok(!text.includes(PROMPT_TOKENS.handoff));
    assert.ok(text.includes(readFileSync(join(root, "trellis", "playbooks", "pr-draft.md"), "utf8").trimEnd()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a PR template folder with no .md template does not count as a template", () => {
  const root = bareRepo({ template: false });
  try {
    mkdirSync(join(root, ".github", "PULL_REQUEST_TEMPLATE"));
    writeFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE", ".gitkeep"), "");
    assert.ok(textOf(root, "pr-draft").includes(PROMPT_TOKENS.noTemplate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an id check never throws on a prefix that is not a valid regex, and a directory is not a task file", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-prompts-"));
  try {
    mkdirSync(join(root, "trellis"), { recursive: true });
    const cfg = { specVersion: "2.5", idPrefix: "R[", idWidth: 4, milestones: ["Alpha"], priorities: ["High"], effort: [1] };
    writeFileSync(join(root, "trellis", "backlog.config.json"), JSON.stringify(cfg));
    assert.ok(textOf(root, "work-task", { id: "R[0001" }).includes("R[0001"));
    assert.throws(() => textOf(root, "work-task", { id: "R[0002x" }), (e) => e instanceof TrellisError && e.code === "invalid_request");
  } finally { rmSync(root, { recursive: true, force: true }); }

  const dirRoot = mkdtempSync(join(tmpdir(), "trellis-prompts-"));
  try {
    applyScaffold(dirRoot, { prefix: "R+" }, {}, sourceRoot);
    mkdirSync(join(dirRoot, "trellis", "active", "RR0001.md"));
    assert.throws(() => textOf(dirRoot, "work-task", { id: "RR0001" }), (e) => e instanceof TrellisError && e.code === "invalid_request");
  } finally { rmSync(dirRoot, { recursive: true, force: true }); }
});

test("PR template folders count under .github, the root and docs, including symlinked folders", () => {
  const cases = [
    [(r) => { mkdirSync(join(r, "docs", "PULL_REQUEST_TEMPLATE"), { recursive: true }); writeFileSync(join(r, "docs", "PULL_REQUEST_TEMPLATE", "feature.md"), "# t\n"); }, "docs/PULL_REQUEST_TEMPLATE/"],
    [(r) => { mkdirSync(join(r, "elsewhere")); writeFileSync(join(r, "elsewhere", "a.md"), "# t\n"); mkdirSync(join(r, ".github"), { recursive: true }); symlinkSync(join(r, "elsewhere"), join(r, ".github", "PULL_REQUEST_TEMPLATE")); }, ".github/PULL_REQUEST_TEMPLATE/"],
  ];
  for (const [seed, where] of cases) {
    const root = bareRepo({ template: false });
    try {
      seed(root);
      const text = textOf(root, "pr-draft");
      assert.ok(!text.includes(PROMPT_TOKENS.noTemplate) && text.includes(where), where);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // A directory or a dangling link named like the template file does not hide the real one.
  for (const bad of [(p) => mkdirSync(p), (p) => symlinkSync("/nonexistent-trellis-target", p)]) {
    const root = bareRepo({ template: false });
    try {
      bad(join(root, ".github", "pull_request_template.md"));
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "pull_request_template.md"), "# t\n");
      assert.ok(textOf(root, "pr-draft").includes("docs/pull_request_template.md"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("the undetected recovery command restores only the playbooks, for all three prompts", () => {
  const root = bareRepo({ template: false });
  try {
    for (const name of NAMES) assert.ok(textOf(root, name).includes("--with-playbooks --skip ci,pr-template,branch-protection,agents"), name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stray notes.md in active/ is not a task id", () => {
  const root = freshRepo();
  try {
    writeFileSync(join(root, "trellis", "active", "notes.md"), "---\nid: notes\n---\n");
    assert.throws(() => textOf(root, "work-task", { id: "notes" }), (e) => e instanceof TrellisError && e.code === "invalid_request");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a .txt PR template and a root PULL_REQUEST_TEMPLATE folder are found", () => {
  const txt = bareRepo({ template: false });
  const folder = bareRepo({ template: false });
  try {
    mkdirSync(join(txt, "docs"));
    writeFileSync(join(txt, "docs", "pull_request_template.txt"), "t\n");
    assert.ok(textOf(txt, "pr-draft").includes("docs/pull_request_template.txt"));
    mkdirSync(join(folder, "PULL_REQUEST_TEMPLATE"));
    writeFileSync(join(folder, "PULL_REQUEST_TEMPLATE", "feature.md"), "# t\n");
    assert.ok(textOf(folder, "pr-draft").includes("PULL_REQUEST_TEMPLATE/"));
    assert.ok(!textOf(folder, "pr-draft").includes(PROMPT_TOKENS.noTemplate));
  } finally { for (const r of [txt, folder]) rmSync(r, { recursive: true, force: true }); }
});

test("the work-task prompt on a repo without AGENTS.md carries the fallback rule wherever AGENTS.md is required", () => {
  const root = freshRepo();
  try {
    rmSync(join(root, "AGENTS.md"));
    const text = textOf(root, "work-task");
    assert.ok(text.includes("If the repo has no AGENTS.md"), "the playbook carries the fallback");
    assert.ok(text.includes("SPEC.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without an AGENTS.md the prompts do not require the conventions resource", () => {
  const root = freshRepo();
  try {
    rmSync(join(root, "AGENTS.md"));
    for (const name of NAMES) {
      const text = textOf(root, name);
      const before = text.slice(0, text.indexOf(PLAYBOOK_SEPARATOR));
      assert.ok(!before.includes("trellis://conventions") && !before.includes("AGENTS.md"), name);
      assert.ok(before.includes("SPEC.md"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
