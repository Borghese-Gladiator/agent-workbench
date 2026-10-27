# Build report

## What changed

Pruned redundant unit tests from `agent-workbench-live/tests/`. Baseline 193 → final 134 (−59 tests, −30.6%). Suite still green; regression-locked tests and `test_e2e.py` scenarios are byte-identical to pre-run. The mechanism is the user's CLAUDE.md "App Testing Rules" pattern: merge tests with identical setup into one test that asserts on all relevant fields/branches with a `for label, … in cases:` loop and `msg=label` so a failure still names which branch regressed.

## Files changed

- `agent-workbench-live/tests/test_scope_check.py` — 16 → 2 tests. Folded `TestExtractExpectedFiles` (6 methods) and `TestDetectCreep` (10 methods) each into one test iterating a `cases` list.
- `agent-workbench-live/tests/test_cmd_board.py` — 35 → 22 tests. Folded `TestSeverityClassification` (8 → 1), `TestPathAbbreviation` (4 → 1), and the three severity-marker tests in `TestStaticCardBands` (3 → 1). `TestStaticCardStack` (regression-locked per commit `52926b5`) is byte-identical.
- `agent-workbench-live/tests/test_board_snapshot.py` — 39 → 34 tests. Folded `TestLiveSignal` (3 → 1), `TestAcceptanceCoverage` (3 → 1), `TestWorktreeMissingFlag` (2 → 1). One snapshot per case; assertions key off `run_id`.
- `agent-workbench-live/tests/test_doc_claims.py` — 10 → 2 tests. Folded `TestExtract` (6 → 1; the NONE_NEEDED sentinel case uses `assertIs`, everything else uses `assertEqual`) and `TestVerify` (4 → 1, sharing the git-repo setUp).
- `agent-workbench-live/tests/test_followups.py` — 12 → 6 tests. Folded `TestValidate`'s 5 rejecting tests into one and 3 accepting tests into another.
- `agent-workbench-live/tests/test_run_ids.py` — 12 → 6 tests. Folded `TestExtractRunDate`'s 2 happy paths + 5 raising tests into 2 (one happy, one bad-inputs). Folded `TestSlugify`'s 2 raising tests into one.
- `agent-workbench-live/tests/test_yaml_io.py` — 9 → 7 tests. Folded `test_rejects_flow_style` + `test_rejects_multidoc` + `test_rejects_tab_indent` into one `test_rejects_unsupported_yaml` listing four `(label, text)` pairs.
- `agent-workbench-live/tests/test_lifecycle.py` — 18 → 15 tests. Folded `TestHumanReviewValidation` (4 → 1).
- `agent-workbench-live/tests/test_events.py` — 5 → 3 tests. Folded the 3 rejecting tests (+ the inner 2-case `test_rejects_bad_actor`) into one `test_rejects_invalid_appends`.
- `agent-workbench-live/tests/test_metadata.py` — 9 → 8 tests. Folded the 2 `MetadataError`-raising tests (`duplicate create`, `load missing`) into one `test_metadata_error_cases`.

## Reviewer reading order

