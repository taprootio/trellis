# Playbook: code review

A ready-to-use shortcut for reviewing work in a Trellis repo. Point any AI
assistant at this file, or invoke the equivalent `code-review` MCP prompt (served
from this file by the Trellis MCP server). The
*what to check* defers to the repo's own conventions (AGENTS.md / SPEC.md), so
this stays tech-agnostic — the **process** and the **output format** are the
standard.

## Process

1. **Ground in the repo's conventions first.** Read AGENTS.md (canonical) and any
   SPEC.md / docs the change touches. You cannot judge work against rules you
   have not read. Seam points named in code font (`check`, `gates`) read their
   value from AGENTS.md — see [`conventions.md`](conventions.md).
2. **Identify the task.** Determine the `TRLxxxx` this work belongs to (branch
   name, commits, the added/moved file under `docs/tasks/`). Review against its
   stated intent, not just the diff in isolation.
3. **Verify closeout** when the work claims to finish a task: the item moved to
   `completed/tasks/` with `status: completed` + `completed_on`, the generated
   artifacts are current (the repo's `check` command passes — this repo:
   `npm run backlog:check`; see AGENTS.md), and links hold. Flag any miss as a
   `blocker`.
4. **Review thoroughly, twice.** First pass for the obvious; second pass for what
   you rationalized away — data and control flow across seams, behavior under
   failure / edge / hostile input, and what *should* have changed but didn't
   (missing tests, a stale doc, an un-updated snapshot).
5. **Run the gates you can** — the repo's `check` command and its `gates`
   (tests/lint; this repo: `npm run backlog:check` + `node --test`; see AGENTS.md).
   A failing gate is a `blocker`.

## Output format (the standard)

Put any discussion first, then end with **exactly one** fenced `json` block
containing a single array and nothing after it, so it pastes into PR/issue
tooling in one click. The array is always last, even when empty.

Each finding is an object:

- `file` — repo-relative path to the file that needs to change.
- `line` — line number where the change applies.
- `severity` — one of `"blocker"`, `"warning"`, `"nit"`.
- `suggestion` — concise fix, including the exact change to make.

```json
[
  {
    "file": "src/backlog.mjs",
    "line": 153,
    "severity": "blocker",
    "suggestion": "Validate completed/removed items too — the loop only iterates active, so a completed task with status: active passes --check."
  },
  {
    "file": "src/backlog.mjs",
    "line": 55,
    "severity": "warning",
    "suggestion": "Reject non-numeric config effort values; `[\"Tiny\"]` currently passes."
  }
]
```

Use `[]` when there are no findings. `severity` lets the author triage every
`blocker` before any `nit` without re-reading the list.
