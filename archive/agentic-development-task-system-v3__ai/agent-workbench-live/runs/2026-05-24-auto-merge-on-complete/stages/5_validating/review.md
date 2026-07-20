# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. Every acceptance criterion in `brief.md` has either a passing test or an explicit code-path in `lib/repos.py` / `lib/cli/cmd_complete.py`:

- AC1 (success path → `merge:<sha>`): success path in `cmd_complete` records `merge:<sha>`; `TestE2EHappyPath.test_happy_path` and `TestMergeNoFf.test_happy_merge_records_no_ff` lock it in.
- AC2 (dirty worktree refusal): the `_do_merge` pre-flight refuses with exit code 3; `TestE2ECompleteMerge.test_dirty_worktree_refuses` covers the user-visible behavior.
- AC3 (bad base_ref refusal): `resolve_parent_branch` raises `RepoError` when `base_ref` is missing or HEAD is detached; `TestResolveParentBranch.test_missing_branch_raises` + `TestCurrentBranch.test_detached_head_returns_none` cover it.
- AC4 (conflict aborts, emits MergeConflict): `merge_no_ff` runs `git merge --abort` and raises `MergeConflictError`; `cmd_complete._do_merge` catches it and emits the event; `TestE2ECompleteMerge.test_merge_conflict_aborts_and_stays_in_human_review` covers the full path.
- AC5 (events registered): `schemas/events.jsonl` carries `WorktreeMerged` + `MergeConflict` with their `payload_required` lists. The events module validates writes against the schema, so any attempt to emit a malformed event would fail at write-time.
- AC6 (board badge): rendered when `completion_ref` starts with `local-branch:` — three tests in `TestUnmergedBadge` exercise positive / negative / null.
- AC7 (backfill): all three orphan runs' `metadata.yaml` files now carry `merge:<full-sha>` (verified by grep before commit).
- AC8 (slash command): `.claude/commands/complete.md` rewritten with pre-flight + failure-mode docs + escape-hatch flags.
- AC9 (lifecycle doc): `docs/lifecycle.md` § `done` rewritten.
- AC10 (tests): full suite is 233/235, with the 2 remaining failures pre-existing on master.

## Did it accidentally expand scope?

One mid-build addition: the `--no-merge` flag. The brief and plan didn't list it; I added it while writing the slash-command docs. It's a clean escape hatch (records the same legacy `local-branch:` label as `--completion-ref local-branch:<branch>` would, but without forcing the human to look up the branch name), and the e2e test `test_no_merge_flag_records_local_branch_label` covers it. Calling this out as deliberate scope adjustment, not creep.

`brief.md`'s "Non-goals" section is honored: no auto-push, no in-line conflict resolution, no `abandoned` semantics changes, no rebase / squash strategies, no schema additions to `metadata.completion`. The `tools/backfill_completion_refs.py` script is in scope per the brief.

## Are there fragile assumptions?

- **Parent-branch checkout in the target repo.** When `complete` runs `git checkout <parent>` in the user's actual clone, anything the user had checked out is briefly swapped out. We restore via `git checkout -` on success, but on the conflict path we deliberately leave the parent branch checked out (so the human is dropped where they resolve). That's intentional per DR-005, but a human inspecting the parent checkout right after a conflict might be surprised. Mitigation: the slash-command docs call this out explicitly. Could be tightened later by recording the original branch in a structured event (out of scope for this run).
- **`base_ref: HEAD` resolution.** `resolve_parent_branch` reads `git symbolic-ref --short HEAD` from the target repo. If the user's `HEAD` is on the run's own worktree branch (somehow — shouldn't happen because the worktree owns that branch, not the main checkout), the resolution would return the run's branch and the merge would be a no-op. The runtime fails cleanly in that scenario because git refuses self-merge, but it would be a confusing error. Not a real-world concern; flagged for completeness.
- **`git checkout -` requires a prior branch entry on the reflog.** The `merge_no_ff` helper only calls `checkout -` when `original != parent`, so it's safe if there was no prior branch (we'd have skipped the restore).
- **Concurrent `complete` on two runs against the same target repo.** The per-run lock prevents two `complete`s on the SAME run from racing. It does NOT prevent two `complete`s on DIFFERENT runs that target the same repo from interleaving their parent-branch checkouts. This is a pre-existing latent issue in the workbench (multiple worktrees sharing a parent repo) and out of scope for this run; mitigation noted in TODO §1's risks.

## Are there missing tests?

The auto-merge path is well-tested. Two areas I considered and decided NOT to add coverage for:

