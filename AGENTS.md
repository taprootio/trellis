# AGENTS.md — Trellis

This repository is **Trellis**, a tool-agnostic toolkit for running a file-based
backlog the same way in any git repo. It dogfoods its own conventions to manage
its own backlog, so it is also the reference implementation of the spec.

Any AI assistant or human working here should read this file first, then
[`SPEC.md`](SPEC.md) for the full, canonical specification.

## Backlog at a glance

- Work items live in `trellis/{active,completed/tasks,removed}/`, one Markdown
  file per item with YAML front-matter. Ids are `TRL` + 4 digits.
- `trellis/README.md` and `trellis/backlog.json` are **generated** — never
  hand-edit them (or any text between the `BEGIN/END GENERATED` markers).
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  [`trellis/backlog.config.json`](trellis/backlog.config.json); this repo targets
  `specVersion 2.4`. The backlog root is `trellis/` by default (overridable via the
  config's `tasksDir` key); the config file's own location is fixed there.
- The team roster lives in [`trellis/team.json`](trellis/team.json) (members with a
  `handle`, `name`, optional `email`, and `status`). Tasks may set an optional
  `owner` (one handle) and `collaborators` (handles); on active items they must be
  active roster members (SPEC.md §7.2).
- Milestones are a single, ordered **maturity** axis — `Alpha → Beta → v1 →
  Future` — not feature areas or priorities (SPEC.md §7.1).

For the front-matter schema, status lifecycle, effort scales, the generator /
`--check` contract, and the `backlog.json` shape, see [`SPEC.md`](SPEC.md).

## Working here

- After adding, moving, or editing any item, run `npm run backlog:readme` to
  validate and regenerate. CI runs `npm run backlog:check` (`--check`).
- `main` is **protected** — do not commit to it directly. Work on a branch
  (`je/<id>/<slug>` for task work), open a PR, and let the required backlog check
  (the pinned `backlog` job) gate the merge. Setup recipe, including non-GitHub
  forges: [`trellis/branch-protection.md`](trellis/branch-protection.md).
- Commit messages and PR descriptions carry **no AI/co-author attribution** —
  never add `Co-Authored-By:` trailers or "Generated with …" footers.
- Closing a task: move it to `completed/tasks/`, set `status: completed` +
  `completed_on`, and regenerate (the completed index is generated) — in the same
  change. Full rules in SPEC.md §4–§5.
- To take a task from `active/` to ready-for-review, follow
  [`trellis/playbooks/work-task.md`](trellis/playbooks/work-task.md) — refine with the
  user, plan, branch, work, review, hand off.
- Code reviews follow [`trellis/playbooks/code-review.md`](trellis/playbooks/code-review.md):
  ground in these conventions first, then report findings as the canonical JSON
  array (`file` / `line` / `severity` blocker·warning·nit / `suggestion`).

### Loop contract

The universal playbooks name **seam points**; this block is where Trellis (the
reference instance) declares their values. See
[`trellis/playbooks/conventions.md`](trellis/playbooks/conventions.md) for the contract.

| seam point | this repo's value |
| --- | --- |
| `regenerate` | `npm run backlog:readme` |
| `check` | `npm run backlog:check` |
| `branch-naming` | `je/<id-lowercase>/<slug>` (e.g. `je/trl0007/portable-loop`) |
| `gates` | `npm run backlog:check` + `node --test` |
| `attribution` | none — no `Co-Authored-By:` trailers or "Generated with …" footers |

## Roadmap

The work to build Trellis is tracked in `trellis/README.md`. The backlog
operations are exposed as MCP **tools** (`npm run trellis:mcp`, reusing the same
core as the CLI; see `src/mcp.mjs`). The portable *process* — the "work a task"
and "review" loops Taproot proved out — layers on top as MCP **prompts**
(`work-task`, `code-review`, `pr-draft`) plus the spec/conventions/playbooks as
MCP **resources** (`trellis://…`) and the equivalent Markdown playbooks (TRL0006;
see `src/prompts.mjs`), so any MCP-aware tool (Claude, Cursor, Windsurf, Codex,
Cline, Zed) runs the same loop. Prompts and resources read the repo's own files
live and serve the server's repo (`--repo` / cwd); a shared server that keys them
by `repoRoot` is TRL0019.
