# The per-repo conventions contract

The work-a-task, code-review, and pr-draft playbooks are **universal** — they
describe the *shape* of the loop (refine → plan → branch → work → review → close)
and the *output standards*, and nothing about any one repo's stack. Everything
that is repo-specific — which command regenerates the backlog, how branches are
named, which gates must stay green — is read at runtime from the repo's own
`AGENTS.md`.

This file defines that seam: the **named points** a playbook refers to, and the
rule for where their values live. The *definition* here is universal and travels
unchanged into every Trellis repo; the *values* are per-repo and live in each
repo's `AGENTS.md` "Loop contract" block (scaffolded by `trellis init`). A
playbook step names a seam point as its instruction ("regenerate the backlog");
any concrete command it shows is a tagged example of *one* repo's value, never
the command a different repo should run.

## Seam points

| seam point | what the loop needs | this repo's value lives in |
| --- | --- | --- |
| `regenerate` | the command that revalidates items and rewrites the generated index + `backlog.json` after any item add/move/edit | `AGENTS.md` |
| `check` | the read-only gate the loop keeps green locally and CI enforces (validate + verify-no-drift, non-zero on failure) | `AGENTS.md` |
| `branch-naming` | the pattern for a task branch, e.g. `<initials>/<id-lowercase>/<slug>` | `AGENTS.md` |
| `gates` | any other gates a change must keep green before review (tests, lint, build) | `AGENTS.md` |
| `attribution` | the commit/PR attribution policy (Trellis convention: none) | `AGENTS.md` |

Two more inputs the loop reads, defined elsewhere and referenced here for
completeness:

- **id vocabulary** (id prefix/width, milestones, priorities, effort) — from
  `backlog.config.json` (SPEC.md §7), not restated per playbook.
- **tasks layout** (`docs/tasks/{active,completed/tasks,removed}/`, the generated
  artifacts) — fixed by the spec (SPEC.md §2), the same in every repo.

## How a repo declares its values

`trellis init` writes a "Loop contract" block into the onboarded repo's
`AGENTS.md` with that repo's values (e.g. `npx trellis generate` / `npx trellis
check`, a branch pattern, the attribution policy). A repo edits those values to
match its own tooling; the playbooks need no change to follow them, because they
only ever name the seam point.

This repo (Trellis) is its own reference instance — see its `AGENTS.md` Loop
contract block for the concrete values the playbooks' tagged examples come from.

## How a playbook uses a seam point

> Rewrite the task file, then **regenerate the backlog** (the repo's `regenerate`
> command — this repo: `npm run backlog:readme`; see AGENTS.md) and commit it.

The instruction is "regenerate the backlog"; `npm run backlog:readme` is Trellis's
value, tagged as such. In an onboarded repo the same step resolves to that repo's
`regenerate` value with no edit to the playbook.
