# Trellis

A tool-agnostic toolkit for running a file-based backlog the same way in any git
repo. This repository is Trellis, and it dogfoods its own conventions to manage
its own backlog.

Start with [`AGENTS.md`](AGENTS.md) for the conventions and the milestone ethos,
then browse the live backlog in [`trellis/README.md`](trellis/README.md).

## Onboard a repo

`trellis init` scaffolds the Trellis layout into any repo — the config, a team
roster stub, the `trellis/` layout, the generated index, the CI check, an AGENTS.md
backlog section, and the process playbooks — idempotently, without clobbering
existing files:

```
node scripts/trellis-init.mjs <target> --prefix ABC   # --dry-run to preview
```

It does not vendor the generator; the onboarded repo runs Trellis via the
package (the scaffolded CI calls `npx trellis check`), which ships in TRL0010.

## Import an existing backlog

`trellis import` converts a backlog on a foreign schema into Trellis items in an
already-initialized repo, driven by a declarative mapping — either a built-in
**profile** (`--profile <name>`; run `--list-profiles`) or your own
`--mapping <file.json>`. It is **dry-run by default** — preview the plan and the id
map, then re-run with `--apply`:

```
node scripts/trellis-import.mjs <source> --profile yaml-frontmatter --target .   # add --apply to write
```

Ids are assigned fresh-sequentially from the target's next id, colliding source
ids are deduped, and `depends_on` is rewritten through the id map; the source tree
is never modified and a real run leaves the backlog `--check`-green. To scaffold
and import in one step on a fresh repo, use
`trellis init --import <path> --profile <name>`. The mapping schema, the built-in
profiles, and the full getting-started guide are in
[`docs/import.md`](docs/import.md).

## Operate over MCP

The backlog operations are also exposed as MCP tools, so any MCP-aware client
(Claude, Cursor, Windsurf, Codex, …) can list, read, create, move, validate, and
regenerate tasks in a repo:

```
node scripts/trellis-mcp.mjs --repo <path>   # serves over stdio; defaults to cwd
```

Tools: `list_tasks`, `get_task`, `next_id`, `create_task`, `move_task`,
`validate`, `regenerate`, `import` — each reuses the same core as the CLI, so
results carry the `backlog.json` shape (except `import`, which returns an import
summary — counts, id map, created/generated paths). Mutating tools regenerate and
validate before returning, rolling back on failure; `import` is dry-run unless
`apply:true` (see [`docs/import.md`](docs/import.md)). The process loops
(work-a-task, review) ship separately as MCP prompts in TRL0006.
