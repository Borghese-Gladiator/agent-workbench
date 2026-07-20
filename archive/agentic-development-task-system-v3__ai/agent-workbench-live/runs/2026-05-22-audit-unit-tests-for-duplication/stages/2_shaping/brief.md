# Brief

## Goal

Shrink the workbench unit-test suite by removing duplication, framework-only assertions, and over-specified formatting checks — without losing real coverage. The suite stands at 193 tests today; several rounds of feature work each added their own test class and some assertions now overlap (a known concrete pair: `TestStaticDumpStructure.test_terminal_states_hidden_by_default` and `TestColumnsAndOrdering.test_terminal_states_hidden_by_default` in `test_board_snapshot.py` — same condition, different scaffolding). After this run the test count should be **lower** than 193 and the suite should still be green.

## User-facing behavior

There is no end-user behavior change. The only externally visible effect is that `pytest` reports a smaller number of tests, runs at least as fast, and `docs/LOG.md` records the final count plus the biggest reductions. Future agents reading the suite encounter fewer near-duplicates when looking for an example to model new tests on.

## Acceptance criteria

- Final test count is strictly less than 193.
- Full suite is green after the final pruning pass.
- Every test module under `agent-workbench-live/tests/` has been walked at least once — there should be a record (in `build.md`) of preconditions/assertions surveyed per module, and the modules that yielded no reductions should be named so a reader can tell they were inspected, not skipped.
- Tests merged via `parametrize` retain the same coverage as the originals (every previously-asserted field/branch is still asserted, just inside a parametrized case).
- Tests dropped as "subsumed by a newer, more-specific test" name the superseding test in the commit message or in `build.md`.
- Tests dropped as "framework-only" name the framework behavior they were asserting (e.g. "asserts argparse rejects unknown flag").
- Over-specified assertions relaxed to behavioral checks are listed in `build.md` with before/after.
- No test bearing a "regression" tag, the word "regression" in its docstring, or a commit SHA reference (e.g. `52926b5` in `TestStaticCardStack`) has been touched.
- `docs/LOG.md` records: final test count, delta from 193, top 3–5 reductions (module + class name + brief reason).
- `docs/TODO.md` §3 is deleted and summarized in the "Completed work" block at the top (with the commit SHA(s) of this run's feature branch).

## Non-goals

- Adding new tests. This is a pruning pass.
- Refactoring test helpers, fixtures, or `_helpers.py` beyond what's mechanically required to merge a duplicate pair.
- Rewriting production code to make a flaky test pass. If a test was masking a real bug, surface it as a follow-up, do not fix here.
- Migrating the suite from `unittest` to plain pytest functions, or vice versa. Only the duplication signal is in scope.
- Touching `agent-workbench-live/runs/*` artifacts. These are run history.
- Speed optimization beyond the natural effect of removing tests. No reordering, no `xdist`, no fixture caching changes.

## Good examples

- Two tests in `test_board_snapshot.py` (`TestStaticDumpStructure.test_terminal_states_hidden_by_default` and `TestColumnsAndOrdering.test_terminal_states_hidden_by_default`) assert the same predicate from different scaffolds. **Action:** keep one, delete the other (or merge into a parametrize block if either scaffold adds value). Note the survivor in `build.md`.
- Suppose `test_X_smoke` in `test_integration.py` instantiates a CLI subcommand and asserts that calling `--help` exits 0, and `test_help_exit_codes` in `test_cmd_board.py` does the same for every subcommand parametrized. **Action:** drop the smoke; the parametrized helper test strictly subsumes it.
- A test that does `with self.assertRaises(TypeError): some_frozen_dataclass.field = "x"` — asserts `dataclasses` itself, not our code. **Action:** delete.
- A test asserting `assertEqual(line, "✕ tests failing")` when the code that produces `line` is allowed to evolve (e.g. wording could become `"× tests failing"`). **Action:** relax to `assertIn("tests failing", line)` and note the change.
- Three tests in the same class with identical setup that differ only in which attribute they read (e.g. `test_card_title`, `test_card_age`, `test_card_repo`). **Action:** merge into one `parametrize`d test or one test with three assertions on a shared fixture.

## Bad examples

- Deleting `TestStaticCardStack.test_human_review_followups_breakdown_renders` because it "looks similar" to another test. That test references commit `52926b5` (the regression fix); it exists because the bug returned once. **Do not touch regression-locked tests** even when they look like duplicates.
- Merging two tests into a `parametrize` block but dropping one of the original assertions because "the other case will catch it" — that loses coverage. The parametrized version must keep every previously-asserted field/branch.
- Relaxing `assertEqual` → `assertIn` on a string that is itself part of the user-visible contract (e.g. an exact lifecycle state name like `"human_review"`). The point of "over-specified" is wording that can evolve; state names cannot.
- Renaming or restructuring a test file as part of the pruning. If `TestColumnsAndOrdering` is going away entirely, leave the file's other classes in place; do not consolidate just because the file is now shorter.
- Pruning so aggressively that a real branch in the code is now exercised only by an end-to-end test in `test_e2e.py`. The unit test should still exist; if it was a true duplicate of *another unit test*, fine — but losing the unit-level coverage entirely is not the goal.
- Committing pruning passes without re-running the suite between them. The acceptance criterion requires "the count went down" — that's only meaningful if the suite is green at each step.

## Constraints

- Stdlib Python; no new test runner, no new lint/format tooling. The suite is currently driven by plain `pytest` (no `bin/pytest` script in `agent-workbench-live/`).
- Run pytest from inside `agent-workbench-live/` (the repo's test rootdir).
- The two regression markers to scan for are: (a) the word "regression" in a class or function docstring or name, (b) a 7-character commit SHA reference in a docstring (current known example: `52926b5` in `TestStaticCardStack`). Treat both as immutable.
- Existing test class structures (`unittest.TestCase` subclasses with helpers) should be preserved when consolidating — keep the helper class, drop the duplicate method, rather than rewriting into top-level functions.
- The CLI's stub-LLM mode (`AGENT_WORKBENCH_STUB_LLM`) is in use for the E2E tests in `test_e2e.py`. These are explicit scenario locks — treat with the same caution as regression-locked tests unless a duplicate is clearly within a single E2E scenario.

## Assumptions

- The 193 baseline is current. If a recent commit changed the count, the implementation will record the actual baseline from a fresh `pytest --collect-only` run inside `agent-workbench-live/` before pruning, and use that number in the LOG entry.
- No production code is changing, so no QA beyond running the test suite itself is required.
- The "biggest reductions" called out in LOG.md are interesting at the granularity of class + reason (e.g. "merged 3 column-ordering tests in `test_board_snapshot.py` into one parametrized test, −2 tests").
- `parametrize` is acceptable inside `unittest.TestCase` subclasses via pytest's `@pytest.mark.parametrize` mechanism, or by refactoring the specific method out of the TestCase. The implementer picks per-case; both are allowed.

## Suggested QA scenarios

- Run `pytest --collect-only -q` inside `agent-workbench-live/` at start, after each pruning pass, and at the end. Record the count each time.
- Run the full suite (`pytest -q` from inside `agent-workbench-live/`) after each pruning pass. Must be green at every checkpoint.
- Diff the list of test node IDs before and after (`pytest --collect-only -q > /tmp/before.txt` etc.) — every removed/renamed ID should be explainable: "merged into X", "duplicate of Y", "framework-only", "over-specified".
- Spot-check three removed tests against their git blame to confirm none were originally added as a regression lock. (Look for "regression" in the commit message of the line that introduced the test.)
- Confirm that `TestStaticCardStack` (the known regression-locked class), `test_e2e.py` scenarios, and any test whose docstring or name contains "regression" are unchanged in the final diff.
