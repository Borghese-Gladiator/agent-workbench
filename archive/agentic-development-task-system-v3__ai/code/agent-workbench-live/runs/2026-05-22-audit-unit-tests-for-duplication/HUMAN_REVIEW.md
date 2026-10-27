# Human review — 2026-05-22-audit-unit-tests-for-duplication

## Where to start

- Want to see diffs? → `stages/4_building/build.md`
- Want to verify QA? → `stages/5_validating/qa/report.md` (+ `qa/commands.txt`)
- Want to confirm each AC is tested? → `stages/4_building/build.md` § Acceptance criteria coverage
- Want to argue with decisions? → `stages/3_planning/plan.md` § Decisions & assumptions, then `stages/5_validating/review.md`
- Want to see what's next? → `stages/6_followups/follow-ups.md`

## Suggested first checks

```bash
# From inside the worktree's agent-workbench-live/ directory:
python -m pytest tests/ -q
# Expect: 134 passed
python -m pytest tests/ --collect-only -q | tail -1
# Expect: 134 tests collected
git diff tests/test_cmd_board.py | grep -E "TestStaticCardStack|Regression"
# Expect: (empty) — regression-locked class untouched
git diff tests/test_e2e.py
# Expect: (empty) — scenario locks untouched
```

1. Skim `tests/test_scope_check.py` (the biggest reduction). If the fold pattern is acceptable, the other folds use the same shape.
2. Skim `tests/test_cmd_board.py`'s three folds (`TestSeverityClassification`, `TestPathAbbreviation`, the markers fold in `TestStaticCardBands`). Confirm `TestStaticCardStack` (lines 271–end) reads identically to pre-prune.
3. Eyeball the `(op, value)` dispatch in `tests/test_doc_claims.py::TestExtract.test_extract_cases` (the only fold that mixes `assertEqual` and `assertIs`).
4. Confirm the docs update reads naturally (`docs/TODO.md` §3 deleted + ✅ summary at top; `docs/LOG.md` dated entry).

If steps 1–4 pass, the run is delivered.

## Run timeline

See `audit.md` (rendered alongside this file by `validate`) for the full event log. Short version:

- **draft → shaping → planning → ready**: code-blind. The brief faithfully transcribes TODO §3; the plan adds DR-001 through DR-004 (preserving both layers of the brief's "duplicate" pair, picking parametrize for readability but switching to combined-assertions for actual count reduction, no production-code changes, single-commit landing).
- **ready → building**: worktree created at `agent-workbench-live/worktrees/agentic-development-task-system-v2-ai/20260522__audit-unit-tests-for-duplication/`. Branch `agent/audit-unit-tests-for-duplication` off `202605_agent_workbench_v2`.
- **building**: baseline measured (193). Modules surveyed in order of expected yield. Pruning applied as combined-assertions folds (the user's CLAUDE.md "App Testing Rules" pattern). After-each-module suite checks always green. Final 134.
- **validating**: review.md (decision: approve), qa/report.md (134 passed twice, 0 known issues), audit.md, this file.
- **next**: `/followups` to brainstorm forward-looking candidates, then the human gates.
