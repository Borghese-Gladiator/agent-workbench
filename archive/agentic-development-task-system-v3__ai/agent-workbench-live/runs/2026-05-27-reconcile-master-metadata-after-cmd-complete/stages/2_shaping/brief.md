# Brief

## Scope reduction (2026-05-27, post-planning)

After planning, the user re-scoped this run to **Y** (read-layer fix + one-shot disk cleanup), deferring the forward-fix in `cmd_complete`, the doctor check, and the module docstrings to a future follow-up run (Z, captured in `plan.md`'s `## Deferred to follow-ups` section).

The brief below was written for the broader Z scope. For the live acceptance contract, refer to `plan.md`'s `## Definition of done`. Specifically:

- **Original A1, A5, A8 are deferred to Z** (forward-fix, doctor check, docstrings).
- **A2, A3, A4, A6, A7 still apply** in modified form: the script reconciles the four observed runs; `list` and `board` agree after a read-layer fix to `_walk_worktrees`; dry-run is default; the script never modifies an unmerged-branch run.
- The Y read-layer fix makes `list` and `board` agree even though master-side `metadata.yaml` remains stale on disk for future self-modifying completes (until Z lands).

## Goal

After `/complete` succeeds on a self-modifying run, the master-side `runs/<run_id>/metadata.yaml` must carry `status: done` plus a populated `completion` block — full stop, no exceptions, no later-merge-commit dependency. `agent-workbench list` and `agent-workbench board` must agree on every run's status. The four currently-stale runs on disk must be reconciled to `done` with their correct merge-SHA `completion_ref`. A doctor check must catch any future occurrence so this bug class can't silently re-emerge.

The fix is forward-looking *and* retroactive: forward, by changing `cmd_complete` so it deterministically writes the post-merge metadata onto master (not just into the now-removed worktree); retroactive, by shipping a one-shot reconciliation entry point that rewrites stale master-side metadata for runs whose branch is already merged into the workbench's root branch.

## User-facing behavior

Three observable changes for a workbench user:

1. **`/complete` becomes self-consistent.** Today, a self-modifying run can complete successfully (merge lands, worktree gone, branch deleted) yet `agent-workbench board` keeps showing it in `human_review`. After this change, immediately after `/complete` returns, both `agent-workbench list` and `agent-workbench board` agree the run is `done` — every time, regardless of how the worktree-side write happened to land in the branch's commit history.

2. **A reconciliation entry point exists.** Either a standalone `tools/reconcile_master_metadata.py` script or a `doctor --fix-stale-done` mode (decision left to planning). The user can run it once to clean up the four observed stale runs; the same command is dry-run by default and prints exactly what it would rewrite. `--write` (or equivalent) actually applies the change. The command never touches a run whose branch is not merged into the workbench root branch.

3. **`agent-workbench doctor` flags new occurrences.** A new doctor check surfaces any run whose master-side status is non-terminal (`human_review`, `building`, `validating`, `followups`) but whose branch is already merged into the workbench root branch. One-line warning per offending run, including the merge SHA. Doctor does not auto-fix; the user runs the reconciliation entry point to actually rewrite.

No new UI, no slash-command changes, no lifecycle-state additions.

## Acceptance criteria

- **A1.** After `/complete` succeeds on a self-modifying run, `git show <root_branch>:runs/<run_id>/metadata.yaml | grep "^status:"` reports `status: done`. Verified by a new unit test that drives `cmd_complete` end-to-end on a synthetic self-modifying workbench and inspects the post-merge tree of the workbench's root branch.

- **A2.** The new unit test would fail under today's `cmd_complete.py` (i.e., the test is genuinely catching the regression, not vacuously passing).

- **A3.** After running the reconciliation entry point against the four observed stale runs (`2026-05-25-generalize-stage-context-md`, `2026-05-26-board-freshness-across-worktrees`, `2026-05-25-each-worktree-owns-its-own-run-dir`, `2026-05-25-lifecycle-papercuts-lock-ready-banner`), each one's master-side `metadata.yaml` reports `status: done`. Each carries a `completion` block with `accepted_by`, `completion_ref` (the merge SHA, sourced from the workbench's git history), and `completed_at` (the merge commit's date).

- **A4.** After A3, `agent-workbench list` and `agent-workbench board --static --status human_review` agree on which runs are actually in `human_review`. No ghost runs from stale master-side metadata.

- **A5.** `agent-workbench doctor` (default mode, no flags) surfaces any non-terminal-but-merged run with a one-line warning per offending run, including the merge SHA. After A3 is applied, doctor is silent for the four reconciled runs.

- **A6.** Reconciliation entry point defaults to dry-run; a `--write` (or equivalent explicit flag) is required to actually rewrite. The dry-run output lists exactly the files that would be modified and the status transitions that would be applied.

- **A7.** The reconciliation entry point never modifies a run whose branch is not merged into the workbench root branch. Verified by a unit test that constructs a synthetic case with an unmerged branch and asserts no rewrite occurs.

- **A8.** `lib/runs.py`'s `_walk_worktrees` and `lib/cli/cmd_complete.py` carry module docstrings documenting the new invariant: "After `/complete` returns successfully, the master-side `runs/<run_id>/metadata.yaml` MUST carry `status: done` plus a populated `completion` block. The worktree-side copy is allowed to vanish; the master copy is the canonical archive."

## Non-goals

- **Removing the worktree-side metadata write.** `cmd_complete` keeps updating the worktree copy first. The fix ensures master ends up consistent, not that the write relocates.
- **Backfilling runs whose master copy is already correct.** ~15 prior `done` runs are fine. Scope is strictly runs where master-side disagrees with reality.
- **Reconciling abandoned-state runs.** Same shape of bug could exist for `cmd_abandon`. If it does, file as a separate TODO. Don't expand scope.
- **Refactoring `_walk_worktrees`'s "drop terminal-state worktree hits" filter.** The filter logic is intentional; the bug is upstream.
- **Cross-machine reconciliation.** If a run was `/complete`-d on machine A and machine B never saw the post-merge state, that's a sync issue, not a workbench-correctness issue.
- **Picking option (b) or (c) from the original TODO.** The brief commits to option (a): `cmd_complete` directly writes the post-merge metadata onto master after the merge succeeds. Planning may sub-detail the mechanism (extra commit on master after the merge, or amend the merge itself), but the contract is "master-side metadata.yaml is `done` immediately after `/complete` returns."
- **Changing the lifecycle state machine.** No new states, no new transitions, no schema changes to the run model.

## Good examples

**Good: a `/complete` flow that the new contract guarantees.**

```
$ agent-workbench complete 2026-06-01-some-self-mod-run
# ... merge succeeds, worktree removed, branch deleted ...
2026-06-01-some-self-mod-run: human_review -> done
$ git show master:runs/2026-06-01-some-self-mod-run/metadata.yaml | grep status
status: done
$ agent-workbench list | grep some-self-mod-run
2026-06-01-some-self-mod-run    done
$ agent-workbench board --static --status human_review | grep some-self-mod-run
# (empty — no ghost)
```

**Good: a dry-run of reconciliation against the four observed stale runs.**

```
$ agent-workbench doctor --fix-stale-done  # or: python tools/reconcile_master_metadata.py
[dry-run] would rewrite runs/2026-05-25-generalize-stage-context-md/metadata.yaml
  status: human_review -> done
  completion.completion_ref: <merge SHA from git log>
  completion.completed_at: <date from merge commit>
[dry-run] would rewrite runs/2026-05-26-board-freshness-across-worktrees/metadata.yaml
  ...
[dry-run] 4 runs would be modified. Re-run with --write to apply.
```

**Good: doctor catches a new occurrence cleanly.**

```
$ agent-workbench doctor
WARNING: 1 run has non-terminal master-side status but is already merged into <root_branch>:
  - 2026-06-03-something: status=human_review, merged at <SHA>
  Run reconciliation to fix: agent-workbench doctor --fix-stale-done
```

## Bad examples

**Bad: auto-fixing in `doctor` without an explicit flag.** Doctor reports; it does not rewrite. The user must opt into the rewrite via `--fix-stale-done` (or the standalone script). Surprise rewrites of `metadata.yaml` are out of bounds.

**Bad: rewriting metadata for an unmerged branch.** Reconciliation never touches a run whose branch is not merged into the workbench root branch. A run that is *legitimately* still in `human_review` (no merge yet) must be left alone, even if its worktree was removed for some other reason.

**Bad: skipping the unit test for the forward-looking fix.** Writing the reconciliation script alone closes the four observed runs but does not prevent regression. The forward-looking `cmd_complete` fix must come with a test that drives the full self-modifying complete flow and asserts master-side `status: done` post-merge.

**Bad: requiring the user to manually compute the merge SHA.** The reconciliation entry point sources the merge SHA from `git log` (looking for the merge commit on the workbench root branch that brought in `agent/<slug>`). The user supplies no SHAs.

**Bad: claiming the fix while leaving any of the four observed runs stale.** Acceptance requires all four to be reconciled and verified.

**Bad: reconciliation that mutates the worktree-side copy.** Worktrees for those four runs may or may not still exist. The fix targets the master-side copy only. If a worktree happens to be on disk, the run dir there is untouched.

## Constraints

- The fix lives entirely inside the workbench (`lib/cli/cmd_complete.py`, `lib/cli/cmd_doctor.py` or equivalent, possibly a new `tools/` script, and tests). No changes to the lifecycle schema, the metadata schema, or any slash command.
- The `completion` block fields written by reconciliation must match what `cmd_complete` would have written natively: `accepted_by`, `completion_ref`, `completed_at`. The reconciliation script reuses the same `metadata` writer code path as `cmd_complete` rather than crafting its own YAML.
- The merge SHA is derived deterministically from `git log` on the workbench root branch (looking for the merge commit that brought in the run's `agent/<slug>` branch). If no merge commit can be unambiguously identified, reconciliation skips that run and emits a warning. The script does not guess.
- Dry-run is the default for the reconciliation entry point. Applying the change requires an explicit flag.
- The new doctor check is purely advisory: zero side effects, exit code stays 0 even when offenders are found (or matches whatever doctor's existing convention is — planning to confirm). Doctor does not auto-fix.
- The forward-looking `cmd_complete` fix must not break the existing self-modifying merge dance. The existing test (`test_self_modifying.py::test_new_run_creates_worktree_and_clean_master` and any other self-modifying tests) keeps passing.
- The fix must not regress the case where master-side metadata is already correct — i.e., already `done` runs stay `done`, reconciliation is idempotent.

## Assumptions

- The four named stale runs (`2026-05-25-generalize-stage-context-md`, `2026-05-26-board-freshness-across-worktrees`, `2026-05-25-each-worktree-owns-its-own-run-dir`, `2026-05-25-lifecycle-papercuts-lock-ready-banner`) each have a discoverable merge commit on the workbench root branch in the form `Merge branch 'agent/<slug>'`. If any of them don't, the reconciliation entry point must report which ones it skipped and why; the user reconciles those manually.
- Option (a) from the original TODO (cmd_complete writes master-side metadata directly post-merge) is the right cut. Options (b) and (c) are not pursued in this run; the brief commits to (a).
- The `metadata` writer in `lib/metadata.py` (or wherever the completion block is written today) is reusable from outside `cmd_complete` — i.e., reconciliation can call it without duplicating YAML-serialization code. If this turns out not to be true, the planning stage will need to factor a thin helper.
- The doctor check fits into whatever doctor's existing reporting shape is. Planning confirms whether doctor today emits warnings + exit code, or just textual output.
- The workbench root branch name is discoverable from `agent-workbench.yaml` or via the same code path that `cmd_complete` uses today to identify the merge target.
- Existing module docstrings in `lib/runs.py` and `lib/cli/cmd_complete.py` are short enough that adding the invariant text is a small, low-risk edit. If they're already large or load-bearing, planning will scope the doc placement.
- A `--write` (or `--fix`, or `--apply`) flag is acceptable to the user as the "actually rewrite" gate. The exact flag name is for planning.

## Suggested QA scenarios

- **Q1.** Drive a synthetic self-modifying run from `/new-run` through `/complete`. After completion, assert `git show <root_branch>:runs/<run_id>/metadata.yaml` reports `status: done`. (Unit test, automated.)
- **Q2.** Run the reconciliation script (dry-run) in a workbench whose master has the four observed stale runs. Assert it identifies exactly those four and prints the correct merge SHAs for each. (Integration test or manual verification.)
- **Q3.** Re-run reconciliation with `--write`. Assert each of the four `metadata.yaml` files now carries `status: done` with the merge SHA's `completion_ref`. Run `agent-workbench list` and `agent-workbench board --static --status human_review`; assert they agree (the four are no longer in the `human_review` column).
- **Q4.** Run reconciliation again (idempotency). Assert no further rewrites happen and the script reports zero offenders.
- **Q5.** Construct a synthetic case with a run whose branch is not merged into the root branch. Assert reconciliation does not touch it. (Unit test.)
- **Q6.** Run `agent-workbench doctor` against the workbench after the four stale runs are reconciled. Assert doctor is silent about them. Then construct a synthetic non-terminal-but-merged run and assert doctor flags it.
- **Q7.** Inspect that `cmd_complete`'s forward-looking fix doesn't break the existing `test_self_modifying.py` suite.
- **Q8.** Spot-check that reconciliation's `completion.completed_at` matches the merge commit's author or committer date (whichever the script picks — must be consistent with how `cmd_complete` writes the field natively).
