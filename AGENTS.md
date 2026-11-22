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
  `specVersion 2.5`. The backlog root is `trellis/` by default (overridable via the
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
- To take a task from `active/` to ready-for-review, follow the shipped
  `work-task` skill (see the GOOD-AGENT block below); write new stories with the
  `write-task` skill.
- Reviews follow the shipped `review-loop` skill: ground in these conventions
  first, then report findings as the canonical JSON array (`file` / `line` /
  `severity` blocker·warning·nit / `suggestion`).

### Loop contract

The universal playbooks name **seam points**; this block is where Trellis (the
reference instance) declares their values. See
[`trellis/playbooks/conventions.md`](trellis/playbooks/conventions.md) for the contract.

| seam point | this repo's value |
| --- | --- |
| `regenerate` | `npm run backlog:readme` |
| `check` | `npm run backlog:check` |
| `branch-naming` | `je/<id-lowercase>/<slug>` (e.g. `je/trl0007/portable-loop`) |
| `gates` | `npm run backlog:check` + `node --test` + `npm run check:agent` |
| `attribution` | none — no `Co-Authored-By:` trailers or "Generated with …" footers |

<!-- BEGIN GOOD-AGENT -->
## Review policy (good-agent)

Work is reviewed with the `review-loop` skill: internally in a fresh
context until clean, then externally by the other AI tool until clean.
Claude-authored work is reviewed by Codex and Codex-authored work by
Claude (`review.externalReviewer` in `good-agent.config.json`). Review
runs at the configured ceiling (`review.codex`, `review.claude`); never
raise it without the owner. Closeouts record independence, rounds and
dispositions, never a model name.

Stories are written with the `write-task` skill, and task work follows the
`work-task` skill, which runs `review-loop` on the plan and on the diff. All
three are installed under `.agents/skills/` and `.claude/skills/` by `npx
good-agent init --skill` as generated copies; do not edit them. For this
repo's own task work they replace the loop pointers to `trellis/playbooks/`.
The backlog lifecycle above still governs: where a task file lives, the
Loop contract seam points, and closing a task. Run the external diff review with `npx --no-install good-agent review
--author <claude|codex> --base <base sha> --task <task path> --verified
"<check>"`; plan and story reviews add `--prompt plan` or `--prompt story`.
The task path is `trellis/active/<id>.md` while the task is open and
`trellis/completed/tasks/<id>.md` for a re-review after closeout. The base
is the task branch's starting commit, or for a PR-time re-review after a
merge or rebase, the freshly fetched PR base commit. A commit
that only updates a task's review record needs no further review round.
`npm run check:agent` is one of the `gates`; contributor tooling needs
Node 22.12.0 or later (the stricter of good-agent's floor and the viewer
build's rolldown floor), while the published package still supports
Node 18.

Releases: merging a `package.json` `version` change to `main` publishes
(`.github/workflows/release.yml`), and the GitHub release uses generated
notes. There is no changelog file, so the skills' changelog step does not
apply here. Record the version decision (bump and why, or no release) in
the task and the PR body.
<!-- END GOOD-AGENT -->

## Roadmap

The work to build Trellis is tracked in `trellis/README.md`. The backlog
operations are exposed as MCP **tools** (`npm run trellis:mcp`, reusing the same
core as the CLI; see `src/mcp.mjs`). The portable *process* — the "work a task"
and "review" loops Taproot proved out — layers on top as MCP **prompts**
(`work-task`, `code-review`, `pr-draft`) plus the spec/conventions/playbooks as
MCP **resources** (`trellis://…`) and the equivalent Markdown playbooks (TRL0006;
see `src/prompts.mjs`), so any MCP-aware tool (Claude, Cursor, Windsurf, Codex,
Cline, Zed) runs the same loop. Those prompts and playbooks are product features
for repos that use Trellis; Trellis's own contributors use the shipped
good-agent skills instead, including `open-pr` to draft and open pull
requests (it adds the release decision and review record that `pr-draft`
and the PR template leave out). Prompts and resources read the repo's own files
live and serve the server's repo (`--repo` / cwd); a shared server that keys them
by `repoRoot` is TRL0019.
