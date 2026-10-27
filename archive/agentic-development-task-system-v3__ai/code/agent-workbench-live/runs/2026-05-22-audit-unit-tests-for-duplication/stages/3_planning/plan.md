# Implementation plan

## Current repo understanding

The workbench's unit tests live in `agent-workbench-live/tests/`. Sixteen modules (including `_helpers.py` and `__init__.py`), 15 test files, ~3,750 lines total. Two modules dominate by line count: `test_board_snapshot.py` (816 lines) and `test_cmd_board.py` (559 lines) — both grew through the live-board UX work and the dogfood follow-ups. The remaining 13 files are 70–550 lines each.

The suite uses `unittest.TestCase` subclasses throughout (with a few module-level helpers in `_helpers.py`). There is no `bin/pytest`; pytest discovers tests via plain collection when invoked from inside `agent-workbench-live/`. The CLI under test is `bin/agent-workbench`, dispatched into `lib/cli/cmd_<name>.py` modules. The board (`lib/board/snapshot.py`) is the most-tested subsystem.

Two layers of testing exist for board behaviour:

- `test_board_snapshot.py` — calls `snapshot.build(...)` directly; asserts on the structured `Snapshot` object. Pure library test.
- `test_cmd_board.py` — invokes the CLI (`cli(self.tmp, "board", "--static", ...)`); asserts on stdout strings. End-to-end test of the CLI wrapper plus its renderer (`_static_card_stack`).

These are not duplicates in the strict sense: they exercise different layers (library vs. rendered output) and would fail in different scenarios (e.g. a renderer bug breaks `test_cmd_board.py` only; a snapshot-building bug breaks both). That distinction governs every "duplicate" call in this run.

Confirmed concrete candidates:

