# Human review — 2026-05-21-better-worktree-name-template

This run advances TODO §1: worktree directory basenames now carry a
`<YYYYMMDD>__` prefix derived from the run_id. One helper, one signature
widening, one caller updated, one config doc-fix, one new test assertion.

## Where to start

- Want to see diffs? → `stages/building/build.md`
- Want to verify QA? → `stages/validating/qa/report.md`
- Want to confirm each AC is tested? → `stages/building/build.md` § Acceptance criteria coverage
- Want to argue with decisions? → `stages/planning/plan.md` § Decisions & assumptions, then `stages/validating/review.md` § Blast radius
- Want to see what's next? → `stages/followups/follow-ups.md`

## Suggested first checks

```bash
# Inside the worktree at:
#   agent-workbench-live/worktrees/agentic-development-task-system-v2-ai/better-worktree-name-template
cd agentic-development-task-system-v2__ai/agent-workbench-live
python3 -m unittest discover -s tests
python3 bin/agent-workbench doctor
```

1. Confirm 93/93 tests pass; the new assertion in `test_full_lifecycle`
   verifies the YYYYMMDD prefix end-to-end.
2. `agent-workbench doctor` should report PASS.
3. Sanity: create a quick throwaway run via `agent-workbench new-run
   --repo-path <some-repo> --base-ref main --idea-file <path>` (in a
   throwaway workbench root), then `start` it. The created worktree's
   basename should match `^\d{8}__`.

If steps 1–3 pass, the run is delivered.

## Run timeline

- 02:46 — RunCreated; staged layout initialised; raw-idea.md at run root.
- 02:47 — draft → shaping; brief.md template staged; raw-idea.md moved to stages/draft/.
- 02:47 — shaping → planning; brief.md moved to stages/shaping/.
- 02:48 — plan.md template staged (single merged file: Plan + Preflight + Decisions & assumptions).
- 02:48 — planning → ready; AssumptionRecorded (ASM-001), DecisionRecorded (DR-001, DR-002), PreflightCompleted.
- 02:48 — ready → building; WorktreeCreated at `worktrees/.../better-worktree-name-template`.
  (NOTE: this run's own worktree path does NOT have the date prefix —
  that's because the prefix was implemented *during* this run. AC-4
  preservation in action.)
- ~02:50 — implementation work in the worktree; committed on `agent/better-worktree-name-template`.
- 02:51 — building → validating; §1e build defaults filled (iterations=1, exit_reason=tests_green); build.md moved to stages/building/.
- (next) — validating → followups; §1d doc-claim check + §1g scope-creep check run.
