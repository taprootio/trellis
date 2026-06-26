# Playbook: draft a PR title and description

A ready-to-use shortcut for generating a **copy-ready** PR title and description
that conform to [`.github/pull_request_template.md`](../../.github/pull_request_template.md).
Point any AI assistant at this file, or invoke the equivalent `pr-draft` MCP
prompt (served from this file by the Trellis MCP server) so any tool can run it.

## What the assistant should gather first

- Commits on the branch: `git log --oneline <base>..HEAD` (base is usually `main`).
- The change surface: `git diff --stat <base>...HEAD`.
- The PR template: `.github/pull_request_template.md`.
- The referenced task file(s) under `docs/tasks/`.

## Prompt

> Generate a pull-request **title** and **description** for the current branch,
> based only on its actual commits and diff (do not invent changes).
>
> - **Title:** `TRLxxxx — <imperative summary>`, ≤ 72 characters. Lead with the
>   primary backlog id; if the branch spans several items, name the primary and
>   mention the others in the body.
> - **Description:** fill every section of `.github/pull_request_template.md`
>   (Summary, Task, Changes, Verification, Follow-ups). Tick a checklist item
>   only when the evidence supports it; otherwise leave it unchecked and say why.
> - **Attribution:** follow the repo's `attribution` policy (e.g. no
>   `Co-Authored-By:` trailers or AI "Generated with …" footers in the title or
>   description; see AGENTS.md).
> - **Output:** a single fenced `markdown` block whose first line is the title as
>   `# TRLxxxx — …`, followed by the completed template body — so it copies in one
>   click.

## Output shape

One copy-ready Markdown block:

- first line: `# TRLxxxx — <summary>` (the title)
- then the filled template (Summary, Task, Changes, Verification, Follow-ups)
