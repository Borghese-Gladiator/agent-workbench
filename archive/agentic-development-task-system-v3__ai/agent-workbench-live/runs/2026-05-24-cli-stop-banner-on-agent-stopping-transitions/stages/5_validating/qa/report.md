# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

The full `agent-workbench-live/tests/` suite was run twice — once in the worktree (with the banner work applied), and once against the master checkout to confirm pre-existing failures. Both runs produced the same set of 2 failures (date-baked snapshot drift in `test_human_review.py`); 244 tests pass in the worktree, all 11 new unit/snapshot tests are green, and the extended E2E assertions for STOP banner presence/absence all pass.

## What ran

- `pytest tests/test_stop_banner.py` — the new unit + snapshot tests.
- `pytest tests/` — the full suite in the worktree.
- `pytest tests/test_human_review.py::TestSnapshotRender` — against the master checkout, to baseline the pre-existing failures.
- Direct Python invocation of `print_stop_banner` for each of the four states, to confirm the rendered output before baselining snapshot fixtures.

All commands are recorded in `qa/commands.txt`.

## Results

### Unit tests

- `tests/test_stop_banner.py`: **11/11 passed** in the worktree.
  - `TestPrintStopBanner.test_ready_banner_structure` — passed.
  - `TestPrintStopBanner.test_human_review_banner_structure` — passed.
  - `TestPrintStopBanner.test_done_banner_structure` — passed.
  - `TestPrintStopBanner.test_abandoned_banner_structure` — passed.
  - `TestPrintStopBanner.test_invalid_state_raises` — passed.
  - `TestPrintStopBanner.test_other_invalid_states_raise` — passed (covers `draft`, `shaping`, `building`, `validating`, `followups`, and empty string).
  - `TestPrintStopBanner.test_border_is_60_columns` — passed.
  - `TestSnapshots.test_ready_snapshot` — passed.
  - `TestSnapshots.test_human_review_snapshot` — passed.
  - `TestSnapshots.test_done_snapshot` — passed.
  - `TestSnapshots.test_abandoned_snapshot` — passed.

### Integration tests

- `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` — passed with the new positive STOP assertions after `plan`, `followups`, and `complete`, plus negative assertions after `shape`, `plan --init`, `start`, `validate --init`, and the staged `validate` finalize.
- `tests/test_e2e.py::TestE2EBounceLoop::test_bounce_loop` — passed (no new assertions, but covers the bounce → re-validate → re-followups path where the second followups call must also print the banner).
- `tests/test_e2e.py::TestE2EAbandon::test_abandon_at_shaping` — passed with the new positive STOP assertion after `abandon`.
- `tests/test_e2e.py::TestE2EAbandon::test_abandon_at_building` and `test_abandon_at_draft` — passed (regression check on the abandon banner from other source states).

### Lint / typecheck

The repo does not run a linter or typechecker as part of `tests/`. Manually:
- `python3 -m py_compile lib/cli/_stop_banner.py` — clean.
- `python3 -m py_compile lib/cli/cmd_{plan,validate,followups,complete,abandon}.py` — clean.

### Browser / Playwright

N/A — no UI surface.

### Smoke scripts

Direct interactive render of all four banners using a one-line `python3 -c` call. Confirmed by eye that each banner is bordered by a 60-col `=` rule, says `STOP. State: <state> (<header>).`, and either lists the right next-move commands or substitutes the terminal line. Output captured in `qa/artifacts/banner-render.txt`.

## Captured artifacts

- `qa/artifacts/banner-render.txt` — direct render of all four banners with a sample run_id.
- `qa/commands.txt` — the commands that ran during validate.

## Pre-existing failures (not caused by this run)

Two tests in `test_human_review.py::TestSnapshotRender` fail due to date-baked snapshots:
- `test_happy_snapshot` — expected run_id starts with `2026-05-22-`, rendered uses today's date `2026-05-24-`.
- `test_bounce_pass2_snapshot` — same root cause.

These were re-confirmed against the master checkout (zero changes applied) and produced identical failures. They are not regressions; they predate this run and are documented in the LOG as of the auto-merge-on-complete run.
