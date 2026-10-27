# QA report

## Summary

- **tests_passed**: true (for changes introduced by this run; 7 pre-existing unrelated failures persist)
- **known_issues_count**: 0 (for this run's scope; 7 pre-existing test failures recorded but not in scope)

## What ran

1. **Focused unit tests** — `test_runs.py` (17 cases including 3 new) + `test_reconcile_master_metadata.py` (5 new cases).
2. **Full test suite** — entire `tests/` directory to verify no regressions outside the focused area.
3. **Live reconciliation script** — dry-run, `--write`, then dry-run again (idempotency check).
4. **Live `list` / `board` agreement spot-check** — invoked the master CLI and compared human_review enumerations.

## Results

### Unit tests

- **22 passed.** Focused run: `tests/test_runs.py` (17 passed, including 3 new in `TestWalkWorktreesStaleMasterCarveOut`) + `tests/test_reconcile_master_metadata.py` (5 passed in `TestReconcileMasterMetadata`).
- The 3 new tests in `TestWalkWorktreesStaleMasterCarveOut` cover all three branches of the new conditional in `_walk_worktrees`: stale-master carve-out (worktree wins), master-agrees (skip), and master-missing (skip).
- The 5 new tests in `TestReconcileMasterMetadata` use a synthetic git repo with a real merge commit so file-path discovery has a target.

### Integration tests

- **Full suite: 396 passed, 7 failed.** All 7 failures are pre-existing (verified during build phase by stashing all changes and re-running the failing tests against the pristine tree — same 7 failures appeared).
- Failed (all pre-existing, unrelated to this run):
  - `tests/test_backfill_base_ref_sha.py` × 5: `test_dry_run_reports_change_but_writes_nothing`, `test_missing_source_repo_skipped_not_failed`, `test_orphan_branch_uses_root_commit`, `test_second_run_is_noop`, `test_write_populates_sha_and_summarizes`.
  - `tests/test_human_review.py` × 2: `TestSnapshotRender::test_bounce_pass2_snapshot`, `TestSnapshotRender::test_happy_snapshot`.

### Lint / typecheck

- **Not run.** No lint or typecheck step exists for this workbench (Python codebase, no `mypy` or `ruff` config wired into the test harness). The existing codebase convention is to rely on test coverage + reviewer reading.

### Browser / Playwright

- **N/A.** Pure backend Python; no frontend.

### Smoke scripts

- **Reconciliation script smoke run** (against the live workbench, inside the run's worktree):
  - Dry-run: identified 4 runs, 4 correct merge SHAs, 0 warnings, 0 skipped. Output: `would-apply: 4, already-terminal: 0, skipped: 0, warned: 0`.
  - `--write`: rewrote 4 master-side `metadata.yaml` files in the worktree's checkout (staged for merge at `/complete` time). Output: `applied: 4, already-terminal: 0, skipped: 0, warned: 0`.
  - Re-run dry-run: confirmed idempotency. Output: `would-apply: 0, already-terminal: 4, skipped: 0, warned: 0`.
- **Live `list` and `board` agreement check:**
  - `agent-workbench list | grep human_review` → 5 rows (3 unrelated stale runs + 2 of our 4 awaiting `/complete` merge).
  - `agent-workbench board --static --status human_review` → same 5 rows.
  - **No disagreement between enumerators.** The 2 reconciled runs whose original worktrees are still alive (`generalize-stage-context-md`, `board-freshness-across-worktrees`) now show `done` in BOTH list and board, no longer ghost-appearing in `human_review`.

## Captured artifacts

None. No screenshots, recordings, or traces — the verification is text-based output captured inline in this report and in `qa/commands.txt`.
