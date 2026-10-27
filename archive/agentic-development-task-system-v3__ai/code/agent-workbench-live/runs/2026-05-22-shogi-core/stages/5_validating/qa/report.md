# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- `python3 -m pytest backend/tests` — the full unit-test suite in the
  Shogi worktree. Captured in `qa/artifacts/pytest.txt`.

No lint / typecheck pass was run (the brief is stdlib + pytest only,
no ruff/mypy in the repo yet). No browser-driven or smoke testing
applies to a library-only deliverable.

## Results

### Unit tests

- 30/30 passed, 0 failed, 0 errors, 0 skipped.
- File-level breakdown:
  - `test_fen.py` — 10 tests (initial-FEN match, 7 parametrized
    round-trips, 1 known-good round-trip-of-initial, 5 parametrized
    malformed-FEN raises). All green.
  - `test_moves.py` — 10 tests (K, G, S, N, P, L, R, B empty-board
    moves + rook + bishop blocker scenarios). All green.
  - `test_legality.py` — 2 tests (king-into-check filter +
    unrelated-piece freedom). Both green.
  - `test_promotion.py` — 3 tests (forced pawn, optional silver,
    forced knight). All green.

### Integration tests

n/a — no integration surface in scope.

### Lint / typecheck

Not run. The brief does not require ruff/mypy; the repo has none
configured. Adding either is a candidate follow-up.

### Browser / Playwright

n/a — library only.

### Smoke scripts

n/a.

## Captured artifacts

- `qa/artifacts/pytest.txt` — full pytest -v output for the green run.