1. `tests/test_scope_check.py` — the biggest single reduction (−14) and the cleanest pattern. If this folding shape is acceptable, the rest are minor variations.
2. `tests/test_cmd_board.py` — second-biggest reduction (−13). Confirm `TestStaticCardStack` is unchanged (the regression-locked class lives here).
3. `tests/test_doc_claims.py` — the only fold that mixes `assertEqual` and `assertIs` in a single loop (the `NONE_NEEDED` sentinel). Worth confirming the dispatch shape (`op, value`) is readable.
4. `tests/test_board_snapshot.py` — the only file where the fold creates multiple seeded runs per test and asserts on them via a `runs_by_id` dict. Skim `TestLiveSignal.test_live_signal_cases` for the pattern.
5. `tests/test_lifecycle.py` — the `TestHumanReviewValidation` fold uses a `predicate(errs)` lambda for assertion variety. Verify the lambdas faithfully encode the original assertions.
6. `tests/test_followups.py` and `tests/test_run_ids.py` — small folds.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| Final test count strictly less than 193 | `pytest --collect-only -q` reports 134; `wc -l` on /tmp/final.txt confirms |
| Suite green after final prune | `pytest -q` reports `134 passed` (ran twice for stability) |
| Every test module walked at least once | Survey notes in this section; modules with no reductions are named below |
| Merged tests retain coverage | Each `cases` list keeps every previously-asserted field/branch; `msg=label` preserves diagnosis |
| Subsumed-tests calls name the survivor | None of the prunes were "delete because Y subsumes" — all were "merge into one bigger test" |
| Framework-only deletions named | None found (`grep argparse\|FrozenInstanceError\|dataclasses.field` returned nothing) |
| Over-specified assertions relaxed | None applied — the `assertEqual("✕ tests failing", line)` example from the brief is not present in the suite (the closest is `assertIn("✕ tests failing", body)` which is already behavioral). No relaxations were needed. |
| No regression-locked tests touched | `TestStaticCardStack` byte-identical (`git diff` shows no − / + lines for that class). Only one test in the suite carries "regression" in a docstring (`test_human_review_includes_followups_category_breakdown`) — confirmed unchanged. |
| `docs/LOG.md` will record final count + top reductions | Pending — landing alongside the TODO update in the docs commit (next step). |
| `docs/TODO.md` §3 deleted + summarised | Pending — same docs commit. |

Modules walked, no reductions applied (each one's tests already cover distinct preconditions/branches and folding would lose clarity without lowering the count):

- `tests/test_transitions.py` (12 tests) — each tests a distinct transition rule or rejection path. The three rejection-from-different-states tests share a TestCase but each requires distinct intermediate `_advance` calls. Folding would inflate the body without removing tests.
- `tests/test_integration.py` (8 tests) — end-to-end CLI flows. `TestBounceLoop`'s four bounce tests share `_drive_to_human_review` but each tests a different bounce path. Each is a meaningfully distinct integration scenario.
- `tests/test_cmd_plan_parser.py` (4 tests) — single-line vs multi-line vs continuation-leak parser scenarios. No shared-setup duplication.
- `tests/test_e2e.py` (5 tests) — scenario locks for `AGENT_WORKBENCH_STUB_LLM` mode (TODO §1's "automatic E2E testing"). Out of scope per the brief.

## Deviations from plan

- Plan's DR-001 said keep both `test_terminal_states_hidden_by_default` (CLI + library layers). Confirmed during implementation — verified `cmd_board.py` just delegates to `snapshot.build(show_all=...)` so the CLI version is plumbing-smoke and the snapshot version is behavior. Both still present.
- Plan estimated 5–20 reductions ("conservative end leaves the suite at ~188; aggressive end at ~173"). Actual: −59 (134). The plan underestimated because it treated `parametrize` as the primary tool — but `parametrize` doesn't reduce the test count (each case is collected as one test). Switched to **combined assertions on a single fixture inside one test method** (the user's CLAUDE.md "App Testing Rules" wording, taken literally). This drove the larger reduction and the change of approach is documented here for traceability.
- DR-004 said one commit on the feature branch — still holds. The pruning + docs update lands in one commit at the end.

## Known issues

None.

## Commands run

- `python -m pytest tests/ -q` — green after each per-module prune (10 runs total).
- `python -m pytest tests/ --collect-only -q` (proxied via `rtk proxy` to bypass token-filtering of `--collect-only` output) — baseline 193 (saved to `/tmp/baseline.txt`), final 134 (saved to `/tmp/final.txt`).
- `git diff --stat tests/` — confirms only the expected test files changed, with substantial deletions vs insertions.
- `git diff tests/test_cmd_board.py | grep -E "TestStaticCardStack|Regression"` — empty, confirming the regression-locked class is untouched.
- `git diff tests/test_e2e.py` — empty, confirming the E2E scenarios are untouched.

## Documentation touched

- `docs/TODO.md` — will be updated alongside this run's commit: delete §3, add ✅ summary to "Completed work" with the commit SHA and final test count.
- `docs/LOG.md` — will be updated alongside this run's commit: dated entry naming final count, delta, and top 3–5 reductions.
