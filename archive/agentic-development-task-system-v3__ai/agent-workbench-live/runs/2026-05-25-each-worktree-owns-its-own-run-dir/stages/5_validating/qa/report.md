# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

The test suite reports 2 failures (`test_human_review.TestSnapshotRender::test_happy_snapshot` and `::test_bounce_pass2_snapshot`); both are pre-existing date-baked snapshot mismatches present on master before this change (verified by running the same tests against master pre-change). Not caused by this run.

## What ran

- `python -m unittest discover -s tests` (full suite, 298 tests)
- `python -m unittest tests.test_runs -v` (9 tests, new in this run)
- `python -m unittest tests.test_self_modifying -v` (1 test, new in this run)
- `bin/agent-workbench doctor` from inside the worktree (expected: zero orphans)
- `bin/agent-workbench --root <master> doctor` against master (expected: only pre-A1 in-flight orphans from other agents' concurrent work)
- `bin/agent-workbench show 2026-05-25-each-worktree-owns-its-own-run-dir` (sanity check)
- `git -C <master> status --porcelain agentic-development-task-system-v3__ai/agent-workbench-live/runs/` after migration

## Results

### Unit tests

- **All tests run**: 298
- **Pass**: 296
- **Fail**: 2 (pre-existing, date-baked snapshot tests — see Summary above)
- **New tests (this run)**:
  - `tests/test_runs.py`: 9 / 9 passed
  - `tests/test_self_modifying.py`: 1 / 1 passed
- **Existing test regressions**: 0
- **Full log**: `qa/artifacts/full-suite.log`

### Integration tests

The repo has no separate integration-test marker. The E2E tests in `tests/test_e2e.py` are part of the standard suite above; they exercise the full lifecycle through subprocess CLI calls.

### Lint / typecheck

The repo has no separate lint/typecheck command (stdlib-only, no pyproject or mypy config). Skipped.

### Browser / Playwright

N/A — pure-Python CLI.

### Smoke scripts

Manual CLI smokes performed:

- `bin/agent-workbench doctor` from the worktree → `orphans: ok no orphans` and `doctor: PASS`.
- `bin/agent-workbench --root <master> doctor` from the worktree → reports 3 orphan run dirs in master's `runs/`: `2026-05-18-poker` (human_review), `2026-05-25-shengji-browser-game` (ready), `2026-05-25-structured-human-review-handoff` (human_review). These are pre-existing orphans from other concurrent agent runs, NOT caused by this change. The doctor correctly identifies them and reports `doctor: PASS` (warnings only).
- `bin/agent-workbench show 2026-05-25-each-worktree-owns-its-own-run-dir` resolves the run dir to the worktree-side path `…/LOCAL_worktrees/…/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir`, confirming `metadata.run_dir`'s new resolver works end-to-end.
- `git status --porcelain agentic-development-task-system-v3__ai/agent-workbench-live/runs/` on master → shows only the two OTHER in-flight orphans (`shengji-browser-game`, `structured-human-review-handoff`), confirming THIS run's dir has been cleanly moved into its worktree (AC1).

## Captured artifacts

- `qa/artifacts/full-suite.log` — full output of `python -m unittest discover -s tests`.

## Known issues

None caused by this run. The 2 pre-existing snapshot failures are date-baked into the fixture files (`tests/fixtures/human_review/human_review_happy.expected.md` etc.) and have been failing since 2026-05-22; they are documented as accepted in the LOG.md history and the brief's QA-8.
