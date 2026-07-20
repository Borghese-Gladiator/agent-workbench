# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. Every AC in `brief.md` maps to a passing test (see the table in
`stages/4_building/build.md`). FEN round-trips, per-piece move sets match
the textbook expectations from 5e on an empty board, blockers stop sliders
correctly, the king cannot step into attack, and promotion is forced where
the piece would otherwise be stuck while remaining optional on simple zone
entry.

## Did it accidentally expand scope?

No. The implementation is intentionally narrow: no drops, no captures-to-
hand, no check/checkmate beyond "king cannot step into attack" (DR-003),
no CLI, no evaluation. The `apply()` API is immutable as specified.

The Files changed list (depth-1) lives entirely under `backend/`, which is
the brief's stated scope. The plan called out `backend/pyproject.toml`;
the implementation skipped it because the `conftest.py` `sys.path`
bootstrap removed the need for one. That's a planned deviation noted in
the build report.

## Are there fragile assumptions?

- `Color.opponent` is an `is` comparison (`Color.WHITE if self is Color.BLACK else Color.BLACK`). Fine for an enum but a future refactor that uses `Color(...)` constructors loosely could trip it. Low-risk because `Color` is a stdlib `Enum` and `is` is the idiom.
- The promoted-piece value strings (`"+R"`, `"+B"`, etc.) encode the FEN
  representation directly. If a downstream consumer wants USI / KIF
  notation, this is a forced conversion point — flagging as a future
  consideration, not a blocker.
- ASM-001 (using `b`/`w` instead of 先手/後手) is documented and tested
  via FEN round-trip — it's a deliberate scope-narrowing choice.

## Are there missing tests?

The build-report acknowledges that white-side per-piece move sets are
only verified through FEN round-tripping, not direct enumeration. That's
a fair coverage gap for a rules-correctness library. It is not blocking
because (a) the move geometry is parameterized on `Color` via a single
mirror function (`_apply_color`), so a black-side bug would manifest as a
visible asymmetry; and (b) the FEN round-trip catches any state-shape
divergence. Flag as a follow-up.

No tests for:

- The `Color.opponent` symmetry. Trivial; mostly type-system trust.
- `Board.empty()`. Constructor with no behavior — testing it would just
  re-state the implementation.

## Are there security / data loss / migration risks?

None. Library-only, no I/O, no state outside the immutable `Board`. The
FEN parser raises `ValueError` on bad input rather than silently producing
a broken board — that's the right boundary behavior.

## What should the human review first?

1. `backend/shogi/moves.py` — especially `_push_move` (promotion variant
   generation) and the dragon/horse handling in the slider section.
2. `backend/shogi/types.py::in_forced_promotion_zone` — the geometry is
   side-aware and easy to get wrong by an off-by-one.
3. `backend/tests/test_moves.py` — read the hand-computed expected sets
   against the textbook to spot any disagreement.

## Blast radius

depth 1 (changed files):
  backend/conftest.py
  backend/shogi/__init__.py
  backend/shogi/types.py
  backend/shogi/moves.py
  backend/shogi/legality.py
  backend/shogi/board.py
  backend/tests/test_fen.py
  backend/tests/test_moves.py
  backend/tests/test_legality.py
  backend/tests/test_promotion.py
  .gitignore

depth 2 (callers of changed symbols outside backend/):
  (none — this is a new package; nothing else in the repo imports `shogi`.)

depth 3:
  (n/a)

No cross-package callers exist; the entire change is contained inside
`backend/shogi/` plus its tests. Scope creep risk: zero.

## Findings

None blocking. The two soft items (white-side per-piece coverage,
follow-up for drops + discovered checks) belong in `follow-ups.md`, not
in this review's findings list.
