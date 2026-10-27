# Build report

## What changed

Implemented a minimal Shogi rules core under `backend/shogi/`: immutable
`Board`, `Move`, per-piece pseudo-legal move generation with blocker-aware
sliders, a king-into-check legality filter, optional/forced promotion logic,
and a FEN-style serializer that round-trips. Test suite under
`backend/tests/` covering FEN, per-piece move sets, the rook/bishop blocker
scenarios from the brief, king-into-check, and the three promotion cases.

## Files changed

- `backend/conftest.py` — adds `backend/` to `sys.path` so
  `python -m pytest backend/tests` works without an editable install.
- `backend/shogi/__init__.py` — public re-exports (Board, Move, Piece,
  PieceType, Color, sq + helpers).
- `backend/shogi/types.py` — Color, PieceType, Piece, Move dataclasses;
  promotion-map; square coordinate helpers (`sq`, `rank_of`, `file_of`,
  `in_promotion_zone`, `in_forced_promotion_zone`).
- `backend/shogi/moves.py` — pseudo-legal generation. Step lists for K,
  G, S, N, P; promoted minor pieces collapse to gold movement; sliders
  R, B, L use a `_ray` helper that stops at the first occupant.
  Promoted R / promoted B retain slider + add the orthogonal /
  diagonal steppers respectively.
- `backend/shogi/legality.py` — king-into-check filter via attacker
  enumeration on the post-move occupants.
- `backend/shogi/board.py` — immutable `Board` (frozen dataclass over a
  tuple of 81 `Piece|None`), `initial()`, `from_fen` / `to_fen`,
  `apply()`.
- `backend/tests/test_fen.py` — initial-FEN match + parametrized
  round-trip + malformed-FEN raises.
- `backend/tests/test_moves.py` — empty-board move sets per piece
  type from 5e; rook + bishop blocker scenarios.
- `backend/tests/test_legality.py` — king cannot step into rook's file;
  unrelated black pieces still move when king is safe.
- `backend/tests/test_promotion.py` — black pawn forced promote at
  last rank; black silver optional promote on zone entry; black knight
  forced promote at last-two ranks.
- `.gitignore` — `__pycache__`, `*.pyc`, `.pytest_cache`.

## Reviewer reading order

1. `backend/shogi/types.py` — read this first; everything else is
   built on these enums + dataclasses.
2. `backend/shogi/moves.py` — the meat of the rules. Pay attention to
   `_push_move` (promotion variant generation) and `_ray` (blocker
   logic). Promoted R / B handling is unusual — they get both the
   slider and the king-step set.
3. `backend/shogi/legality.py` — thin filter; the interesting bit is
   that we don't yet catch discovered checks (see DR-003).
4. `backend/shogi/board.py` — FEN parser and `apply()`. Look for
   off-by-one risks in FEN rank order.
5. `backend/tests/test_moves.py` — confirms expected move sets per
   piece. Hand-computed; easy to spot bugs by reading the expected
   sets out loud against the textbook.
6. `backend/tests/test_promotion.py` — verifies forced vs optional
   promotion behavior.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| 1. Initial FEN matches canonical | `test_fen.py::test_initial_position_fen_canonical` |
| 2. FEN round-trips for any from_fen output | `test_fen.py::test_round_trip_arbitrary` (parametrized over 7 positions) |
| 3. Per-piece move sets from empty board at 5e | `test_moves.py::test_*_moves_from_center*` (K, G, S, N, P, L, R, B) |
| 4. Sliders stop at first blocker | `test_moves.py::test_rook_blockers_capture_and_stop` + `test_bishop_blockers_capture_and_stop` |
| 5. King may not move into attack | `test_legality.py::test_king_cannot_step_into_attacked_square` |
| 6. Optional vs forced promotion | `test_promotion.py::test_black_pawn_at_last_rank_forces_promotion`, `..._silver_..._optional_...`, `..._knight_...` |
| 7. `python -m pytest backend/tests` passes | 30/30 green in first iteration |

## Deviations from plan

None of substance. The plan called for separate files for each AC; the
implementation collapses `test_fen` / `test_moves` / `test_legality` /
`test_promotion` into the natural concerns (one file per concern) as
planned.

## Known issues

- Discovered checks are not yet filtered (DR-003 — by design; lands with
  the drops pass).
- White (後手) symmetry has unit-test coverage only via the FEN
  round-trip; per-piece move set tests cover black only. Adding the
  mirror cases is a candidate follow-up.

## Commands run

```
python -m pytest backend/tests          # 30 passed
git add backend/shogi backend/tests backend/conftest.py .gitignore
git commit -m "feat(shogi): rules core ..."
git commit -m "chore: gitignore pycaches ..."
```

## Documentation touched

none needed — the change is internal-only and has no user-facing surface beyond the library API, which is documented inline via dataclass field names and the package docstring. A README upgrade lives with the follow-up that adds drops.
