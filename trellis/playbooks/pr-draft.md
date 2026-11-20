# Playbook: draft a PR title and description

A ready-to-use shortcut for generating a **copy-ready** PR title and description.
Point any AI assistant at this file, or invoke the equivalent `pr-draft` MCP
prompt (served from this file by the Trellis MCP server) so any tool can run it.
Follow the branch below that matches the repo: it either has a PR template or it
does not.

## What the assistant should gather first

- Commits on the branch: `git log --oneline <base>..HEAD` (base is usually `main`).
- The change surface: `git diff --stat <base>...HEAD`.
- The referenced task file(s) under the backlog root (default `trellis/`).

## With a PR template

The repo has [`.github/pull_request_template.md`](../../.github/pull_request_template.md).
The description conforms to it.

Also gather the PR template: `.github/pull_request_template.md`.

> Generate a pull-request **title** and **description** for the current branch,
> based only on its actual commits and diff (do not invent changes).
>
> - **Description:** fill every section of `.github/pull_request_template.md`
>   (Summary, Task, Changes, Verification, Follow-ups). Tick a checklist item
>   only when the evidence supports it; otherwise leave it unchecked and say why.
> - **Output:** a single fenced `markdown` block whose first line is the title as
>   `# <ID>: …`, followed by the completed template body — so it copies in one
>   click.

One copy-ready Markdown block:

- first line: `# <ID>: <summary>` (the title)
- then the filled template (Summary, Task, Changes, Verification, Follow-ups)

## Without a PR template

The repo has no PR template. Follow the repo's own PR instructions (its
`AGENTS.md` or `CONTRIBUTING` file) for what a description must say, and write the
description to them.

> Generate a pull-request **title** and **description** for the current branch,
> based only on its actual commits and diff (do not invent changes).

One copy-ready Markdown block:

- first line: `# <ID>: <summary>` (the title)
- then the description, written to the repo's own PR instructions

## Title and attribution (both branches)

- **Title:** `<ID>: <imperative summary>`, ≤ 72 characters, where `<ID>` is the
  repo's backlog id (its configured prefix + number). Lead with the primary
  backlog id; if the branch spans several items, name the primary and mention
  the others in the body.
- **Attribution:** follow the repo's `attribution` policy (AGENTS.md); the
  default is none — no `Co-Authored-By:` trailers or AI "Generated with …"
  footers in the title or description.
