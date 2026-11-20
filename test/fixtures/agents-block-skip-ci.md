<!-- BEGIN TRELLIS -->
## Backlog (Trellis)

This repo uses [Trellis](https://github.com/taprootio/trellis) for a file-based
backlog. Work items live in `trellis/{active,completed/tasks,removed}/` as
Markdown files with YAML front-matter; ids are `DEMO` + 5 digits.

- `trellis/README.md`, `trellis/backlog.json`, and the
  `trellis/completed/index.md` / `trellis/removed/index.md` indexes are
  **generated** — never hand-edit between the `BEGIN/END GENERATED` markers.
- Per-repo vocabulary (id prefix, milestones, priorities, effort) lives in
  `trellis/backlog.config.json` (the backlog root is `trellis/` by default;
  override it with a `tasksDir` key).
- The team roster lives in `trellis/team.json` (members with a `handle`, `name`,
  optional `email`, and `status`). A task may set an optional `owner` (one handle)
  and `collaborators` (handles); on active items they must be active roster members.
- After adding, moving, or editing an item, regenerate with `npx @taprootio/trellis generate`.
- `main` is protected — work on a branch and open a PR. Enable the gate with the recipe in
  `trellis/branch-protection.md` (GitHub plus GitLab/Bitbucket/Azure DevOps).
- Commit messages and PR descriptions carry no AI/co-author attribution — never
  add `Co-Authored-By:` trailers or "Generated with …" footers.

### Loop contract

The playbooks in `trellis/playbooks/` are universal; they name **seam points** and
read this repo's values from here. See `trellis/playbooks/conventions.md` for the
contract, then set these to match your tooling:

| seam point | this repo's value |
| --- | --- |
| `regenerate` | `npx @taprootio/trellis generate` |
| `check` | `npx @taprootio/trellis check` |
| `branch-naming` | `<initials>/<id-lowercase>/<slug>` (e.g. `ab/demo00001/short-slug`) |
| `gates` | `npx @taprootio/trellis check` (plus this repo's tests/lint) |
| `attribution` | none — no `Co-Authored-By:` trailers or "Generated with …" footers |

See `trellis/playbooks/` for the work-a-task and code-review loops.
<!-- END TRELLIS -->
