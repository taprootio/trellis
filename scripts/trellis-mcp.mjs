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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { OPS, TrellisError } from "../src/mcp.mjs";
import { RESOURCES, PROMPTS, listResources, readResource, buildPrompt } from "../src/prompts.mjs";

// Server implementation version (distinct from the spec version; packaging and
// real versioning are TRL0010).
const SERVER_VERSION = "0.1.0";

function parseArgs(argv) {
  let repo = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i];
    else if (a.startsWith("--repo=")) repo = a.slice("--repo=".length);
    else if (a === "-h" || a === "--help") return { help: true };
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return { repo: resolve(repo) };
}

const HELP = `trellis-mcp — serve the Trellis backlog operations over MCP (stdio)

Usage:
  node scripts/trellis-mcp.mjs [--repo <path>]

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
    description: "List backlog tasks (the backlog.json shape), optionally filtered by status or milestone.",
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
    description: "The id a newly created task would receive.",
    inputSchema: { ...repoRootArg },
  },
  create_task: {
    description: "Create an active task: assigns the next id, writes the item file, then regenerates and validates.",
    inputSchema: {
      ...repoRootArg,
      title: z.string().describe("one-line title"),
      summary: z.string().describe("one-sentence summary for the index"),
      milestone: z.string().describe("a configured milestone"),
      priority: z.string().describe("a configured priority"),
      effort: z.union([z.number(), z.string()]).describe("a canonical effort number, or a label from the active effort scale"),
      depends_on: z.array(z.string()).optional().describe("ids this task depends on"),
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
    },
  },
  validate: {
    description: "Validate the backlog (config, items, markers); read-only. Returns { ok, errors, warnings }.",
    inputSchema: { ...repoRootArg },
  },
  regenerate: {
    description: "Rewrite any stale generated artifact. Returns { changed, nextId, counts }.",
    inputSchema: { ...repoRootArg },
  },
  import: {
    description: "Import an existing backlog into this repo via a named profile or an inline mapping. Dry-run by default; pass apply:true to write items and regenerate (rolls back on any failure). Returns the import summary (counts, idMap, created, generated).",
    inputSchema: {
      ...repoRootArg,
      source: z.string().describe("path to the source backlog to import; a relative path resolves against the target repo"),
      profile: z.string().optional().describe("name of a built-in source-mapping profile (alternative to `mapping`)"),
      mapping: z.record(z.string(), z.any()).optional().describe("inline mapping object describing the source schema (alternative to `profile`)"),
      apply: z.boolean().optional().describe("write items and regenerate; omit or false for a dry-run (the default)"),
    },
  },
};

function registerTools(server, defaultRoot) {
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, (args = {}) => {
      try {
        const root = args.repoRoot ? resolve(args.repoRoot) : defaultRoot;
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
  const available = new Set(listResources(defaultRoot).filter((r) => r.available).map((r) => r.uri));
  const byUri = new Map(RESOURCES.map((r) => [r.uri, r]));
  for (const uri of available) {
    const r = byUri.get(uri);
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
// resources, with root scoping) is TRL0019. A failed build (bad id, missing
// playbook) throws a TrellisError, which the SDK surfaces as the prompt's get error.
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
