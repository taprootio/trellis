// Trellis MCP prompts + resources (zero-dependency, transport-agnostic).
//
// TRL0006: the work-task / code-review / pr-draft loops as MCP **prompts**, and
// the spec / conventions / config / playbooks / PR-template as MCP **resources**.
// Like the tool ops in src/mcp.mjs, every builder takes an explicit repoRoot and
// reads the repo's OWN files at request time — stateless and repoRoot-keyed, so
// one server instance serves any repo and the prompts never drift from the
// Markdown playbooks they mirror. The SDK + transport wiring live in
// scripts/trellis-mcp.mjs; keeping these functions dependency-free means the whole
// surface is unit-testable with `node --test` and no transport.
//
// Reading conventions from the repo (not baking a stack into the prompt text) is
// the TRL0006 Risk made concrete: a prompt for repo A carries A's playbooks and
// vocabulary; for repo B, B's.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./backlog.mjs";
import { TrellisError } from "./mcp.mjs";

// --------------------------------------------------------------- resources
// The catalog. `rel` is the repo-relative file each `trellis://` uri serves; the
// content is always read live from repoRoot, so a repo's own copy wins.
export const RESOURCES = [
  {
    uri: "trellis://spec", name: "spec", title: "Backlog spec",
    description: "The canonical Backlog Spec (SPEC.md).",
    rel: "SPEC.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://conventions", name: "conventions", title: "Repo conventions (AGENTS.md)",
    description: "The repo's AGENTS.md — the canonical conventions every loop grounds in first.",
    rel: "AGENTS.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://config", name: "config", title: "Backlog config",
    description: "backlog.config.json — the per-repo vocabulary (id prefix, milestones, priorities, effort).",
    rel: "backlog.config.json", mimeType: "application/json",
  },
  {
    uri: "trellis://playbook/conventions", name: "playbook-conventions", title: "Conventions contract",
    description: "The per-repo conventions contract — the named seam points the universal loop reads from a repo's AGENTS.md.",
    rel: "docs/playbooks/conventions.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://playbook/work-task", name: "playbook-work-task", title: "Playbook: work a task",
    description: "The work-a-task loop, as Markdown.",
    rel: "docs/playbooks/work-task.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://playbook/code-review", name: "playbook-code-review", title: "Playbook: code review",
    description: "The code-review loop and its JSON output standard, as Markdown.",
    rel: "docs/playbooks/code-review.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://playbook/pr-draft", name: "playbook-pr-draft", title: "Playbook: draft a PR",
    description: "The PR title/description draft loop, as Markdown.",
    rel: "docs/playbooks/pr-draft.md", mimeType: "text/markdown",
  },
  {
    uri: "trellis://template/pull-request", name: "template-pull-request", title: "PR template",
    description: "The repository pull-request template the pr-draft loop fills.",
    rel: ".github/pull_request_template.md", mimeType: "text/markdown",
  },
];

function resourceByUri(uri) {
  const r = RESOURCES.find((x) => x.uri === uri);
  if (!r) throw new TrellisError(`unknown resource: ${uri}`, "not_found");
  return r;
}

// list_resources — the catalog, each flagged `available` iff its file exists in
// this repo. (SPEC.md, for one, is absent in onboarded repos until packaging
// bundles a canonical copy — TRL0010.)
export function listResources(repoRoot) {
  return RESOURCES.map(({ uri, name, title, description, mimeType, rel }) => ({
    uri, name, title, description, mimeType,
    available: existsSync(join(repoRoot, rel)),
  }));
}

// read_resource — the file behind a trellis:// uri. Throws `not_found` when the
// uri is unknown OR the file is absent in this repo, rather than faking content.
export function readResource(repoRoot, uri) {
  const r = resourceByUri(uri);
  const abs = join(repoRoot, r.rel);
  if (!existsSync(abs)) {
    throw new TrellisError(`resource ${uri} is unavailable in this repo (no ${r.rel})`, "not_found");
  }
  return { uri: r.uri, mimeType: r.mimeType, text: readFileSync(abs, "utf8") };
}

