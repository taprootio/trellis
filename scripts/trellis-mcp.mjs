#!/usr/bin/env node
// Trellis MCP server — exposes the backlog operations as MCP tools over stdio.
//
//   node scripts/trellis-mcp.mjs [--repo <path>]
//
// The tools are thin adapters over src/mcp.mjs (which is dependency-free and
// unit-tested); the @modelcontextprotocol SDK and the transport live only in this
// entry point. Each tool resolves a repo root — the per-call `repoRoot` arg, else
// the server's default (`--repo`, else cwd) — so one server can serve any repo the
// client points at.
//
// stdout is the JSON-RPC channel: all diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { optionToken, requiredValue, resolveRepoRoot, usageError } from "../src/cli.mjs";
import { OPS, TrellisError } from "../src/mcp.mjs";
import { RESOURCES, PROMPTS, listResources, readResource, buildPrompt } from "../src/prompts.mjs";

// The server reports the package's own version.
const SERVER_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function parseArgs(argv) {
  let repo;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const { key, inline } = optionToken(a);
    if (key === "--repo" || key === "--target") {
      const next = requiredValue(argv, i, inline, key);
      repo = next.value;
      i = next.index;
    } else if (a === "-h" || a === "--help") {
      return { help: true };
    } else {
      usageError(`Unknown argument: ${a}`);
    }
  }
  return { repo: resolveRepoRoot(repo) };
}

const HELP = `trellis mcp — serve the Trellis backlog operations over MCP (stdio)

Usage:
  trellis mcp [--repo <path>]

Options:
  --repo <path>   default repo root for tools that omit \`repoRoot\`, and the repo
                  served for prompts and resources (default: cwd)
  -h, --help      show this help

Tools:     ${Object.keys(OPS).join(", ")}
Prompts:   ${PROMPTS.map((p) => p.name).join(", ")}
Resources: ${RESOURCES.map((r) => r.uri).join(", ")}
`;

const repoRootArg = { repoRoot: z.string().optional().describe("repo root to operate on; defaults to the server's --repo / cwd") };

// name → { description, inputSchema (a zod raw shape) }. The handler for each is
// OPS[name]; every tool also accepts the shared optional `repoRoot`. Exported so a
// test can assert the served metadata stays repo-agnostic without booting the server.
export const TOOLS = {
  list_tasks: {
    description: "List backlog tasks (the backlog.json shape), optionally filtered by status or milestone. In ledger mode nextId is the ledger preview (null with a nextIdNote when there is no usable ledger), not the published value.",
    inputSchema: {
      ...repoRootArg,
      status: z.enum(["active", "completed", "removed"]).optional().describe("only tasks with this status"),
      milestone: z.string().optional().describe("only tasks in this milestone"),
    },
  },
  get_task: {
    description: "Get one task by id: its structured entry plus the raw Markdown body and file path.",
    inputSchema: { ...repoRootArg, id: z.string().describe("task id using this repo's configured id prefix and width") },
  },
  next_id: {
    description: "The id a newly created task would receive. In ledger mode (idAllocation \"ledger\") the result is a preview only: it never claims, so another writer may take that id first; with no ledger yet it returns nextId null and says to run `trellis claim --seed`.",
    inputSchema: { ...repoRootArg },
  },
  claim_id: {
    description: "Claim the next task id from the local id ledger (idAllocation \"ledger\" only) and return it. Each id is handed out once across every worktree of the clone and stays claimed even if no item is written for it. Fails with guidance when the repo is in scan mode or the ledger has not been seeded (`trellis claim --seed`).",
    inputSchema: {
      ...repoRootArg,
      title: z.string().describe("one-line title for the claim: no tabs or control characters"),
    },
  },
  create_task: {
    description: "Create an active task: assigns the next id, writes the item file, then regenerates and validates (in local mode, into .generated/, after the same output checks as regenerate). In ledger mode the id is claimed from the local id ledger (never from a scan, so a missing ledger is an error naming `trellis claim --seed`); if a later write fails the item and generated files roll back but the claimed id stays claimed.",
    inputSchema: {
      ...repoRootArg,
      title: z.string().describe("one-line title"),
      summary: z.string().describe("one-sentence summary for the index"),
      milestone: z.string().describe("a configured milestone"),
      priority: z.string().describe("a configured priority"),
      effort: z.union([z.number(), z.string()]).describe("a canonical effort number, or a label from the active effort scale"),
      depends_on: z.array(z.string()).optional().describe("ids this task depends on"),
      owner: z.string().optional().describe("owner handle; must be an active member of the team roster (team.json)"),
      collaborators: z.array(z.string()).optional().describe("collaborator handles; each must be an active roster member"),
      body: z.string().optional().describe("Markdown body; Scope/Notes/Risks are scaffolded if omitted"),
    },
  },
  move_task: {
    description: "Move an active task to completed or removed: updates front-matter, prepends a closeout note, regenerates and validates.",
    inputSchema: {
      ...repoRootArg,
      id: z.string().describe("active task id to move"),
      to: z.enum(["completed", "removed"]).describe("target status"),
      reason: z.string().optional().describe("required when removing: why, and any trigger to revisit"),
      note: z.string().optional().describe("closeout note prepended to the body"),
      date: z.string().optional().describe("ISO close date (YYYY-MM-DD); defaults to today"),
      owner: z.string().optional().describe("override the owner on close (historical; pass empty to clear)"),
      collaborators: z.array(z.string()).optional().describe("override collaborators on close (historical)"),
    },
  },
  validate: {
    description: "Validate the backlog (config, items, markers); read-only. Returns { ok, errors, warnings }. With generatedArtifacts \"local\" it validates config, roster and items and scans the committed README and index files for leftover generated markers; no generated file is compared.",
    inputSchema: { ...repoRootArg },
  },
  regenerate: {
    description: "Rewrite any stale generated artifact. Returns { changed, nextId, counts }. In ledger mode the files on disk keep the scan nextId, and the returned nextId is the ledger preview (null with a note when there is no usable ledger). With generatedArtifacts \"local\" it writes only <tasksDir>/.generated/ (its backlog.json carries the ledger preview in ledger mode) and refuses before writing on a leftover marker or an output that git does not ignore or tracks.",
    inputSchema: { ...repoRootArg },
  },
  import: {
    description: "Import an existing backlog into this repo via a named profile or an inline mapping. Dry-run by default; pass apply:true to write items and regenerate (rolls back on any failure). Returns the import summary (counts, idMap, created, generated; preserved/reassigned/idFloor under preserveIds).",
    inputSchema: {
      ...repoRootArg,
      source: z.string().describe("path to the source backlog to import; a relative path resolves against the target repo"),
      profile: z.string().optional().describe("name of a built-in source-mapping profile (alternative to `mapping`)"),
      mapping: z.record(z.string(), z.any()).optional().describe("inline mapping object describing the source schema (alternative to `profile`)"),
      apply: z.boolean().optional().describe("write items and regenerate; omit or false for a dry-run (the default)"),
      preserveIds: z.boolean().optional().describe("keep a source id that matches the target format exactly (else assign fresh); collisions/mismatches are reassigned into the gap above the imported band"),
      idFloor: z.number().int().min(0).optional().describe("with preserveIds, the floor for the organic next id recorded in config; default auto — next 1000 above the imported band"),
    },
  },
  history: {
    description: "Read-only git-derived task history (SPEC §8.4). With an id → { id, entries }; omit id → { generated, tasks } keyed by id. Each entry is { id, commit, date, author, subject, reason } newest-first, where reason is the Trellis-Reason commit trailer when present, else the subject. Derived from git (requires a work tree); volatile and non-authoritative — never part of backlog:check, never writes.",
    inputSchema: {
      ...repoRootArg,
      id: z.string().optional().describe("a task id; omit to derive the whole repo"),
    },
  },
};

