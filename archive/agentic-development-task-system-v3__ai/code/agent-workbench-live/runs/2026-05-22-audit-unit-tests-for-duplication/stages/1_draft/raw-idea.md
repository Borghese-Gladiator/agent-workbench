# Audit unit tests for duplication

193 tests is fine; redundant tests are not. Several rounds of feature work each added their own test class, and some assertions now overlap (e.g. `TestStaticDumpStructure.test_terminal_states_hidden_by_default` vs `TestColumnsAndOrdering.test_terminal_states_hidden_by_default` in `test_board_snapshot.py` — same condition, different scaffolding). Goal: shrink the suite without losing coverage.

- Walk every test module under `agent-workbench-live/tests/`. For each test, note its preconditions (fixture state) and its assertions (which fields / branches it exercises).
- Identify pairs/triples that share preconditions and only differ in assertion targets — merge them with `parametrize` or combined assertions on a single fixture. (See `~/.claude/CLAUDE.md` "App Testing Rules": *Merge tests with identical setup that differ only in assertions.*)
- Identify tests that overlap with newer, more-specific tests (e.g. an end-to-end smoke that's now subsumed by a unit test against the same helper). Drop the older one when the newer one is strictly stronger.
- Identify tests asserting framework behaviour rather than our code (e.g. asserting `argparse` rejects an unknown flag, asserting `dataclasses.frozen=True` raises on mutation). Delete.
- Watch for over-specified assertions that pin formatting rather than behaviour (e.g. `assertEqual(line, "✕ tests failing")` when `assertIn("tests failing", line)` is enough). Relax where the surrounding code is allowed to evolve.
- Don't touch tests that were added as regression locks (look for "regression" / commit-sha references in docstrings, e.g. `52926b5` in `TestStaticCardStack`). Those exist precisely because the bug came back once.
- Run the full suite after each pruning pass and confirm the count went *down* without losing real coverage. Report final count + biggest reductions in `docs/LOG.md`.
