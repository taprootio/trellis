# Trellis

A tool-agnostic toolkit for running a file-based backlog the same way in any git
repo. This repository is Trellis, and it dogfoods its own conventions to manage
its own backlog.

Start with [`AGENTS.md`](AGENTS.md) for the conventions and the milestone ethos,
then browse the live backlog in [`docs/tasks/README.md`](docs/tasks/README.md).

## Onboard a repo

`trellis init` scaffolds the Trellis layout into any repo — the config, the
`docs/tasks/` layout, the generated index, the CI check, an AGENTS.md backlog
section, and the process playbooks — idempotently, without clobbering existing
files:

```
node scripts/trellis-init.mjs <target> --prefix ABC   # --dry-run to preview
```

It does not vendor the generator; the onboarded repo runs Trellis via the
package (the scaffolded CI calls `npx trellis check`), which ships in TRL0010.

## Operate over MCP

The backlog operations are also exposed as MCP tools, so any MCP-aware client
(Claude, Cursor, Windsurf, Codex, …) can list, read, create, move, validate, and
regenerate tasks in a repo:

```
node scripts/trellis-mcp.mjs --repo <path>   # serves over stdio; defaults to cwd
```

Tools: `list_tasks`, `get_task`, `next_id`, `create_task`, `move_task`,
`validate`, `regenerate` — each reuses the same core as the CLI, so results carry
the `backlog.json` shape. Mutating tools regenerate and validate before
returning, rolling back on failure. The process loops (work-a-task, review) ship
separately as MCP prompts in TRL0006.