export function registerTools(server, defaultRoot) {
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, (args = {}) => {
      try {
        const root = args.repoRoot ? resolveRepoRoot(args.repoRoot) : defaultRoot;
        const result = OPS[name](root, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (e) {
        const msg = e instanceof TrellisError ? e.message : `unexpected error: ${e.message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    });
  }
}

// Resources serve the server's default repo (a static uri carries no per-call
// repoRoot). Only the resources whose backing file exists at boot are advertised,
// so the list never offers what this repo can't serve (e.g. SPEC.md is absent in
// onboarded repos until TRL0010). Returns the count registered.
function registerResources(server, defaultRoot) {
  // The resolved entries carry the mimeType `resources/read` will return.
  const available = listResources(defaultRoot).filter((r) => r.available);
  for (const r of available) {
    server.registerResource(
      r.name,
      r.uri,
      { title: r.title, description: r.description, mimeType: r.mimeType },
      () => {
        const { uri: u, mimeType, text } = readResource(defaultRoot, r.uri);
        return { contents: [{ uri: u, mimeType, text }] };
      },
    );
  }
  return available.size;
}

// Prompts are bound to the server's repo, exactly like resources — deliberately
// NOT given a per-call `repoRoot` override. A prompt's text points at the
// `trellis://…` resources, which resolve to `defaultRoot`; letting a prompt build
// against a different repo would make those pointers reference the wrong repo's
// conventions. Per-repo addressing across the whole surface (tools, prompts, AND
// resources, with root scoping) is TRL0019. A failed build (bad id)
// throws a TrellisError, which the SDK surfaces as the prompt's get error; a missing
// playbook returns a short handoff instead (TRL0040).
function registerPrompts(server, defaultRoot) {
  for (const p of PROMPTS) {
    const argsSchema = {};
    for (const a of p.arguments) {
      argsSchema[a.name] = a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description);
    }
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema }, (args = {}) =>
      buildPrompt(defaultRoot, p.name, args),
    );
  }
}

// True when this module is the process entry point. Resolve argv[1] through
// realpath first: `import.meta.url` is already symlink-resolved, so a bin-style /
// symlinked launch (npx, node_modules/.bin) would otherwise miss and the server
// would silently never boot. Guarded so a plain import (e.g. a test inspecting
// TOOLS) neither parses argv nor opens the stdio transport.
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const server = new McpServer({ name: "trellis", version: SERVER_VERSION });
  registerTools(server, opts.repo);
  const resourceCount = registerResources(server, opts.repo);
  registerPrompts(server, opts.repo);

  await server.connect(new StdioServerTransport());
  console.error(`trellis-mcp ready (repo: ${opts.repo}; ${Object.keys(OPS).length} tools, ${PROMPTS.length} prompts, ${resourceCount} resources)`);
}
