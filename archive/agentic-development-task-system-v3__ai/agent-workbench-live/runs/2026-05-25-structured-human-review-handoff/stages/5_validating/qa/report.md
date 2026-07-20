# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- The whole `agent-workbench-live/tests/` test suite via `python -m pytest`, run against the worktree's checkout (which has the new code).
- Targeted re-runs of the new test files (`test_stop_banner.py`, `test_stop_banner_human_review_body.py`) and the E2E suite (`test_e2e.py`) during incremental development to catch regressions early.

## Results

### Unit tests

Final run after re-baselining the snapshot and threading `cfg=cfg` through both call sites:

```
311 passed, 2 failed
```

The two failures are pre-existing, **not** caused by this change:

- `tests/test_human_review.py::TestSnapshotRender::test_happy_snapshot`
- `tests/test_human_review.py::TestSnapshotRender::test_bounce_pass2_snapshot`

Both fail because the snapshot file at `tests/snapshots/human_review_happy.expected.md` bakes in the literal run_id `2026-05-22-happy-snap`, but the test generates a run_id from today's date (`2026-05-25-happy-snap`). Verified against master before any code changes — the failures predate this work and are present on every branch built from master after 2026-05-22.

New tests added by this change (33 total, all passing):

- `tests/test_stop_banner.py` updated cases:
  - `test_human_review_banner_structure` (now asserts slash-form `/complete <id>` / `/bounce <id>` / `/abandon <id>` and explicitly asserts the absence of the shell-form `agent-workbench complete` etc.)
- `tests/test_stop_banner_human_review_body.py` new (24 cases across 5 classes):
  - `TestSummaryBullets` (6): 2-bullet exact / 5-bullet truncate-with-tail / 0-bullet none-recorded / missing-HUMAN_REVIEW.md / nested-rows-ignored / 100-column truncation + `_truncate_inline` unit cases.
  - `TestTestingLine` (6): no-QA-event none-recorded / passed+no-issues+no-manual one-sentence / failed+manual two-sentence / passed+known-issues count form / passed+placeholder ignored / passed+no-QA-report one-sentence / `tests_passed=None` synthetic.
  - `TestDiffstat` (5): no-worktree unavailable / unresolvable-symbolic unavailable / resolvable-empty zero-files / real-diff target format / lazy-resolve-when-sha-missing.
  - `TestFullBanner` (4): section ordering / 5-bullet truncation in context / no-QA-event banner-level / no-ANSI-escapes.
  - `TestNoConfigFallback` (1): minimal three-line fallback.
- `tests/test_e2e.py` updated cases:
  - `TestE2EHappyPath::test_happy_path` (assert five sections in order, slash-form present, shell-form absent, on the `followups -> human_review` landing).
  - `TestE2EBounceLoop::test_bounce_loop` (same assertions on the second `followups -> human_review` landing).

### Integration tests

Same suite — pytest covers both unit and the E2E `TestE2EHappyPath` / `TestE2EBounceLoop` / `TestE2EAbandon` / `TestE2ECompleteMerge` classes. All E2E classes pass.

### Lint / typecheck

Not run. This repo's `agent-workbench-live` Python tree is stdlib-only and the project has no lint/typecheck CI configured for it. Test-suite passing is the equivalent gate.

### Browser / Playwright

Not applicable. The change is CLI stdout formatting; no browser surface.

### Smoke scripts

Not run as a separate pass. The TestFullBanner cases (`test_stop_banner_human_review_body.py:TestFullBanner`) function as a smoke test for the integrated banner: they construct a synthetic workbench, run the full `print_stop_banner("human_review", run_id, cfg=cfg)` call, capture stdout, and assert the five sections appear in order with the right shape. The E2E cases do the same against fixture-driven real runs.

## Manual testing

_None recorded._

The change is exercised entirely by automated tests. A dogfood run against the workbench itself isn't possible in the same session because the CLI invoked by `agent-workbench validate` reads code from master (`AGENT_WORKBENCH_ROOT` resolves to the master checkout), not from the worktree — the new banner code only lives on the worktree branch until merge. This is the same chicken-and-egg constraint described in `docs/LOG.md` § 2026-05-24 entries for the auto-merge-on-complete and stop-banner runs.

## Captured artifacts

None — the test outputs are captured by pytest's assertion failures and the suite's own snapshot files. No screenshots, recordings, or traces.
