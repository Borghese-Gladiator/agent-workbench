# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. The brief's acceptance criteria, in order:

- **Final test count strictly less than 193**: 134 collected (−59, −30.6%). Verified twice (`pytest --collect-only -q` and the count line from `pytest -q`).
- **Suite green after the final pruning pass**: 134 passed; re-ran a second time, still 134 passed (no flakes).
- **Every test module under `agent-workbench-live/tests/` walked**: `build.md`'s "Reviewer reading order" + "Modules walked, no reductions applied" sections name every module. Four modules yielded no reductions (`test_transitions.py`, `test_integration.py`, `test_cmd_plan_parser.py`, `test_e2e.py`) and the reasoning for each is recorded.
- **Merged tests retain previously-asserted fields/branches**: every fold uses a `for label, … in cases:` loop with the original assertion shape preserved per case. Spot-check below confirms.
- **Subsumed-tests calls name the survivor**: not applicable — no "subsumed" deletions were performed (every reduction was a fold, not a delete-because-Y-covers-it).
- **Framework-only deletions named**: `grep -n "argparse\|FrozenInstanceError\|dataclasses\.field" tests/*.py` returned no matches. No framework-only tests existed; nothing was deleted on this signal.
- **Over-specified assertions relaxed**: none. The brief's example (`assertEqual(line, "✕ tests failing")` → `assertIn("tests failing", line)`) does not exist in the suite — the only matching line is `assertIn("✕ tests failing", body)` in `TestStaticCardBands.test_severity_reason_appears_in_body`, which is already behavioral. No relaxations were warranted.
- **No regression-locked tests touched**: `git diff tests/test_cmd_board.py | grep -E "TestStaticCardStack|Regression"` empty. The only "regression"-keyword docstring in the suite (line 280 of test_cmd_board.py) is byte-identical.
- **LOG.md final count + biggest reductions**: pending, to land in the docs commit.
- **TODO.md §3 deletion + ✅ summary**: pending, same docs commit.

## Did it accidentally expand scope?

No. Diff is constrained to 10 files, all under `agent-workbench-live/tests/`. No production code under `lib/` was touched (verified via `git diff --stat`). No new test runner / framework / lint tool introduced.

One scope-question worth flagging: I added `msg=label` arguments to most folded assertions so that when a single case fails the diagnosis still names the row. This is technically a behavior change (the failure message format), but it's strictly additive — no existing assertion lost a `msg=` it had before. The brief's non-goals call out helper/fixture refactors as out of scope; `msg=label` is neither.

## Are there fragile assumptions?

One worth naming: the fold inside `test_doc_claims.py::TestExtract.test_extract_cases` dispatches between `assertEqual` and `assertIs` via a `(op, value)` tuple per row. If a future contributor adds a case using a third operator (e.g. `assertIn`), the dispatch must be extended. This is a small additional cognitive burden but localized to that single test and well-commented.

Two folds use a `predicate(errs)` lambda for assertion variety:

- `test_lifecycle.py::TestHumanReviewValidation.test_validation_cases` — the predicate captures heterogeneous shapes (`len(errs) == 1 and "not found" in errs[0]`, `len(errs) == 2`, etc.). If one case regresses the diagnosis is "got [...]" without naming the specific predicate; that's slightly weaker than the original `assertEqual(len(errs), 1)` + `assertIn("not found", errs[0])`. Trade-off accepted because the lambda is one line and the `msg=label` still names the row.
- Otherwise the fold pattern is uniform.

Not fragile, just worth a heads-up.

## Are there missing tests?

No. The fold is "fewer methods, same assertion footprint per method", not "fewer assertions". Every previously-asserted field and branch is still exercised. Concretely:

- `TestSeverityClassification` (8 → 1): each of the 8 cases still asserts `severity(run) == EXPECTED_LEVEL`, and 5 of them still assert the reason string (3 used `__SKIP__` originally too because the source tests didn't assert on the reason).
- `TestDetectCreep` (10 → 1): each of the 10 `(expected, actual, creep)` rows is asserted, including the suffix-match-respects-/-boundary case (added as a regression earlier in the project's life — the marker is the slash-boundary comment, not the word "regression", and the docstring on the original test confirms it was a deliberate guard, not a duplicate).
- `TestExtract` (6 → 1, in `test_doc_claims.py`): the `NONE_NEEDED` sentinel case keeps its `assertIs` semantics via the `("is", expected)` dispatch.
- `TestLiveSignal` (3 → 1, in `test_board_snapshot.py`): the fold seeds three runs with three different event configurations and asserts `is_live` on each.

## Are there security / data loss / migration risks?

No. The change is confined to test files; no production code, no SQL migrations, no infra. The suite's behavior contract is preserved.

## What should the human review first?

1. **`tests/test_cmd_board.py`** — biggest single-file delta (−13 tests, −20 line balance) and the file containing the regression-locked `TestStaticCardStack`. Confirm the regression class is untouched (it is per `git diff` filter) and that the three folds (`TestSeverityClassification`, `TestPathAbbreviation`, `TestStaticCardBands` markers) read cleanly.
2. **`tests/test_scope_check.py`** — biggest reduction proportionally (16 → 2). Read both folded tests end-to-end. The `cases` lists are flat and direct; if this style is acceptable, the same shape was used elsewhere.
3. **`tests/test_doc_claims.py`** — the `(op, expected)` dispatch in `test_extract_cases` is the only fold that mixes assertion operators. Confirm the dispatch is acceptable, or push back and we'll split `NONE_NEEDED` into its own one-line test (small re-inflation, but localizes the special case).
4. **`docs/LOG.md` + `docs/TODO.md`** — the docs commit lands next; the human can sanity-check the LOG narrative against the diff.

## Blast radius

Depth-1 (changed files): 10 test files under `agent-workbench-live/tests/`. No `lib/`, `bin/`, `schemas/`, `templates/`, or `.claude/commands/` files changed.

Depth-2 (callers of changed symbols): test files have no callers. The CI / pytest invocation that runs the suite continues to import the same module entry points (`tests.test_*`) — pytest's collection auto-discovers test methods, so renaming `test_returns_paths_under_files_likely_to_change` → folded into `test_extract_cases` does not break any caller.

Depth-3 (callers of those callers): N/A.

Scope-creep risk: zero. The brief's "Files likely to change" enumerated exactly the test files plus `docs/TODO.md` + `docs/LOG.md`. Nothing else was touched.

## Findings

None blocking. One minor follow-up worth noting (for `/followups`, not for this run):

### F-001

- **Severity**: minor
- **Where**: `tests/test_lifecycle.py::TestHumanReviewValidation.test_validation_cases`
- **Issue**: The predicate-lambda fold loses slightly granular failure diagnosis (a future regression of `errs[0]` substring would surface as "got [...]" rather than "expected substring 'not found' in errs[0]"). The `msg=label` mitigates but doesn't fully replace the original two-line `assertEqual` + `assertIn`.
- **Suggested fix**: If the granularity matters in practice, split the predicates back into two assertions per case (count + substring) inside the loop. Net test count would still be 1.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``docs/TODO.md``
- ``docs/LOG.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
