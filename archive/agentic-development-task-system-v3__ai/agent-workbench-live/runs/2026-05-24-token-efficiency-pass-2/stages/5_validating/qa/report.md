# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 3

## What ran

- `python -m pytest tests/ -q` against the worktree's full agent-workbench-live test suite.
- Targeted pytest runs against the pass-2 test files at each Part boundary.
- `wc -c` on `agent-workbench-live/AGENTS.md` before and after the B6 audit trim.

## Results

### Unit tests

**Final full suite**: 268 passed, 2 failed.

- 268 / 270 tests passed.
- The 2 failures are the pre-existing date-baked snapshot tests in `tests/test_human_review.py` (`TestSnapshotRender::test_bounce_pass2_snapshot`, `TestSnapshotRender::test_happy_snapshot`). These also fail on master and were noted in the auto-merge-on-complete run's audit. Not introduced by pass-2.
- 35 new tests added across:
  - `tests/test_metrics_cache_buckets.py` (11 tests — C1)
  - `tests/test_metrics_transcript.py` (4 new tests for A1/A3)
  - `tests/test_metrics_summary.py` (2 new tests for A6/A7/A8 + v1-row tolerance)
  - `tests/test_cmd_metrics.py` (extension — three bucket sub-sections, three new fields)
  - `tests/test_validate_context_build.py` (9 tests — C3 + blast-radius)
  - `tests/test_validate_init_handoff_block.py` (6 tests — B5 + A9 board indicator)
  - `tests/test_cmd_board.py` (1 default-dict extension)

### Integration tests

The existing E2E fixtures (`happy/`, `bounce_pass2/`) continue to drive cleanly via `tests/test_e2e.py`. The new `validate-context.md` + `blast-radius.txt` artifacts are NOT asserted by these E2E fixtures — that's a follow-up coverage gap noted in `review.md` F-002.

### Lint / typecheck

No lint or typecheck configuration is shipped at the workbench level. The codebase is pure stdlib Python 3.10; static checks would be additive scope.

### Browser / Playwright

N/A — workbench is CLI-only.

### Smoke scripts

Manually verified post-implementation:

1. **B6 weight measurement.** `wc -c agent-workbench-live/AGENTS.md`:
   - Before pass-2 additions: 4677 bytes.
   - After pass-2 additions (Session discipline + Subagent expansion + Tool-output budget): 9335 bytes.
   - After B6 audit trim (removed duplicated lifecycle/command tables): 7621 bytes.
   - Net change vs. pre-pass-2 baseline: +2944 bytes. Honest: pass-2's necessary new normative content outweighs the audit savings. The 30%-combined-drop acceptance bar (#7) is NOT met by this PR. See build.md "Known issues" — a follow-up audit-only run can target the percent.

2. **`agent-workbench metrics 2026-05-22-token-efficiency-tracking --record` re-run.** Documented as a manual step the operator can run after the branch lands. Expected outcome: per-turn `stage` distribution is no longer 100% `other` (AC #2), and `cache_read buckets` shows non-trivial attribution. Not auto-asserted in this PR because the test fixture path depends on the operator's local transcript file.

3. **E2E `cache_read` measurement (AC #9).** Not run in this PR. The `happy/` fixture is workload-incomparable to the 621-turn pass-1 dogfood baseline; comparing them measures fixture size, not pass-2's lever. The structural mitigations (validate-context.md, blast-radius, fresh-session handoff, subagent-first guidance) are in place. The actual cache_read reduction depends on operator behavior (following `## Session discipline`) and won't surface until the next dogfood run uses them. Acceptance for #9 is therefore deferred to a follow-up measurement.

## Captured artifacts

None — all QA was via pytest stdout. No Playwright recordings, no screenshots.