- `test_cmd_board.py:TestStaticDumpStructure.test_terminal_states_hidden_by_default` (line 144) and `test_board_snapshot.py:TestColumnsAndOrdering.test_terminal_states_hidden_by_default` (line 195). Same predicate, two layers. The CLI version is strictly the broader test (it covers the snapshot path AND the renderer path) — but the layer distinction is the point of having both. **Decision below in DR-001.**
- `test_cmd_board.py:TestStaticCardStack` (line 271) is the regression-locked class for commit `52926b5` (per the brief's reference, confirmed by docstring on `test_human_review_includes_followups_category_breakdown` line 280). **Do not touch.**

The `test_e2e.py` file contains three scenarios (`TestE2EHappyPath`, `TestE2EBounceLoop`, `TestE2EAbandon`) using the stub-LLM mode shipped in commit `0042680`. These are end-to-end scenario locks, not regression locks, but they were the explicit deliverable of TODO §1 (automatic E2E testing). Treat as out of scope for pruning.

## Relevant files

Test modules — every one will be walked. Listed roughly by where duplication is most likely:

- `tests/test_board_snapshot.py` — 18 TestCase classes, all inherit `BoardSnapshotTestBase`. High-density-per-class; many tests share a single seeded fixture and assert on adjacent fields.
- `tests/test_cmd_board.py` — 559 lines; mix of subprocess CLI tests (`BoardCase`) and direct unit tests against `_static_card_stack` (the regression class lives here).
- `tests/test_integration.py` — 553 lines, full-flow tests that may overlap with newer focused tests.
- `tests/test_transitions.py` — 336 lines; transition validation; possible framework-style assertions.
- `tests/test_lifecycle.py` — 255 lines; lifecycle contract.
- `tests/test_doc_claims.py`, `test_followups.py`, `test_metadata.py`, `test_events.py`, `test_yaml_io.py`, `test_run_ids.py`, `test_scope_check.py`, `test_cmd_plan_parser.py` — smaller targeted modules; expect few reductions but each must still be walked.
- `tests/test_e2e.py` — scenario locks. Walk for completeness, do not prune.

Production code touched by tests (read-only during this run): `lib/board/snapshot.py`, `lib/cli/cmd_board.py`, `lib/cli/cmd_*.py`, `lib/transitions.py`, `lib/lifecycle.py`, `lib/events.py`, `lib/metadata.py`.

## Proposed changes

Single-stream pruning pass over the 15 test files, in roughly descending order of expected yield: `test_board_snapshot.py` → `test_cmd_board.py` → `test_integration.py` → `test_transitions.py` → `test_lifecycle.py` → the smaller modules in alphabetical order. Each module is walked once; reductions are committed at module boundaries (or grouped in one final commit on the feature branch, since the workbench convention is one feature = one commit) and the suite is run after each module's changes.

For each test file, the procedure is:

1. **Survey.** Enumerate every `Test*` class and every `test_*` method. For each method, note (a) the setup/seed lines (preconditions) and (b) the `assert*` lines (assertion targets). Record the survey table in `build.md` as it's produced.
2. **Classify.** Tag each method as one of: `regression-lock`, `e2e-scenario`, `merge-candidate-with-X`, `framework-only`, `over-specified-formatting`, `subsumed-by-Y`, `keep-as-is`.
3. **Apply.** Three pruning operations are in scope:
   - **Merge** (`merge-candidate-with-X`): combine tests with identical preconditions into a single `parametrize`d method, or into one test with combined assertions on a shared fixture. Preserve every previously-asserted field/branch.
   - **Delete-subsumed** (`subsumed-by-Y`): remove the weaker test; name the survivor in `build.md`.
   - **Delete-framework-only** (`framework-only`): remove tests asserting stdlib / pytest / argparse behaviour. Name the framework feature in `build.md`.
   - **Relax** (`over-specified-formatting`): rewrite `assertEqual` → `assertIn` (or similar) for strings whose exact wording is allowed to evolve. Before/after listed in `build.md`.
4. **Verify.** Run `pytest -q` from inside `agent-workbench-live/`. Suite must be green. Record the new count.

Specific upfront decisions (see DR section below for full reasoning):

- **DR-001:** The board-snapshot / cmd-board "duplicate" pair (`test_terminal_states_hidden_by_default` × 2) is **kept**. The two assertions exercise different layers (snapshot library vs. CLI renderer). This is the documented "duplicate" from the brief, and the right answer turns out to be that it is not a duplicate.
- **DR-002:** Inside each layer, intra-class shared-setup methods *are* fair game for parametrize merges (e.g. three `TestHealthFlags` tests that seed one run and assert on different flag fields).
- **DR-003:** No production code changes. If a test fails after pruning and the fix is not "restore the previously-asserted branch in the merge", surface a follow-up and re-add the test rather than chasing the production bug here.

Expected reduction range: somewhere between 5 and 20 tests. The conservative end leaves the suite at ~188; the aggressive end at ~173. The brief's acceptance criterion is "strictly less than 193" — any reduction satisfies it, but the goal is meaningful: at least one reduction in each of the two large modules.

## Files likely to change

- `agent-workbench-live/tests/test_board_snapshot.py`
- `agent-workbench-live/tests/test_cmd_board.py`
- `agent-workbench-live/tests/test_integration.py`
- `agent-workbench-live/tests/test_transitions.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- Possibly `agent-workbench-live/tests/test_doc_claims.py`, `test_followups.py`, `test_metadata.py`, `test_events.py`, `test_yaml_io.py`, `test_run_ids.py`, `test_scope_check.py`, `test_cmd_plan_parser.py` — only if the module-walk surfaces a candidate.
- `docs/TODO.md` (delete §3, add ✅ summary).
- `docs/LOG.md` (dated entry with final count + biggest reductions).

Out of scope (must not change):

- `agent-workbench-live/tests/_helpers.py` (helper code, not under audit).
- `agent-workbench-live/tests/test_e2e.py` (scenario locks).
- `agent-workbench-live/tests/test_cmd_board.py:TestStaticCardStack` (regression-locked class).
- Any test bearing "regression" in its docstring (currently one match: line 280 of `test_cmd_board.py`).
- Any production code under `lib/`.
- Run artifacts under `agent-workbench-live/runs/`.

## Data model changes

None.

## UI changes

None.

## Test plan

The test plan is recursive: the deliverable IS the test suite. Concretely:

- **Baseline capture.** Before any pruning, run `pytest --collect-only -q` from inside `agent-workbench-live/` and record the exact count (expected: 193, but the brief allows for drift since LOG.md was last written). Save the full node-ID list to `/tmp/baseline.txt` for diffing.
- **After each module's prune.** Run `pytest -q`. Suite must be green. Note the count delta.
- **Final pass.** Run `pytest --collect-only -q` again, save to `/tmp/final.txt`, diff against baseline. Every removed/renamed node ID must be explainable from the `build.md` survey.
- **Spot check.** For three randomly chosen removed tests, run `git blame` (or `git log -- <file>`) on the original line range to confirm the introduction commit was not described as "regression" in its message. If any are, restore the test.

A new test file may be added if the pruning happens to surface a missing branch that ought to be covered (unlikely; the brief is explicit that this is a pruning pass, not an addition pass). If added, it must be motivated in `build.md`.

## QA plan

There is no separate QA stage beyond the unit suite itself, because no production code is changing. The QA report will record:

- Baseline test count (number, and source: `pytest --collect-only -q`).
- Final test count.
- Delta (must be negative).
- The three spot-check git-blame results.
- A bulleted list of the top 3–5 reductions by size, each tagged with module + class + reason (merge/subsumed/framework/over-specified) — same list that will land in `docs/LOG.md`.
- Confirmation that `TestStaticCardStack` and `test_e2e.py` scenarios are byte-identical to their pre-run versions (`git diff --stat -- tests/test_cmd_board.py tests/test_e2e.py` will show the touched line counts; the explicit confirmation is in `build.md`).

## Risks

- **Loss of coverage masked by green suite.** A merged-into-parametrize test might silently drop one of the original assertions; the suite still passes because no production bug exposes the gap. Mitigation: the survey table in `build.md` enumerates every assertion *before* the merge; the post-merge code is checked against the table.
- **Regression-locked test deleted by mistake.** The brief lists two markers ("regression" word, commit-SHA in docstring) but a regression test might not bear either signal. Mitigation: the three-test spot check on git blame. If the introducing commit message says "regression" or references a bug, restore the test even if its docstring is silent.
- **Layer confusion (DR-001).** The most obvious "duplicate" in the brief turns out NOT to be a duplicate. A naive reading would delete one of the pair and lose layer coverage. Mitigation: DR-001 is recorded upfront so the implementation does not regress to the naive call.
- **Suite goes from 193 to e.g. 192.** Acceptance is satisfied, but the LOG entry would be unimpressive. Mitigation: walk every module before claiming the run is done. The brief explicitly requires the walk, not just the count drop.
- **Newly-flaky test after a merge.** A parametrized test that combines two fixtures might expose ordering dependency. Mitigation: run the suite twice if any parametrize merge lands.

## Definition of done

- Every test module under `agent-workbench-live/tests/` has been surveyed; the survey output is recorded in `build.md`.
- The suite is green via `pytest -q` from inside `agent-workbench-live/`.
- The final test count is strictly less than the baseline (expected: less than 193).
- `build.md` lists every pruning operation by category (merge / subsumed / framework / over-specified / no-change), with module + class + method.
- `TestStaticCardStack` and `test_e2e.py` are byte-identical to pre-run.
- `docs/TODO.md` §3 is deleted and summarized in "Completed work" with the feature-branch commit SHA.
- `docs/LOG.md` has a dated entry naming the final count, the delta, and the top 3–5 reductions.

## Preflight

Tooling and repo state checked before declaring the plan ready:

- Workbench CLI works (`bin/agent-workbench show 2026-05-22-audit-unit-tests-for-duplication` returns valid metadata after each `--init`).
- Tests live under `agent-workbench-live/tests/` (confirmed by `ls`).
- Test file sizes confirmed via `wc -l` (816 + 559 + 553 + 336 + 255 + smaller files, total ~3,750 lines).
- The two halves of the brief's duplicate pair are at `test_cmd_board.py:144` and `test_board_snapshot.py:195` (confirmed via `grep`).
- The regression class `TestStaticCardStack` is at `test_cmd_board.py:271`; its docstring on line 280 carries the word "Regression" explicitly (confirmed via `grep -i`).
- No `bin/pytest` exists in `agent-workbench-live/` — `pytest` is invoked directly.
- The target repo IS this repo (self-hosting); the worktree will be created at `agent-workbench-live/worktrees/agentic-development-task-system-v2-ai/<date>__audit-unit-tests-for-duplication`. Base ref: `202605_agent_workbench_v2` (the current branch). Branch: `agent/audit-unit-tests-for-duplication`.

No warnings to flag.

## Decisions & assumptions

### DR-001
- **Decision**: The board-snapshot / cmd-board pair `test_terminal_states_hidden_by_default` is kept as two tests (one per file).
- **Rationale**: They exercise different layers. `test_board_snapshot.py` tests `snapshot.build(...)` directly; `test_cmd_board.py` tests the CLI's static dump (which composes `snapshot.build` + `_static_card_stack` + stdout). A bug in `_static_card_stack` would fail only the second; a bug in `snapshot.build` would fail both. Deleting either drops a real safety net.
- **Alternatives considered**: (a) Delete the snapshot-layer test (the CLI test is strictly broader). (b) Delete the CLI test (the library test is faster). (c) Merge them somehow into a single layered test.
- **Why not the alternatives**: (a) loses fast feedback when only the library breaks; the broader test would also fail but the diagnosis is slower. (b) loses the only assertion that the CLI's static path doesn't drop terminal-state filtering. (c) cross-layer merges are exactly the kind of cleverness the workbench warns against; the layers belong in separate files for the same reason `lib/` and `bin/` are separate.

### DR-002
- **Decision**: Intra-class shared-setup merges via `pytest.mark.parametrize` (or combined assertions) are the primary pruning mechanism inside `test_board_snapshot.py` and `test_cmd_board.py`.
- **Rationale**: These files are 800+ and 550+ lines respectively, with many `BoardSnapshotTestBase` / `BoardCase` subclasses where two or three methods seed the same run and assert on different fields. The user's global CLAUDE.md ("App Testing Rules") explicitly endorses this pattern: *Merge tests with identical setup that differ only in assertions.*
- **Alternatives considered**: Refactor the helpers in `_helpers.py` to surface common fixtures more sharply (then keep separate methods).
- **Why not the alternatives**: Helper refactors are out of scope per the brief (non-goal: refactoring fixtures beyond what's mechanically required to merge). The merge approach is the smaller change.

### DR-003
- **Decision**: No production code changes. If a merge causes a failure that isn't a clean "restore the missing assertion" fix, the test is restored to its pre-merge form and the candidate is downgraded to "keep-as-is".
- **Rationale**: The brief explicitly forbids "rewriting production code to make a flaky test pass" — surface as a follow-up instead. A merge that exposes a bug is more valuable as a follow-up than as a half-fixed parametrize block.
- **Alternatives considered**: Fix the production bug inline if it's small.
- **Why not the alternatives**: The blast radius is unbounded. Pruning runs should stay confined to test code; production fixes belong in their own run.

### DR-004
- **Decision**: All pruning lands in a single commit on the feature branch (matching the workbench convention of one feature = one commit).
- **Rationale**: Bisecting the pruning into per-module commits would be useful only if a regression were suspected; the suite is green at each module boundary anyway. The convention in `docs/LOG.md`'s recent entries is one commit per feature, with the LOG entry summarising at the module-cluster level.
- **Alternatives considered**: Module-per-commit.
- **Why not the alternatives**: Adds noise to git log without adding bisect value (the suite never goes red).

### ASM-001
- **Text**: The baseline test count is exactly 193 (per the brief and `docs/TODO.md` §3).
- **Reason**: TODO.md and the recent LOG entry (2026-05-22) both record this number, and no commits since `0042680` changed the test count noticeably.
- **Impact**: low — the implementation will record the actual baseline from `pytest --collect-only -q` and use that number in the LOG entry. The "193" target is informational; the criterion is "lower than baseline".

### ASM-002
- **Text**: Pytest collection from inside `agent-workbench-live/` works out of the box with the existing `tests/__init__.py` and no `pytest.ini` / `pyproject.toml` config.
- **Reason**: The most recent LOG entry (2026-05-22) reports `193/193 green`, implying CI or the human runs `pytest` somewhere and it works.
- **Impact**: low — if collection fails, the implementation will discover the right invocation (perhaps `PYTHONPATH=. pytest`) inside the worktree and record it in `build.md`. The fix is a one-line shell command, not a planning question.

### ASM-003
- **Text**: The only regression-locked tests in the suite are those with the word "regression" in a docstring (currently one match: `TestStaticCardStack.test_human_review_includes_followups_category_breakdown`).
- **Reason**: `grep -irn regression tests/` returned only that one line. No commit-SHA strings appear in any test docstring (`grep -n` for the known SHAs `52926b5`, `549c9aa`, `445f3cd`, `0042680` returned no matches).
- **Impact**: medium — the spot-check on git blame (in QA plan) catches false negatives. If a regression test exists without the "regression" docstring marker, the spot-check will surface it. Worst case is "we deleted one and have to restore it", which is reversible.
