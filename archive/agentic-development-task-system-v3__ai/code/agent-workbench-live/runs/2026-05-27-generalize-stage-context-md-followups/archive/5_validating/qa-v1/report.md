# QA report

## Summary

Full workbench test suite ran from the worktree's `agent-workbench-live/` directory. 443/450 tests pass; the 7 failures are exactly the pre-existing failures documented in `build.md` § Known issues (5 x `test_backfill_base_ref_sha` PYTHONPATH issue + 2 x `test_human_review.TestSnapshotRender` date-sensitive snapshots). No regressions introduced by this run's changes. The focused subset of new tests (`tests.test_shape_context`, `tests.test_plan_context`, `tests.test_followups_context`) passes 55/55 in 0.578s.

- **tests_passed**: 443 / 450 (98.4%)
- **known_issues_count**: 7 (all pre-existing on master; none regressions)

## Tests run

| Command | Tests | Pass | Fail |
|---|---|---|---|
| `python -m unittest tests.test_shape_context tests.test_plan_context tests.test_followups_context -v` | 55 | 55 | 0 |
| `python -m unittest discover tests -v` | 450 | 443 | 7 (all pre-existing) |
| `python -m unittest tests.test_backfill_base_ref_sha -v` | 5 | 0 | 5 (PYTHONPATH; all pre-existing) |

## What ran

- Focused subset for the new generators: confirmed 55/55 pass and the new builders emit the expected sections.
- Full discover-and-run suite: confirmed the failure set is exactly the 7 documented in `build.md`, no other test is destabilized by the changes.

## Results

### Unit tests

- `tests.test_shape_context` - 13/13 pass.
- `tests.test_plan_context` - 23/23 pass.
- `tests.test_followups_context` - 19/19 pass.
- `tests.test_build_context`, `tests.test_validate_context_build` - pass (unchanged behavior; adjacent modules sanity-checked).
- `tests.test_lifecycle`, `tests.test_e2e`, `tests.test_self_modifying`, `tests.test_human_review` (except 2 snapshot tests), `tests.test_metadata`, `tests.test_transitions`, `tests.test_events`, `tests.test_followups`, `tests.test_validate`, `tests.test_workbench` - all pass.

### Integration tests

- `tests.test_e2e` / `tests.test_self_modifying` - pass. Confirms the new `--init` write sites do not break end-to-end lifecycle behavior.

### Lint / typecheck

Not run (project does not gate on lint in test discovery; the Python code is type-hinted but not mypy-checked in this run's scope).

### Browser / Playwright

N/A. CLI-only changes.

### Smoke scripts

Not separately run. The end-to-end `validate <run_id>` finalize (next step) functions as the live smoke test for the new followups-context.md generator on a real run.

## Known issues

All 7 pre-existing on master; flagged in `build.md` § Known issues. None caused by this run's changes.

### `tests.test_backfill_base_ref_sha` (5 failures)

All five tests in this module fail with the same root cause:

```
ModuleNotFoundError: No module named 'lib'
  File ".../tools/backfill_base_ref_sha.py", line 89, in main
    from lib import yaml_io
```

The `tools/backfill_base_ref_sha.py` script imports `lib.yaml_io` without setting `PYTHONPATH=src` (or equivalent). The tests invoke the script as a subprocess; when invoked from the workbench root the tool can't find `lib`. Pre-existing on master.

Failing tests:
1. `test_dry_run_reports_change_but_writes_nothing`
2. `test_missing_source_repo_skipped_not_failed`
3. `test_orphan_branch_uses_root_commit`
4. `test_second_run_is_noop`
5. `test_write_populates_sha_and_summarizes`

### `tests.test_human_review.TestSnapshotRender` (2 failures)

Snapshot tests with hard-coded `2026-05-22-...` run IDs. Today is `2026-05-27`, and the synthetic run IDs the test generates carry the current date, producing a diff against the expected fixtures.

Failing tests:
1. `test_happy_snapshot` - expected `2026-05-22-happy-snap`, got `2026-05-27-happy-snap`.
2. `test_bounce_pass2_snapshot` - expected `2026-05-22-bounce-snap`, got `2026-05-27-bounce-snap`.

Fix is to either parameterize the snapshot fixtures or refresh them; out of scope here.

## Captured artifacts

None. CLI-only changes; no recordings or traces.
