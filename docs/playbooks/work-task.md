# Playbook: work a task

A ready-to-use shortcut for taking a Trellis task from `docs/tasks/active/` all
the way to "ready for your review." Invoke it with a task id (e.g. `TRL0007`).
Point any AI assistant at this file; it graduates to an MCP prompt under TRL0006.

The loop is fixed — do not improvise the order. There are exactly **two**
intentional pauses (steps 4 and 5); everything after the confirmed plan runs
without further check-ins. No file edits happen until you are on the task branch,
so `main` stays clean.

## The loop

1. **Ground in the repo's conventions.** Read AGENTS.md (canonical) and the
   SPEC / docs relevant to what the task will touch. The *what* and *how* of this
   repo live there; this playbook is only the orchestration.
2. **Read the task.** Open `docs/tasks/active/<ID>.md` in full — front-matter
   (milestone, priority, effort, depends_on) and body (Scope, Notes, Risks). If
   it isn't in `active/`, stop and say where it actually is. Confirm every
   `depends_on` id is completed; surface any that aren't.
3. **Verify it against the codebase.** Check the task hasn't drifted: do its
   assumptions still hold, do referenced files/APIs still exist, is it still the
   right thing to build and still workable? Note anything stale.
4. **Propose refinements, then PAUSE.** Surface ambiguities, gaps, drift, and
   concrete suggestions that would make the task clearer or more workable — then
   **wait for the user's answers.**
5. **Plan, with checkpoints, then PAUSE.** Using the agreed refinements, lay out
   the implementation as ordered steps and call out the natural **commit
   checkpoints**. **Confirm the plan with the user** before touching anything.
6. **Start clean, then branch.** Confirm the working tree is clean and `main` is
   current (`git fetch`, fast-forward `main`); if not, stop and surface it. Create
   `je/<id-lowercase>/<slug>` from local `main` (e.g. `je/trl0007/portable-loop`)
   — from local `main`, not `origin/main`, so the upstream isn't mis-set.
   Everything from here lands on the branch, never on `main`.
7. **Rewrite the task on the branch.** Fold the user's refinements into
   `docs/tasks/active/<ID>.md` (Scope / Notes / Risks), run
   `npm run backlog:readme`, and commit it as the first checkpoint. This refined
   file is the source of truth for the rest of the loop.
8. **Work the task end-to-end.** Implement against the refined Scope, committing
   at the checkpoints from step 5 and keeping the repo's gates green (`npm run backlog:check` plus its tests/lint). When
   the work lands, close the task out: move it to `completed/tasks/`, set
   `status: completed` + `completed_on`, regenerate (SPEC §4–§5).
9. **Request a review.** Run `docs/playbooks/code-review.md` over the branch and
   capture its canonical JSON findings. Make it an **independent** pass — ideally a
   separate agent or session, or at minimum re-ground from scratch — since author
   self-review tends to rubber-stamp.
10. **Fix the findings.** Resolve every `blocker` and `warning` (and `nit`s unless
    waived); re-run the review until the array is `[]` or only waived items
    remain. Keep the gates green.
11. **Hand off for review.** Tell the user it's ready: the branch name, what
    shipped, the review outcome, and the push + PR commands (PR body via
    `docs/playbooks/pr-draft.md`). Do **not** push or merge — that's the user's.

## Notes

- The two pauses are the contract: refinement sign-off (step 4) and plan
  confirmation (step 5). Both happen before any branch or file edit. If you hit a
  genuine blocker mid-loop, stop and surface it — otherwise keep going.
- Because branching (step 6) precedes every edit (steps 7–8), the clean-tree
  requirement always holds and `main` is never dirtied.
- Branch protection means work never lands on `main` directly; it always goes
  through a PR with the required backlog check.
- Commits and PRs carry **no AI/co-author attribution** — never add
  `Co-Authored-By:` trailers or "Generated with …" footers (see AGENTS.md).
