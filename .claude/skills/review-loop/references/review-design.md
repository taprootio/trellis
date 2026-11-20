# Review prompt: a design

Review only. Do not edit any file. Do not run any command that mutates
state. Permitted: file reads, searches, and read-only git commands. Do not
ask questions in place of findings; decide.

Assess the design behind {{TASK}} against the task's contracts, the
repository's architecture and conventions, and the design documents the
task cites{{BASE_CLAUSE}}. This review runs because the patch loop is not
converging or the same area keeps producing defects: trace why the repeated
findings occur and whether the design, not the patches, is the cause.

{{PRIOR}}

Severity semantics: blocker = the design cannot meet a contract or
convention and patching will not fix it; warning = a design choice with a
bounded failure path or a cost the task does not acknowledge; nit = a
definite small improvement with no failure path.

Report only actionable defects in the design behind {{TASK}} and its cited
contracts; do not expand into pre-existing or unrelated code. Cite precise
references to the refinement notes, the plan or the implementation, and
propose concrete changes to the design. Do not report style preferences or
speculative concerns without a concrete failure path.

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
