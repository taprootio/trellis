# Completed tasks

Generated from `completed/tasks/`. Do not hand-edit between the markers — close a
task and run `npm run backlog:readme`.

<!-- BEGIN GENERATED:COMPLETED -->
| ID | Title | Summary | Completed |
| --- | --- | --- | --- |
| [TRL0003](tasks/TRL0003.md) | Build the `trellis init` scaffolder | One command that onboards any repo to the Trellis backlog — scaffolds the layout, config, generated index, CI check, AGENTS section, and process playbooks, idempotently and without clobbering. | 2026-06-26 |
| [TRL0004](tasks/TRL0004.md) | Build the MCP server (operations as tools) | Expose the backlog operations over MCP so any MCP-aware tool can list, read, create, move, validate, and regenerate tasks in any repo. | 2026-06-26 |
| [TRL0006](tasks/TRL0006.md) | Ship the process as MCP prompts + resources | Carry the "work a task" and "review" loops as MCP prompts and the spec/playbooks/templates as MCP resources, so the process travels to any MCP client, not just Claude. | 2026-06-26 |
| [TRL0007](tasks/TRL0007.md) | Separate the universal loop from per-repo conventions | Cleanly split the portable orchestration shape from repo-specific tech rules so the same loop works in any repo by reading a named conventions contract from its AGENTS.md. | 2026-06-26 |
| [TRL0015](tasks/TRL0015.md) | Optional custom effort scales (labels, emoji, images) | Let teams skin the Fibonacci effort scale with custom labels (e.g. fish sizes), emoji, and optional images — mapped 1:1 to the canonical numbers, which stay the stored contract. | 2026-06-26 |
| [TRL0016](tasks/TRL0016.md) | PR title/description standard, template, and draft shortcut | Enforce the shared PR title standard in CI with a config-driven, prefix-agnostic title lint; the template, draft shortcut, and MCP prompt already shipped. | 2026-06-26 |
| [TRL0001](tasks/TRL0001.md) | Define the Trellis backlog spec (v1) | Write the canonical, repo-agnostic spec for the file-based backlog — layout, front-matter schema, vocab, and generator contract. | 2026-06-25 |
| [TRL0002](tasks/TRL0002.md) | Build the config-driven generator core | Generalize the backlog generator into the reusable Trellis core — validate, regenerate README + backlog.json, compute next id, support --check. | 2026-06-25 |
| [TRL0017](tasks/TRL0017.md) | Code review standard and review shortcut | Add a repository code-review standard — a review shortcut that grounds in the repo's conventions and emits the canonical JSON findings format (file/line/severity/suggestion), scaffolded by init and graduating to an MCP prompt. | 2026-06-25 |
| [TRL0018](tasks/TRL0018.md) | Work-a-task playbook (end-to-end task loop) | Add the work-a-task shortcut — a fixed loop that refines a task with the user, plans with checkpoints, branches from clean main, works it end-to-end, runs the code-review playbook, fixes findings, and hands off for review. | 2026-06-25 |
<!-- END GENERATED:COMPLETED -->
