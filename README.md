# Trellis

A tool-agnostic toolkit for running a file-based backlog the same way in any git
repo. This repository is Trellis, and it dogfoods its own conventions to manage
its own backlog.

Start with [`AGENTS.md`](AGENTS.md) for the conventions and the milestone ethos,
then browse the live backlog in [`trellis/README.md`](trellis/README.md).

## Onboard a repo

`ai-trellis init` scaffolds the Trellis layout into any repo — the config, a team
roster stub, the `trellis/` layout, the generated index, the CI check, an AGENTS.md
backlog section, and the process playbooks — idempotently, without clobbering
existing files:

```
npx ai-trellis init <target> --prefix ABC   # --dry-run to preview
```

It does not vendor the generator; the onboarded repo runs Trellis via the
package (the scaffolded CI calls `npx ai-trellis check`), which ships in TRL0010.

## Import an existing backlog

`ai-trellis import` converts a backlog on a foreign schema into Trellis items in an
already-initialized repo, driven by a declarative mapping — either a built-in
**profile** (`--profile <name>`; run `--list-profiles`) or your own
`--mapping <file.json>`. It is **dry-run by default** — preview the plan and the id
map, then re-run with `--apply`:

```
npx ai-trellis import <source> --profile yaml-frontmatter --target .   # add --apply to write
```

Ids are assigned fresh-sequentially from the target's next id, colliding source
ids are deduped, and `depends_on` is rewritten through the id map; the source tree
is never modified and a real run leaves the backlog `--check`-green. To scaffold
and import in one step on a fresh repo, use
`ai-trellis init --import <path> --profile <name>`. The mapping schema, the built-in
profiles, and the full getting-started guide are in
[`docs/import.md`](docs/import.md).

## Track task history

`ai-trellis history` reconstructs a per-task change log from git — who changed an
item, when, and why — surviving the active→completed move via `git log --follow`:

```
npx ai-trellis history <id>      # one task; omit <id> for the whole repo
npx ai-trellis history --write   # materialize trellis/history.json for a static viewer
```

Entries are `{ id, commit, date, author, subject, reason }`, newest-first, where
`reason` is a `Trellis-Reason:` commit trailer when present, else the commit
subject. This is a **derived, non-gated report** (SPEC §8.4): volatile and
non-authoritative (git is the record), so it is **not** part of `backlog:check`,
and the materialized `history.json` is gitignored — regenerate it at build time.

## Operate over MCP

The backlog operations are also exposed as MCP tools, so any MCP-aware client
(Claude, Cursor, Windsurf, Codex, …) can list, read, create, move, validate,
regenerate, and read the history of tasks in a repo:

```
npx ai-trellis mcp --repo <path>   # serves over stdio; defaults to cwd
```

Tools: `list_tasks`, `get_task`, `next_id`, `create_task`, `move_task`,
`validate`, `regenerate`, `import`, `history` — each reuses the same core as the
CLI, so results carry the `backlog.json` shape (except `import`, which returns an
import summary, and `history`, which returns git-derived change entries). Mutating
tools regenerate and validate before returning, rolling back on failure; `import`
is dry-run unless `apply:true` (see [`docs/import.md`](docs/import.md)); `history`
is read-only. The process loops (work-a-task, review) ship separately as MCP
prompts in TRL0006.
