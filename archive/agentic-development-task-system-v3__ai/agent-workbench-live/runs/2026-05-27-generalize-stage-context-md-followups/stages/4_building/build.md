# Build report

## What changed

This is the **rebuild pass after Bounce 1**. The original §5 build (commit `f949c33`) shipped the three context-md generators and wired them into the `--init` paths of `cmd_shape.py`, `cmd_plan.py`, and `cmd_followups.py`. The validate subagent found F-001 (major): the canonical user path (`agent-workbench validate <run_id>` default mode) does NOT call `cmd_followups --init`; instead, it directly transitions `validating → followups` via `cmd_validate.run()`. The original build wired only the `--init` shortcut, so the followups stage on the standard auto-chain got no curated file. This rebuild closes that gap.

## Files changed

- `agent-workbench-live/lib/cli/cmd_validate.py` — added a `from lib.cli.cmd_followups import _write_followups_context_artifacts` import (lazy, inside the function to avoid a circular at module load) and a call to that helper immediately after the `validating → followups` transition succeeds (lines ~512-518). The helper is reused (not re-implemented) so there's still only one copy of the followups-context builder pipeline.
- `agent-workbench-live/lib/cli/cmd_followups.py` — tightened the module docstring: the previous wording said `cmd_followups --init` "is a convenience shortcut that does the same thing as running `agent-workbench validate <run_id>`" — but the docstring's accuracy depended on BOTH paths writing the curated file, which only became true with this rebuild. The new wording explicitly notes that both paths now invoke `_write_followups_context_artifacts()`.
- `agent-workbench-live/tests/test_cmd_validate_followups_handoff.py` (new, 1 test, ~120 LOC) — regression test that drives `cmd_validate.run()` default mode against a synthetic validating-state run and asserts `stages/6_followups/followups-context.md` exists after the transition. Verified to bite (fail) when the new helper-call line is commented out, then pass when restored. Pins F-001 against future regressions.

## Reviewer reading order

1. `lib/cli/cmd_validate.py` — the one-line fix lives here. The new call site is between the existing `transitions.transition()` call and the existing `metrics_writer.record_run_metrics()` call. The lazy import is intentional: `cmd_followups.py` imports from `lib.cli._stop_banner`, which is fine; eagerly importing `cmd_followups` at `cmd_validate`'s module load could plausibly create a circular if either module ever grows new imports, so the local-scope import keeps the dependency narrow.
2. `lib/cli/cmd_followups.py` — only the docstring changed. Confirms the equivalence claim it now makes is accurate.
3. `tests/test_cmd_validate_followups_handoff.py` — confirms the test exercises the real default-mode code path (no mocks for the helper itself) and would have caught F-001 if it had existed pre-build.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC-bounce-1: F-001 is fixed — `cmd_validate.run()` default mode writes `followups-context.md` after the `validating → followups` transition | `tests/test_cmd_validate_followups_handoff.py::test_validate_default_mode_writes_followups_context` — passes with the fix, fails without it (verified by temporarily reverting the edit and re-running) |
| AC-bounce-2: No duplicate implementation of the helper | Code reading — `cmd_validate.py` imports `_write_followups_context_artifacts` from `cmd_followups.py` rather than re-implementing it. There remains one copy. |
| AC-bounce-3: Docstring claim about path equivalence is accurate | Code reading — `cmd_followups.py`'s module docstring now says explicitly that both paths invoke the helper |
| AC-bounce-4: All §5 original ACs still hold | Re-run of the full focused suite (115 tests): all pass. The three original `cmd_shape/plan/followups --init` write paths are untouched; only `cmd_validate.run()` default mode gained the new call. |
| AC-bounce-5: New regression test bites without the fix | Verified during build by manually reverting the new line and re-running the test; it failed with the documented AssertionError. Restored after verification. |

## Deviations from plan

- **Lazy import.** The change-request suggested "Add the helper to `cmd_validate.py` (or import the one from `cmd_followups.py` — pick one; importing is cleaner because it's a one-line delegation)." I chose the import path. But the import is local-scope (inside the staged-default-mode block of `cmd_validate.run()`) rather than module-level. Reasoning: `cmd_followups.py` already imports from sibling cmd modules' helpers indirectly through `lib.cli._common`; a module-level cross-import between two `lib.cli.cmd_*` files is unusual in this codebase and might surprise future readers. The local-scope import has the same effect (the helper is loaded on first call) without making the module-level dependency graph noisier.

## Known issues

1. **Pre-existing test failures still present.** The 7 failures documented in the original build.md (`test_backfill_base_ref_sha` × 5 PYTHONPATH; `test_human_review.TestSnapshotRender` × 2 date-sensitive) reproduce on master and are not addressed by this rebuild. Out of scope.
2. **Helper duplication unchanged.** F-003 (nit) from the original validate report — the 4-way `_read`/`_section`/`_HEADING_RE`/`_collect_id_blocks` duplication — still stands. It's captured in `follow-ups.md` as a refactor candidate.
3. **The regression test uses a real git repo** (subprocess shells to `git init` + `git add` + `git commit`). This is heavier than the unit tests for the helpers themselves, but `cmd_validate.run()` shells to git for the audit + doc-claims + scope-creep checks; the test wouldn't reach the new call site without a real worktree. Test runtime is ~0.3s, acceptable.

## Commands run

- `python -m unittest tests.test_cmd_validate_followups_handoff -v` → 1/1 pass.
- Verified the test bites: commented out the new call in `cmd_validate.py`, re-ran → 0/1 (AssertionError on the expected `target.exists()` check), restored the fix.
- `python -m unittest tests.test_cmd_validate_followups_handoff tests.test_shape_context tests.test_plan_context tests.test_followups_context -v` → 56/56 pass.
- `python -m unittest tests.test_cmd_validate_followups_handoff tests.test_shape_context tests.test_plan_context tests.test_followups_context tests.test_build_context tests.test_validate_context_build tests.test_lifecycle tests.test_self_modifying tests.test_validate_init_handoff_block -v` → 115/115 pass.

## Documentation touched

- `agent-workbench-live/lib/cli/cmd_followups.py` — module docstring updated to make the path-equivalence claim accurate (was: "convenience shortcut that does the same thing as running …"; now: "convenience shortcut equivalent to … BOTH paths write `followups-context.md`"). Internal-only documentation; no user-facing surface affected.
