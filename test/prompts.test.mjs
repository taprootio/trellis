// Behavior tests for the MCP prompts + resources (TRL0006), run via `node --test`.
// Scope is the dependency-free builders in src/prompts.mjs — the SDK wiring in
// scripts/trellis-mcp.mjs is a thin adapter (the broader CLI/MCP matrix is
// TRL0011). Each test scaffolds a throwaway Trellis repo with the init scaffolder
// (prefix DEMO), so the builders are exercised against a real repo's own files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScaffold } from "../src/init.mjs";
import { listResources, readResource, buildPrompt, RESOURCES, PROMPTS } from "../src/prompts.mjs";
import { TrellisError } from "../src/mcp.mjs";
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
    assert.match(out, /trellis-mcp — serve the Trellis backlog operations/, "a symlinked launch prints help, i.e. it booted");
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
