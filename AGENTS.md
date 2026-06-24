# AGENTS.md — Trellis

This repository is **Trellis**, a tool-agnostic toolkit for running a
file-based backlog the same way in any git repo. It manages **its own** backlog
with the very conventions it standardizes — so this file is both the guide
for working here and the reference implementation of the spec.

Any AI assistant or human working in this repo should read this file first. It
is canonical; narrower tool configs defer to it.

## What Trellis standardizes

1. A **file-based backlog** under `docs/tasks/` — one Markdown file per work
   item, metadata in YAML front-matter.
2. A **generator** (`scripts/backlog-readme.mjs`) that validates every item and
   regenerates the human index (`docs/tasks/README.md`) and the machine-readable
   `docs/tasks/backlog.json`. CI runs it with `--check`.
3. A **config** (`backlog.config.json`) that makes the conventions portable:
   ID prefix, milestone vocabulary, priorities, and effort scale live here, so
   the same generator drops into any repo unchanged.

## Backlog layout

- `docs/tasks/active/TRLxxxx.md` — open work. Front-matter: `id`, `title`,
  `status: active`, `milestone`, `priority`, `effort`, `depends_on`, `summary`.
- `docs/tasks/completed/tasks/TRLxxxx.md` — finished work, history preserved.
  Front-matter: `id`, `title`, `status: completed`, `completed_on`; carry over
  `priority`/`effort`/`depends_on`. Indexed in `completed/index.md`.
- `docs/tasks/removed/TRLxxxx.md` — work deliberately not pursued. Front-matter:
  `status: removed`, `removed_on`, `removed_reason`; no `milestone`. Archived,
  never deleted; the id is never reused. Indexed in `removed/index.md`.
- `docs/tasks/README.md` — generated index. Never hand-edit between the
  `BEGIN/END GENERATED` markers.
- `docs/tasks/backlog.json` — generated machine index. Never hand-edit.

IDs are `TRL` + 4 digits (`TRL0001`), taken from the **Next task ID** line in the
generated README. Never reuse an id.

## Front-matter schema

| field | required | rule |
| --- | --- | --- |
| `id` | yes | matches the filename (`TRL0007`) |
| `title` | yes | one line |
| `status` | yes | `active` \| `completed` \| `removed` |
| `milestone` | active only | one of the configured milestones |
| `priority` | active only | `High` \| `Medium` \| `Low` |
| `effort` | active only | Fibonacci: 1, 2, 3, 5, 8, 13, 21 |
| `depends_on` | yes | list of task ids (`[]` if none); each must exist |
| `summary` | active only | one sentence; feeds the README table |

`effort` is relative complexity, not time. `depends_on` may point at active or
completed ids, but a task should not be *worked* until its dependencies sit in
`completed/`.

## Milestones are a maturity axis (the ethos)

A milestone names the **release gate** a task must land in — nothing else. It is
a single, ordered axis:

- **Alpha** — make it work for us (dogfood). Rough edges acceptable.
- **Beta** — make it solid for friendly external users: stable schema, docs,
  real error handling.
- **v1** — make it publishable: polished, versioned, documented.
- **Future** — post-v1, or not yet scheduled.

What a milestone is **not**:

- Not a feature area — that is the `title` (and, later, labels).
- Not a priority — that is the `priority` field.
- Not an on-hold state — there is no on-hold. Park low-value work as low-priority
  `Alpha`, or move it to `removed/` with a `removed_reason` naming the trigger to
  revisit. If a dropped idea is worth keeping, file it as a `Future` task rather
  than removing it.

Change the milestone set in `backlog.config.json`; the generator enforces it.

## Workflow

After adding, moving, or editing any item, run `npm run backlog:readme` (or
`node scripts/backlog-readme.mjs`). It validates front-matter and regenerates the
README tables and `backlog.json`. CI runs `npm run backlog:check` (`--check`),
which fails if either is stale or any item is invalid.

**Closing a task:** move `active/TRLxxxx.md` → `completed/tasks/TRLxxxx.md`, set
`status: completed` with a real `completed_on` (ISO date), drop `milestone` and
`summary`, carry `priority`/`effort`/`depends_on`, add a row to
`completed/index.md`, and regenerate — in the same change that ships the work.

**Removing a task:** move to `removed/TRLxxxx.md`, set `status: removed` with
`removed_on`/`removed_reason`, add to `removed/index.md`, and regenerate.

## Roadmap

The work to build Trellis is tracked here — see `docs/tasks/README.md`. The
portable *process* (the "work a task" and "review" loops Taproot proved out) will
ship as MCP **prompts** plus Markdown playbooks, so any MCP-aware tool — Claude,
Cursor, Windsurf, Codex, Cline, Zed — runs the same loop. Until then, this file
is the convention of record.
