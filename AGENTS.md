# AGENTS.md — Trellis

This repository is **Trellis**, a tool-agnostic toolkit for running a file-based
backlog the same way in any git repo. It dogfoods its own conventions to manage
its own backlog, so it is also the reference implementation of the spec.

Any AI assistant or human working here should read this file first, then
[`SPEC.md`](SPEC.md) for the full, canonical specification.

## Backlog at a glance

- Work items live in `docs/tasks/{active,completed/tasks,removed}/`, one Markdown
  file per item with YAML front-matter. Ids are `TRL` + 4 digits.
- `docs/tasks/README.md` and `docs/tasks/backlog.json` are **generated** — never
  hand-edit them (or any text between the `BEGIN/END GENERATED` markers).
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  [`backlog.config.json`](backlog.config.json); this repo targets `specVersion 1.0`.
- Milestones are a single, ordered **maturity** axis — `Alpha → Beta → v1 →
  Future` — not feature areas or priorities (SPEC.md §7.1).

For the front-matter schema, status lifecycle, effort scales, the generator /
`--check` contract, and the `backlog.json` shape, see [`SPEC.md`](SPEC.md).

## Working here

- After adding, moving, or editing any item, run `npm run backlog:readme` to
  validate and regenerate. CI runs `npm run backlog:check` (`--check`).
- `main` is **protected** — do not commit to it directly. Work on a branch
  (`je/<id>/<slug>` for task work), open a PR, and let the required backlog check
  gate the merge.
- Closing a task: move it to `completed/tasks/`, set `status: completed` +
  `completed_on`, and regenerate (the completed index is generated) — in the same
  change. Full rules in SPEC.md §4–§5.
- Code reviews follow [`docs/playbooks/code-review.md`](docs/playbooks/code-review.md):
  ground in these conventions first, then report findings as the canonical JSON
  array (`file` / `line` / `severity` blocker·warning·nit / `suggestion`).

## Roadmap

The work to build Trellis is tracked in `docs/tasks/README.md`. The portable
*process* — the "work a task" and "review" loops Taproot proved out — will ship
as MCP **prompts** plus Markdown playbooks, so any MCP-aware tool (Claude,
Cursor, Windsurf, Codex, Cline, Zed) runs the same loop.
