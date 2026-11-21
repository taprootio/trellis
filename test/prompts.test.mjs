// Behavior tests for the MCP prompts + resources (TRL0006), run via `node --test`.
// Scope is the dependency-free builders in src/prompts.mjs — the SDK wiring in
// scripts/trellis-mcp.mjs is a thin adapter (the broader CLI/MCP matrix is
// TRL0011). Each test scaffolds a throwaway Trellis repo with the init scaffolder
// (prefix DEMO), so the builders are exercised against a real repo's own files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { listResources, readResource, buildPrompt, RESOURCES, PROMPTS, PROMPT_TOKENS, PLAYBOOK_DEPENDENCIES } from "../src/prompts.mjs";
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
          assert.ok(text.includes("templates/trellis/playbooks/"));
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

test("the missing-playbook recovery command names the served repo", () => {
  const root = bareRepo();
  try {
    const text = textOf(root, "code-review");
    assert.ok(text.includes("templates/trellis/playbooks/"));
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
    // The uncompilable prefix is a config error, so the id check is skipped instead of throwing.
    assert.ok(textOf(root, "work-task", { id: "R[0002x" }).includes("R[0002x"));
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

test("the undetected recovery tells the user to copy the playbook, for all three prompts", () => {
  const root = bareRepo({ template: false });
  try {
    for (const name of NAMES) {
      const text = textOf(root, name);
      assert.ok(text.includes("templates/trellis/playbooks/") && text.includes(`${name}.md`), name);
      for (const dep of PLAYBOOK_DEPENDENCIES[name]) assert.ok(text.includes(dep), `${name} needs ${dep}`);
      assert.ok(text.includes("keep existing copies"));
      assert.ok(!text.includes("trellis init"), "never suggests init");
    }
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
    assert.ok(text.includes("Wherever this playbook names AGENTS.md"), "the playbook carries the fallback");
    assert.ok(text.includes("SPEC.md"));
    for (const f of ["work-task", "code-review", "conventions", "pr-draft"]) {
      for (const base of ["trellis", "templates/trellis"]) {
        assert.ok(readFileSync(join(sourceRoot, base, "playbooks", `${f}.md`), "utf8").includes("Wherever this playbook names AGENTS.md"), `${base}/${f}`);
      }
    }
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

test("a task file must be in the directory listing by its exact name", () => {
  const root = mkdtempSync(join(tmpdir(), "trellis-prompts-"));
  try {
    applyScaffold(root, { prefix: "[Rr]" }, {}, sourceRoot);
    const dir = join(root, "trellis", "active");
    writeFileSync(join(dir, "R0001.md"), "---\nid: R0001\n---\n");
    assert.ok(readdirSync(dir).includes("R0001.md") && !readdirSync(dir).includes("r0001.md"));
    assert.ok(textOf(root, "work-task", { id: "R0001" }).includes("R0001"));
    // The scan pattern `[Rr]\d{4}` accepts `r0001`. Rejecting it only exercises the exact-name
    // guard on a case-insensitive filesystem; on a case-sensitive one it passes either way.
    assert.throws(() => textOf(root, "work-task", { id: "r0001" }), (e) => e instanceof TrellisError && e.code === "invalid_request");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a .txt template inside a PULL_REQUEST_TEMPLATE folder counts", () => {
  const root = bareRepo({ template: false });
  try {
    mkdirSync(join(root, "docs", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    writeFileSync(join(root, "docs", "PULL_REQUEST_TEMPLATE", "feature.txt"), "t\n");
    const text = textOf(root, "pr-draft");
    assert.ok(text.includes("docs/PULL_REQUEST_TEMPLATE/") && !text.includes(PROMPT_TOKENS.noTemplate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the dependency set equals the playbooks each packaged playbook links or names", () => {
  for (const name of NAMES) {
    const text = readFileSync(join(sourceRoot, "templates", "trellis", "playbooks", `${name}.md`), "utf8");
    const derived = new Set([...text.matchAll(/(?:\]\(|trellis\/playbooks\/)([a-z-]+)\.md/g)].map((m) => m[1]).filter((n) => n !== name));
    assert.deepEqual([...derived].sort(), PLAYBOOK_DEPENDENCIES[name].map((f) => f.replace(/\.md$/, "")).sort(), name);
  }
});

test("the pr-draft prompt on a repo whose only instructions are CONTRIBUTING.md carries the attribution fallback", () => {
  const root = freshRepo();
  try {
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "CONTRIBUTING.md"), "# Contributing\n\nAttribution: add a Signed-off-by trailer.\n");
    const text = textOf(root, "pr-draft");
    const from = text.indexOf("**Attribution:**");
    const rule = text.slice(from, text.indexOf("\n\n", from) === -1 ? undefined : text.indexOf("\n\n", from));
    assert.ok(from > 0);
    assert.ok(rule.includes("Wherever this playbook names AGENTS.md") && rule.includes("CONTRIBUTING.md"));
    const flat = rule.replace(/\s+/g, " ");
    assert.ok(flat.includes("the repo's `attribution` policy") && flat.indexOf("the repo's `attribution` policy") < flat.indexOf("the default is none"), "the repo's policy comes before Trellis's default");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the PR template resource and the pr-draft handoff agree on a .txt template", () => {
  const root = bareRepo({ template: false });
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "pull_request_template.txt"), "template text\n");
    assert.ok(textOf(root, "pr-draft").includes("docs/pull_request_template.txt"));
    const res = readResource(root, "trellis://template/pull-request");
    assert.equal(res.text, "template text\n");
    assert.equal(res.mimeType, "text/plain");
    assert.equal(listResources(root).find((r) => r.uri === "trellis://template/pull-request").available, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the PR template lookup prefers .github/pull_request_template.md, and a lone folder template is the template", () => {
  const root = bareRepo({ template: false });
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "pull_request_template.md"), "docs\n");
    writeFileSync(join(root, "PULL_REQUEST_TEMPLATE.md"), "variant\n");
    writeFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.txt"), "txt\n");
    writeFileSync(join(root, ".github", "pull_request_template.md"), "exact\n");
    assert.ok(textOf(root, "pr-draft").includes(".github/pull_request_template.md"));
    assert.equal(readResource(root, "trellis://template/pull-request").text, "exact\n");
  } finally { rmSync(root, { recursive: true, force: true }); }

  const one = bareRepo({ template: false });
  const many = bareRepo({ template: false });
  try {
    mkdirSync(join(one, "docs", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    writeFileSync(join(one, "docs", "PULL_REQUEST_TEMPLATE", "bug.md"), "bug\n");
    assert.ok(textOf(one, "pr-draft").includes("docs/PULL_REQUEST_TEMPLATE/bug.md"));
    assert.equal(readResource(one, "trellis://template/pull-request").text, "bug\n");

    mkdirSync(join(many, "docs", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    for (const f of ["a.md", "b.txt"]) writeFileSync(join(many, "docs", "PULL_REQUEST_TEMPLATE", f), "t\n");
    const text = textOf(many, "pr-draft");
    assert.ok(text.includes("docs/PULL_REQUEST_TEMPLATE/") && text.includes("pick"));
    assert.ok(!text.includes(PROMPT_TOKENS.noTemplate));
    assert.equal(listResources(many).find((r) => r.uri === "trellis://template/pull-request").available, false);
    assert.throws(() => readResource(many, "trellis://template/pull-request"), (e) => e instanceof TrellisError && e.code === "not_found");
  } finally { rmSync(one, { recursive: true, force: true }); rmSync(many, { recursive: true, force: true }); }
});

test("a directory at .github/pull_request_template.md leaves the template resource unavailable, without EISDIR", () => {
  const root = bareRepo({ template: false });
  try {
    mkdirSync(join(root, ".github", "pull_request_template.md"));
    assert.equal(listResources(root).find((r) => r.uri === "trellis://template/pull-request").available, false);
    assert.throws(() => readResource(root, "trellis://template/pull-request"), (e) => e instanceof TrellisError && e.code === "not_found");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the PR template lookup sorts candidates by code unit, so directory order never decides", () => {
  const root = bareRepo({ template: false });
  try {
    writeFileSync(join(root, ".github", "pull_request_template.txt"), "txt\n");
    writeFileSync(join(root, ".github", "Pull_Request_Template.md"), "upper\n");
    assert.ok(!readdirSync(join(root, ".github")).includes("pull_request_template.md"), "the exact lowercase name is absent from the listing");
    assert.ok(textOf(root, "pr-draft").includes(".github/Pull_Request_Template.md"));
    assert.equal(readResource(root, "trellis://template/pull-request").text, "upper\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory at a playbook path hands off instead of failing, and AGENTS.md as a directory is not pointed at", () => {
  const root = freshRepo();
  try {
    rmSync(join(root, "trellis", "playbooks", "code-review.md"));
    mkdirSync(join(root, "trellis", "playbooks", "code-review.md"));
    assert.equal(textOf(root, "code-review").split("\n")[0], PROMPT_TOKENS.handoff);
    rmSync(join(root, "AGENTS.md"));
    mkdirSync(join(root, "AGENTS.md"));
    const text = textOf(root, "work-task");
    assert.ok(!text.slice(0, text.indexOf(PLAYBOOK_SEPARATOR)).includes("trellis://conventions"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
