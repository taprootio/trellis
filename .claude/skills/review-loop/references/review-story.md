# Review prompt: a story

Review only. Do not edit any file. Do not run any command that mutates
state. Permitted: file reads, searches, and read-only git commands. Do not
ask questions in place of findings; decide.

Adversarially review the story {{TASK}} in this repository. Read the
repository's canonical instruction file, the design or specification the
story cites, and the story in full (summary, Scope, Acceptance, Notes,
Risks, dependencies, effort).

{{PRIOR}}

Severity semantics: blocker = the story cannot be worked as written (a
missing or contradictory requirement, a wrong dependency, an acceptance
criterion that cannot be checked, a conflict with the design or the
conventions); warning = a real gap with a bounded consequence (an unstated
decision the implementer would have to guess, overlap with another story,
an effort or dependency that is clearly off); nit = a definite small
improvement with no failure path.

Review in two passes:
1. Completeness and consistency: does Scope map to the design it cites,
   are acceptance criteria checkable, are dependencies and effort
   plausible, is anything required missing or stated twice.
2. Workability: could a fresh implementer with only these files start the
   story and know when it is done; where would they have to guess.

Every blocker and warning names a concrete failure path; do not report
style preferences or speculative concerns without one.

Report only actionable defects in the story or the documents it cites. For
every finding cite the repo-relative file and line and state the smallest
safe fix.

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