// ----------------------------------------------------------------- prompts
// Each prompt embeds the repo's own playbook body (`playbook`) verbatim, behind a
// repo-parameterized preamble. `arguments` is the MCP prompt-argument list.
export const PROMPTS = [
  {
    name: "work-task", title: "Work a task",
    description: "Take a Trellis task from active/ to ready-for-review by following the work-a-task loop.",
    playbook: "docs/playbooks/work-task.md",
    arguments: [{ name: "id", description: "task id to work, using this repo's configured id prefix and width", required: true }],
  },
  {
    name: "code-review", title: "Code review",
    description: "Review the current branch's work against the repo's conventions and emit the canonical JSON findings.",
    playbook: "docs/playbooks/code-review.md",
    arguments: [],
  },
  {
    name: "pr-draft", title: "Draft a PR",
    description: "Draft a copy-ready PR title and description that conform to the repo's PR template.",
    playbook: "docs/playbooks/pr-draft.md",
    arguments: [],
  },
];

function promptByName(name) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new TrellisError(`unknown prompt: ${name}`, "not_found");
  return p;
}

// Ground every prompt in this repo's conventions, with the id vocabulary read
// live from backlog.config.json (never baked into the prompt text). On a config
// error we still point at AGENTS.md rather than emitting a wrong vocabulary.
function conventionsPreamble(cfg, cfgErrors) {
  const vocab = cfgErrors.length
    ? "the repo's `backlog.config.json` governs its vocabulary"
    : `ids are \`${cfg.idPrefix}\` + ${cfg.idWidth} digits; milestones are ${cfg.milestones.join(" → ")}; priorities are ${cfg.priorities.join(", ")}`;
  return "Ground in this repo's own conventions first: read its `AGENTS.md` (the "
    + "`trellis://conventions` resource) and the `SPEC.md` / docs it points at. The "
    + `repo's conventions govern — ${vocab}.`;
}

// Validate the work-task `id` argument against this repo's id format (when the
// config is loadable), so a malformed id fails fast with a clear message.
function requireId(raw, cfg, cfgErrors) {
  if (typeof raw !== "string" || !raw.trim()) throw new TrellisError("`id` is required", "invalid_request");
  const id = raw.trim();
  if (/[\r\n]/.test(id)) throw new TrellisError("`id` must be a single line", "invalid_request");
  if (!cfgErrors.length) {
    const re = new RegExp(`^${cfg.idPrefix}\\d{${cfg.idWidth}}$`);
    if (!re.test(id)) throw new TrellisError(`invalid task id: ${id} (expected ${cfg.idPrefix} + ${cfg.idWidth} digits)`, "invalid_request");
  }
  return id;
}

// The per-prompt instruction that bridges the preamble to the embedded playbook.
function instruction(name, args, cfg, cfgErrors) {
  if (name === "work-task") {
    const id = requireId(args.id, cfg, cfgErrors);
    return `Then work task **${id}** end-to-end by following the loop below exactly — do not improvise the order, and honor its two pauses (refinement sign-off, then plan confirmation) before any branch or file edit.`;
  }
  if (name === "code-review") {
    return "Then review the current branch's work by following the process below, and finish with the canonical JSON findings array exactly as the output standard specifies.";
  }
  return "Then draft the PR title and description by following the loop below, emitting the single copy-ready Markdown block it specifies.";
}

// build_prompt — assemble one prompt's messages for this repo: a conventions
// preamble + a per-prompt instruction + the repo's playbook body, embedded
// verbatim so the prompt is self-contained on clients that don't resolve resource
// links. Throws `not_found` if the backing playbook is missing in this repo.
export function buildPrompt(repoRoot, name, args = {}) {
  const p = promptByName(name);
  const { cfg, errors: cfgErrors } = loadConfig(repoRoot);

  const abs = join(repoRoot, p.playbook);
  if (!existsSync(abs)) {
    throw new TrellisError(`prompt ${name} needs ${p.playbook}, which is missing in this repo`, "not_found");
  }
  const playbook = readFileSync(abs, "utf8").replace(/\n*$/, "\n");

  const text = [
    conventionsPreamble(cfg, cfgErrors),
    "",
    instruction(name, args, cfg, cfgErrors),
    "",
    "--- playbook ---",
    "",
    playbook,
  ].join("\n");

  return {
    description: p.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
