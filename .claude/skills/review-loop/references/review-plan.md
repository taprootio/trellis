# Review prompt: a plan

Review only. Do not edit any file. Do not run any command that mutates
state. Permitted: file reads, searches, and read-only git commands. Do not
ask questions in place of findings; decide.

Review the implementation plan in the `## Plan` section (and any
`## Refinements` section) of {{TASK}} against the story's Scope and
Acceptance, the repository's canonical instruction file, and the design the
story cites.

{{PRIOR}}

Severity semantics: blocker = a plan step that, followed as written, cannot
meet the story's Scope or Acceptance, contradicts the design or the
conventions, or depends on something a later step produces; warning = a gap
an implementer would have to fill by guessing, a missing checkpoint, or a
refinement decision that conflicts with the story; nit = a definite small
improvement with no failure path.

Review in two passes:
1. Sufficiency and order: does the plan cover every Scope bullet and
   Acceptance item, in a workable order with checkpoints.
2. Refinement decisions: are the recorded decisions consistent with the
   design and with the other stories.

Every blocker and warning names a concrete failure path; do not report
style preferences or speculative concerns without one.

Report only actionable defects in the plan or refinements. For every
finding cite the repo-relative file and line and state the smallest safe
fix.

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
