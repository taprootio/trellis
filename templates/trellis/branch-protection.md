# Enabling branch protection

The Trellis spec (§10, "CI and branch protection") makes a gated default branch
part of being Trellis-conformant: the default branch is **protected**, changes
land via pull/merge request, and the generator's **`--check` is a required status
check**. Your CI runs `trellis check` in a job of its own; this recipe turns the
status of that job (your CI status) into an enforced gate. Branch protection is a
host-repo setting, not committed code, so it is enabled once per repo by an admin
— it does not travel in a commit the way a workflow does.

## The required-check context

The check you require is identified by a **stable context name**: the name of the
CI job that runs `trellis check`. Use that job's exact name, and keep it stable —
a rename of the job is a visible edit rather than a silent gate-disabling drift
(the risk §10's stable-context guidance guards against). If you change the job
name, update the required check to match.

### Example: if you installed Trellis's workflow

`trellis init` can scaffold a workflow whose job is named **`backlog`**:

```yaml
# .github/workflows/backlog.yml
name: Backlog Hygiene     # ← the WORKFLOW's display name (not the check context)
jobs:
  backlog:
    name: backlog         # ← the JOB name == the required status check context
```

With that workflow, require the check named **`backlog`**, not `Backlog Hygiene`.
The job carries an explicit `name: backlog` so the context is pinned: renaming the
workflow's display name cannot move it.

## GitHub

### With `gh` (scriptable)

Use PUT only to create a new protection rule: it replaces the whole rule, so on a
branch that already has one it would wipe the existing settings. With a rule in
place, edit it in the UI instead (below).

From a clone of the repo, with the [`gh`](https://cli.github.com/) CLI
authenticated and admin on the repo. `gh` substitutes `{owner}`/`{repo}` from the
current repository; replace `main` if your default branch differs, and replace
`<your-ci-status>` with the name of your CI job that runs `trellis check`:

```bash
gh api --method PUT repos/{owner}/{repo}/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["<your-ci-status>"] },
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "enforce_admins": true,
  "restrictions": null
}
JSON
```

- `required_status_checks.contexts` — the gate: your CI status, the job that runs
  `trellis check`. `strict: true` also requires the branch to be up to date before
  merging; drop it if you don't want that.
- `required_pull_request_reviews` — requires changes to land via PR. Set
  `required_approving_review_count: 0` to require a PR without a mandatory
  approval, or raise it for more reviewers.
- `enforce_admins: true` — applies the rule to admins too; relax if you need an
  admin escape hatch.
- `restrictions: null` — no push allow-list. All four top-level keys must be
  present (a key may be `null`); this is the minimal conformant payload.

### In the UI

**Settings → Branches → Add branch ruleset** (or **Add rule** under the classic
"Branch protection rules"), targeting the default branch. If the default branch
already has a rule, edit the rule that covers the default branch instead of adding a
second one: add your CI status to its required checks and keep its existing checks.

1. **Require a pull request before merging** (optionally require approvals).
2. **Require status checks to pass before merging** → search for and select
   your CI status, the job that runs `trellis check`. Optionally enable "Require
   branches to be up to date."
3. Save.

> Your CI status only appears in the picker after the job has run at least once
> on the repo. Push the scaffold (or open a first PR) so the check registers, then
> add it to the rule.

## Other forges

The same two requirements — a protected default branch and a required check —
map onto every major forge. The "check" is whichever CI job runs `trellis check`
(its name is the context you require); on forges without GitHub-style named contexts, the gate is
"the pipeline/build must succeed."

### GitLab

- **Protected branch** — *Settings → Repository → Protected branches*: protect the
  default branch, set **Allowed to push and merge → No one** (force changes
  through merge requests) and **Allowed to merge** to the appropriate role.
- **Required check** — *Settings → Merge requests*: enable **Pipelines must
  succeed** so an MR can't merge unless its pipeline (the job running
  `trellis check`) passes; optionally require approvals. Scriptable via
  `PUT /projects/:id` with `only_allow_merge_if_pipeline_succeeds: true` and
  `POST /projects/:id/protected_branches`.

### Bitbucket

- **Protected branch** — *Repository settings → Branch restrictions*: add a
  restriction on the default branch — **Prevent changes without a pull request**
  (and prevent direct pushes).
- **Required check** — in the same restriction, add the merge check **require
  passing builds** (minimum 1). The Pipelines step that runs `trellis check`
  reports its build status via the Build Status API; require a minimum number of
  approvals if desired.

### Azure DevOps

- **Protected branch** — *Repos → Branches → ⋯ on the default branch → Branch
  policies*. Adding any policy blocks direct pushes; add **Require a minimum
  number of reviewers** to force PRs.
- **Required check** — add a **Build validation** policy that references the
  pipeline running `trellis check` (set it Required). If the pipeline reports via
  the Status API instead, use a **Status checks** policy referencing that context.

## Verify the gate

Open a throwaway PR that makes the check fail, and confirm your CI status fails
and the merge button is blocked until it passes. Close the PR without merging.

- **Committed generated files** (the default): drift the index — e.g. edit a generated
  file between its `BEGIN/END GENERATED` markers, or add a valid item without
  regenerating.
- **`generatedArtifacts: "local"`**: there is nothing committed to drift, so break
  validity instead — add an invalid item (a missing required field), or leave a
  generated marker line in `README.md`.
