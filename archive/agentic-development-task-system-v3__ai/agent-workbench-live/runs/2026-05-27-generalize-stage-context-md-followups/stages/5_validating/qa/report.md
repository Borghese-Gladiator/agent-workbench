# QA report

## Summary

- **tests_passed**: true (7 pre-existing failures unchanged; no regressions)
- **known_issues_count**: 0 new (3 pre-existing carried from build.md)

## What ran

Two test passes from the rebuilt worktree, plus a post-finalize live-smoke
check that turned up a methodology surprise (see "Smoke scripts" below).

1. Focused subset on the new generators + the new regression test.
2. Full discovery on `tests/` to confirm no regressions and to verify
   the 7 pre-existing failures match the previous baseline.
3. Live-smoke: `agent-workbench validate <run_id>` finalize + filesystem
   check for `stages/6_followups/followups-context.md`.

## Results

### Unit tests

**Focused subset (`tests.test_cmd_validate_followups_handoff`,
`tests.test_shape_context`, `tests.test_plan_context`,
`tests.test_followups_context`)**

```
Ran 56 tests in 0.719s
OK
```

56/56 pass. Includes the new
`test_validate_default_mode_writes_followups_context`, which drives
`cmd_validate.run()` default mode against a synthetic validating-state run
and asserts the curated file lands in `stages/6_followups/`.

**Full discovery (`python -m unittest discover tests`)**

```
Ran 451 tests in 68.148s
FAILED (failures=7)
```

444/451 pass. All 7 failures are pre-existing and match the previous
validate pass's baseline:

- `test_backfill_base_ref_sha.TestBackfillBaseRefSha` x 5 -- PYTHONPATH-
  related; reproduce on master, not introduced by this rebuild.
- `test_human_review.TestSnapshotRender` x 2 -- date-sensitive snapshots
  embedding `2026-05-22` vs current `2026-05-27`; reproduce on master.

No new failures. No new regressions.

### Integration tests

n/a (the new regression test exercises real git subprocess + real
cmd_validate.run() against a synthetic worktree; closest integration the
workbench has).

### Lint / typecheck

Not run for the rebuild -- single import line + single function call +
docstring touch + one new test file.

### Browser / Playwright

n/a (CLI-only project).

### Smoke scripts

`agent-workbench validate 2026-05-27-generalize-stage-context-md-followups`
ran and transitioned `validating -> followups`. `agent-workbench show`
confirms status=followups. `ls stages/6_followups/` showed the directory
EMPTY -- no followups-context.md.

This LOOKED like a F-001 regression. After investigation: the CLI
dispatches to MASTER's `lib/cli/cmd_validate.py` (its `--root` defaults
to the master agent-workbench-live), and master does NOT have the fix
(grep confirms). Master also does NOT have `lib/followups_context.py`.
So the empty `stages/6_followups/` is the EXPECTED behaviour for a
self-modifying run before merge, not a defect in the rebuild.

The regression test against worktree code is the real evidence the fix
works. The fix will produce `followups-context.md` on the canonical path
once the run is accepted and merged to master.

## Captured artifacts

- `qa/commands.txt` -- exact commands run (with working directory shim).