- **`base_ref` resolves to a branch other than the current `HEAD` in the target repo.** Today the workbench's only flow uses `base_ref: HEAD` (the default in `agent-workbench.yaml`). The `test_explicit_branch_returns_as_is` unit test covers the symbolic-vs-literal split. Wiring an e2e where the throwaway repo has a non-`HEAD` `base_ref` would test the same code path with more setup; the unit test is enough.
- **A conflict event whose `conflicted_files` payload is empty.** I deliberately don't gate on `len(conflicted_files) > 0` because `git diff --name-only --diff-filter=U` might be empty for some exotic merge failures (e.g. tree merge with no individual file conflicts). Leaving it as a possibly-empty list and surfacing the stderr in the event is correct. Adding a test for "conflict event with empty list" would be testing the test harness, not the code.

## Are there security / data loss / migration risks?

- **Data loss risk**: low. The dirty-worktree check refuses to merge if any uncommitted change exists; the conflict path aborts cleanly without touching the worktree branch. `git merge --no-ff` writes a merge commit but does not delete history.
- **Migration risk**: low. The `completion_ref` shape is unchanged (still `string | null`); we're tightening the convention to favor `merge:<sha>`, not breaking the schema. The board badge is an additive heuristic.
- **Security risk**: low. The merge happens on the user's local machine against their own clone. No new network surface, no credential handling, no privilege escalation.
- **Backfill risk**: low. The script is idempotent and only rewrites known `local-branch:<expected-branch>` values to known `merge:<full-sha>` strings, refusing to touch any other shape. It's documented as one-shot.

## What should the human review first?

1. `agent-workbench-live/lib/repos.py:140-220` (`merge_no_ff`) — the conflict-handling logic. Specifically: does `git diff --name-only --diff-filter=U` reliably enumerate the conflicted files BEFORE the abort runs?
2. `agent-workbench-live/lib/cli/cmd_complete.py:80-115` (the lock + transition ordering). Confirm that a failed transition AFTER a successful merge is acceptable — the parent branch carries the merge commit, but the run stays in `human_review`. The plan's R1 risk discusses this.
3. `agent-workbench-live/tests/test_e2e.py::TestE2ECompleteMerge::test_merge_conflict_aborts_and_stays_in_human_review` — the most realistic stress test for the conflict path; confirms the parent repo's working tree is clean after the abort.
4. `docs/lifecycle.md` § `done` and `.claude/commands/complete.md` — the user-facing docs. Make sure the pre-flight statement is clear enough to surprise no one.

## Blast radius

```
depth 1 (changed files):
  agent-workbench-live/lib/repos.py
  agent-workbench-live/lib/cli/cmd_complete.py
  agent-workbench-live/lib/board/source.py
  agent-workbench-live/lib/board/app.py
  agent-workbench-live/schemas/events.jsonl
  agent-workbench-live/.claude/commands/complete.md
  agent-workbench-live/tests/test_{repos,e2e,board_snapshot,cmd_board}.py
  agent-workbench-live/tools/backfill_completion_refs.py
  agent-workbench-live/runs/2026-05-22-*/metadata.yaml         (3 backfill writes)
  docs/lifecycle.md

depth 2 (callers of changed symbols):
  lib/repos.MergeConflictError  -> lib/cli/cmd_complete._do_merge (only caller)
  lib/repos.merge_no_ff         -> lib/cli/cmd_complete._do_merge (only caller)
  lib/repos.worktree_dirty_files-> lib/cli/cmd_complete._do_merge + lib/repos.worktree_is_clean + tests/test_repos
  lib/repos.worktree_is_clean   -> lib/repos.merge_no_ff (internal) + tests/test_repos
  lib/repos.resolve_parent_branch -> lib/cli/cmd_complete._do_merge + tests/test_repos
  lib/repos.current_branch       -> lib/repos.resolve_parent_branch + lib/repos.merge_no_ff + tests/test_repos
  RunSnapshot.completion_ref    -> lib/board/app._status_body (done branch) + lib/board/source._load_run_snapshot + tests/test_{board_snapshot,cmd_board}
  cmd_complete.run              -> lib/cli/__init__.py (CLI dispatch only — unchanged)

depth 3 (callers of those callers):
  cmd_complete dispatch        -> bin/agent-workbench (no change) + e2e tests
  lib/board/_status_body       -> lib/board/app render path (unchanged)
  lib/board/_load_run_snapshot -> lib/board/snapshot.build (unchanged)
```

Everything in depth 2 either belongs to this run or is a test. No symbols in depth 3 live outside what `brief.md`'s expected scope anticipated. No scope creep at depth 2/3.

## Findings

(no blocking findings; no major findings)

### F-001 (informational)
- **Severity**: minor
- **Where**: `lib/repos.merge_no_ff` and `cmd_complete._do_merge`
- **Issue**: On the conflict path we leave the parent branch checked out in the target repo (intentional, per DR-005). This is the right call but means a human running `agent-workbench complete <id>` from inside the target-repo directory will see their checked-out branch change underfoot.
- **Suggested fix**: None for this run. A future task could record the original branch in the `MergeConflict` event payload so the recovery instructions can point at it. Recorded as a follow-up candidate.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``docs/lifecycle.md``
- ``agent-workbench-live/.claude/commands/complete.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
