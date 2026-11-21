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
npx @taprootio/trellis init <target> --prefix ABC   # --dry-run to preview
```

It does not vendor the generator; the onboarded repo runs Trellis via the
package (the scaffolded CI calls `npx @taprootio/trellis check`), which ships in TRL0010.

A repo that already owns some of this can leave it out. `--skip <parts>` takes a
comma list (repeats are united) of `ci`, `pr-template`, `playbooks`,
`branch-protection` and `agents`; `agents` leaves AGENTS.md alone entirely. Init also
detects a repo that runs good-agent (a `good-agent.config.json` or
`.agents/skills/work-task/SKILL.md` file): it then skips the `playbooks` and writes a
compact AGENTS.md block that defers the loops to good-agent's `write-task`,
`work-task` and `review-loop` skills. `--with-playbooks` writes the playbooks and the
full block anyway; on a repo whose AGENTS.md already has a Trellis block it never
rewrites that block, and prints the full block for you to place, with a reminder to
carry over your Loop contract values. A rerun that restores the playbooks must repeat
your other `--skip` flags. If you skip `playbooks` in a repo that is not detected, the
TRELLIS block is not updated, so add the playbook pointers by hand.

Init never pushes AGENTS.md past the 32,768 bytes Codex reads: when the result would
be larger, it leaves the file alone, prints the block and says how many bytes it
needs, so you can trim the file or place the block by hand. The MCP `work-task`,
`code-review` and `pr-draft` prompts answer with a short handoff when their playbook
is absent: the good-agent skills in a detected repo, otherwise a
note naming the playbook and its dependency files: copy any missing ones from the
installed package's `templates/trellis/playbooks/` into `trellis/playbooks/` and keep
existing copies (the server cannot know your earlier skips, so it never suggests `init`).

By default the generated index and `backlog.json` are committed. To keep them out
of git (so parallel branches stop conflicting on them), set
`"generatedArtifacts": "local"` in `trellis/backlog.config.json`: `trellis generate`
then writes `trellis/.generated/`, which you add to `.gitignore`, and `trellis
check` validates the items and scans for leftover markers without comparing any
generated file. A repo that already commits them migrates with `trellis init
--switch-to-local`; the steps are in [`docs/import.md`](docs/import.md#switch-a-trellis-backlog-to-local-generated-artifacts)
and the rules in SPEC §8.5.

## Import an existing backlog

`trellis import` converts a backlog on a foreign schema into Trellis items in an
already-initialized repo, driven by a declarative mapping — either a built-in
**profile** (`--profile <name>`; run `--list-profiles`) or your own
`--mapping <file.json>`. It is **dry-run by default** — preview the plan and the id
map, then re-run with `--apply`:

```
npx @taprootio/trellis import <source> --profile yaml-frontmatter --target .   # add --apply to write
```

Ids are assigned fresh-sequentially from the target's next id, colliding source
ids are deduped, and `depends_on` is rewritten through the id map; the source tree
is never modified and a real run leaves the backlog `--check`-green. To scaffold
and import in one step on a fresh repo, use
`trellis init --import <path> --profile <name>`. The mapping schema, the built-in
profiles, and the full getting-started guide are in
[`docs/import.md`](docs/import.md).

## Claim task ids

Parallel worktrees that scan for the highest id can claim the same one. Set
`"idAllocation": "ledger"` in `trellis/backlog.config.json` and every worktree of a
clone hands out ids from one local git ref (`refs/trellis/ids`) instead. The ledger
is local only: nothing is pushed.

```
npx @taprootio/trellis claim --seed                  # create the ledger from the ids in every worktree
npx @taprootio/trellis claim --title "Short title"   # claim the next id and print it
npx @taprootio/trellis claim --list                  # print the tip and every ledger line
npx @taprootio/trellis claim --through <ID>          # reserve every id up to <ID>
```

In ledger mode `trellis generate` no longer prints a next id, and MCP
`create_task` claims through the ledger. Import is unsupported there (see
[`docs/import.md`](docs/import.md)). The format, cutover and recovery rules are in
SPEC §3.1.

## Track task history

`trellis history` reconstructs a per-task change log from git — who changed an
item, when, and why — surviving the active→completed move via `git log --follow`:

```
npx @taprootio/trellis history <id>      # one task; omit <id> for the whole repo
npx @taprootio/trellis history --write   # materialize trellis/history.json for a static viewer
```

Entries are `{ id, commit, date, author, subject, reason }`, newest-first, where
`reason` is a `Trellis-Reason:` commit trailer when present, else the commit
subject. This is a **derived, non-gated report** (SPEC §8.4): volatile and
non-authoritative (git is the record), so it is **not** part of `backlog:check`,
and the materialized `history.json` is gitignored — regenerate it at build time.

## View backlogs

`trellis serve` runs a local, read-only viewer for one or more backlogs, built
with Espalier controls. Each backlog is read from its repo's **main worktree**
(edits in linked worktrees do not show), and the page updates live as files
change there.

```
npx @taprootio/trellis serve                  # the current repo, at http://127.0.0.1:4747
npx @taprootio/trellis serve --config <file>  # several backlogs from a viewer config
```

A viewer config lists the backlogs to show, in display order
(`templates/viewer.example.json`):

```json
{
  "backlogs": [
    { "id": "taproot", "name": "Taproot", "path": "~/Documents/GitHub/taproot" },
    { "id": "espalier", "name": "Espalier", "path": "~/Documents/GitHub/taproot-controls" }
  ],
  "port": 4747,
  "bind": "127.0.0.1",
  "allowedHosts": ["trellis.test"]
}
```

Without `--config` or `--repo`, Trellis reads `$TRELLIS_VIEWER_CONFIG`, then
`$XDG_CONFIG_HOME/trellis/viewer.json`, then `~/.config/trellis/viewer.json`,
and serves the current repo when none exists. The startup line names the file
it loaded. Each backlog uses its own repo's config, so prefixes, milestones and
spec versions can differ; a backlog that cannot be read shows its error while
the others still serve. The viewer listens on loopback by default and answers
only `127.0.0.1`, `localhost`, its printed address and `allowedHosts`
(`--allow-host` adds one), so a proxy such as a local `*.test` route needs its
host name allowed. Reading needs git 2.36 or later.

Building the viewer from a checkout (`npm run build:viewer`, which `node --test`
and `npm pack` also run) needs Node `^20.19.0 || >=22.12.0`, rolldown's floor;
the published CLI keeps its Node 18 floor because it ships the built bundle.

## Operate over MCP

The backlog operations are also exposed as MCP tools, so any MCP-aware client
(Claude, Cursor, Windsurf, Codex, …) can list, read, create, move, validate,
regenerate, and read the history of tasks in a repo:

```
npx @taprootio/trellis mcp --repo <path>   # serves over stdio; defaults to cwd
```

Tools: `list_tasks`, `get_task`, `next_id`, `claim_id`, `create_task`, `move_task`,
`validate`, `regenerate`, `import`, `history` — each reuses the same core as the
CLI, so results carry the `backlog.json` shape (except `import`, which returns an
import summary, and `history`, which returns git-derived change entries). Mutating
tools regenerate and validate before returning, rolling back on failure; `import`
is dry-run unless `apply:true` (see [`docs/import.md`](docs/import.md)); `history`
is read-only. The process loops (work-a-task, review) ship separately as MCP
prompts in TRL0006.
