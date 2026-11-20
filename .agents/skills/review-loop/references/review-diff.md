# Review prompt: a diff

Review only. Do not edit any file. Do not run any command that mutates
state: no builds that write into the tree, no package installs, no
generators, no formatters, no git commands that change the tree. Permitted:
file reads, searches, and read-only git commands (git diff, git log, git
show, git status). Do not ask questions in place of findings; decide. Do not
re-verify; verification already ran.

Adversarially review the {{TASK}} change against base commit {{BASE}}
(current HEAD {{HEAD}}) in this working tree. Read the repository's canonical
instruction file, the task file, the full diff (`git diff {{BASE}}` plus the
untracked files listed below), relevant callers and callees, and any
file-type instruction files that apply. The task intentionally remains
active until the clean review loop finishes; do not flag closeout.

{{AUTHOR_CONTEXT}}

Verification already passed on this tree:
{{VERIFIED}}

Changed-file scope (git diff --name-status against the base, then untracked):
{{CHANGED}}

{{PRIOR}}

Severity semantics: blocker = breaks the build, verification, a documented
contract or the team workflow; warning = a real defect with a bounded
failure path; nit = a definite small improvement with no failure path.

Review in two passes:
1. Contract and correctness: task completeness, architecture, data and
   control flow across seams, generated artifacts, stable tests, behaviour
   compatibility, and release: when the diff changes shipped behaviour (the
   files the package publishes, observable by a consumer) or adds entries
   under the changelog's Unreleased heading, it must either carry the
   version bump the repository's release flow needs (the manifest version
   moved, the changelog entries filed under it with the date, any status
   line naming the version updated) or say why it is not a release (the
   task, the changelog or the pull request notes). Report a finding when
   neither is true. A repository with no release flow, and a diff that
   touches only tests, internal docs, the backlog or CI, are not findings.
2. Adversarial failure modes: hostile input, authorization and tenant
   boundaries, concurrency, partial failure, retry and idempotency,
   ordering, resource limits, performance, and missing regression coverage.

Report only actionable defects introduced or exposed by this change. Do not
report style preferences, speculative concerns without a concrete failure
path, or pre-existing out-of-scope debt. For every finding cite the precise
repo-relative file and line and state the smallest safe fix.

<!-- ENDING: manual -->
End with exactly one fenced json block and nothing after it. The block
contains a single array of objects shaped as
{"file":"...","line":1,"severity":"blocker|warning|nit","suggestion":"..."}.
Use [] when clean.
<!-- END ENDING -->

<!-- ENDING: runner -->
Your final response must be the JSON object the output schema describes:
{"findings":[{"file":"...","line":1,"severity":"blocker|warning|nit","suggestion":"..."}]}
Use {"findings":[]} when clean. Nothing after it.
<!-- END ENDING -->
