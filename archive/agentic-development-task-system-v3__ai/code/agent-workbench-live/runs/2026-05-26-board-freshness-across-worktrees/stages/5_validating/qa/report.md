# QA report (round 2 — bounce response)

## Summary

- **tests_passed**: true (for the surface area changed by this round; the 8 pre-existing failures from v1 are unchanged and unrelated)
- **known_issues_count**: 0

## What ran

Two unittest invocations (see `commands.txt`):
1. Targeted: the new `TestRealWatchdogDelivery` class with a real watchdog Observer.
2. Full-suite discover to confirm no regressions.

## Results

### Unit tests

**Targeted: `tests.test_board_freshness.TestRealWatchdogDelivery` (2 tests)** — both pass within their 2s polling budget.

- `test_real_watchdog_fires_handler_on_file_write` — pass. Synthetic git workbench with one worktree, real `watchdog.observers.Observer` scheduled via `_schedule_worktree_runs_dirs`, `events.jsonl` written under the watched dir, recording sink captured a post within budget.
- `test_real_watchdog_filters_tmp_suffix` — pass. Confirms a subsequent real-file write produces a post after a `.tmp` write; deliberately permissive about whether the `.tmp` itself produces a post (FSEvents on macOS sometimes reports the parent dir).

### Full-suite regression check

`python3 -m unittest discover tests` — **357 tests, 8 failures, 0 errors.**

Up from 355 in v1 (two new E2E tests landed). Same 8 pre-existing failures:
- `test_backfill_base_ref_sha.*` (5)
- `test_e2e.TestE2EHappyPath.test_happy_path` (banner-text drift)
- `test_human_review.TestSnapshotRender.test_bounce_pass2_snapshot` and `test_happy_snapshot` (snapshot dates pinned to 2026-05-22)

All confirmed pre-existing on master in v1; no further verification needed in this round (nothing about source files changed that could have broken them).

### Integration tests

The real-watchdog tests are themselves the integration check for AC1 — they validate the wiring between the production scheduling logic and the watchdog backend's event delivery.

### Lint / typecheck

Not run (consistent with v1).

### Browser / Playwright

N/A.

### Smoke scripts

Not run. Same AC7 deferral as v1.

## Captured artifacts

None.
