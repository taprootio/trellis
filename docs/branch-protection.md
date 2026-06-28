# Enabling branch protection

[SPEC.md](../SPEC.md) §10 makes a gated default branch part of being
Trellis-conformant: the default branch is **protected**, changes land via
pull/merge request, and the generator's **`--check` is a required status check**.
The CI workflow (`.github/workflows/backlog.yml`) provides the check; this recipe
turns it into an enforced gate. Branch protection is a host-repo setting, not
committed code, so it is enabled once per repo by an admin — it does not travel in
a commit the way the workflow does.

## The required-check context: `backlog`

The check you require is identified by a **stable context name**. In the Trellis
workflow that name is **`backlog`** — the job:

```yaml
# .github/workflows/backlog.yml
name: Backlog Hygiene     # ← the WORKFLOW's display name (not the check context)
jobs:
  backlog:
    name: backlog         # ← the JOB name == the required status check context
```

Require the check named **`backlog`**, not `Backlog Hygiene`. The job carries an
explicit `name: backlog` so the context is pinned: renaming the workflow's display
name cannot move it, and a rename of the job is a visible edit to this line rather
than a silent gate-disabling drift (the risk §10's stable-context requirement
guards against). If you change the job name, update the required check to match.

## GitHub

### With `gh` (scriptable)

From a clone of the repo, with the [`gh`](https://cli.github.com/) CLI
authenticated and admin on the repo. `gh` substitutes `{owner}`/`{repo}` from the
current repository; replace `main` if your default branch differs:

```bash
gh api --method PUT repos/{owner}/{repo}/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["backlog"] },
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "enforce_admins": true,
  "restrictions": null
}
JSON
```

- `required_status_checks.contexts: ["backlog"]` — the gate. `strict: true` also
  requires the branch to be up to date before merging; drop it if you don't want
  that.
- `required_pull_request_reviews` — requires changes to land via PR. Set
  `required_approving_review_count: 0` to require a PR without a mandatory
  approval, or raise it for more reviewers.
- `enforce_admins: true` — applies the rule to admins too; relax if you need an
  admin escape hatch.
- `restrictions: null` — no push allow-list. All four top-level keys must be
  present (a key may be `null`); this is the minimal conformant payload.

### In the UI

**Settings → Branches → Add branch ruleset** (or **Add rule** under the classic
"Branch protection rules"), targeting the default branch:

1. **Require a pull request before merging** (optionally require approvals).
2. **Require status checks to pass before merging** → search for and select
   **`backlog`**. Optionally enable "Require branches to be up to date."
3. Save.

> The `backlog` check only appears in the picker after the workflow has run at
> least once on the repo. Push the scaffold (or open a first PR) so the check
> registers, then add it to the rule.

## Other forges

The same two requirements — a protected default branch and a required check —
map onto every major forge. The "check" is whichever CI job runs `trellis check`
(named `backlog` here); on forges without GitHub-style named contexts, the gate is
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

Open a throwaway PR that intentionally drifts the index — e.g. edit a generated
file between its `BEGIN/END GENERATED` markers, or add an item without
regenerating — and confirm the `backlog` check fails and the merge button is
blocked until it passes. Close the PR without merging.
