# Implementation plan

## Current repo understanding

The target repo at `/tmp/aw-shogi/repo` will be created by
`agent-workbench start` from the new-repo monorepo scaffold (README.md,
docs/, backend/, frontend/). For a library-only Python deliverable we
treat the `backend/` directory as the home for the package and ignore
`frontend/`.

## Relevant files

- New: `backend/shogi/__init__.py` — public re-exports.
- New: `backend/shogi/types.py` — `Color`, `Piece`, `Square`, `Move` dataclasses.
- New: `backend/shogi/board.py` — `Board` immutable representation +
  initial / from_fen / to_fen / apply.
- New: `backend/shogi/moves.py` — pseudo-legal move generation per piece,
  blocker-aware sliders, promotion logic.
- New: `backend/shogi/legality.py` — king-into-check filter on top of
  pseudo-legal moves.
- New: `backend/tests/test_fen.py`
- New: `backend/tests/test_moves.py`
- New: `backend/tests/test_legality.py`
- New: `backend/tests/test_promotion.py`
- New: `backend/pyproject.toml` — minimal, sets `pytest` discovery to
  `backend/tests`. (`pip install -e backend` not required; tests run
  via `python -m pytest backend/tests` with `PYTHONPATH=backend`.)
- New: `README.md` at repo root — short library overview, run-the-tests
  recipe. The monorepo scaffold already gives us one; we extend it.

## Proposed changes

Build a tightly-scoped library under `backend/shogi/` exposing immutable
`Board` + `Move` and a `legal_moves()` generator. Tests cover the seven
piece types from an empty board, blocker behavior, FEN round-trip,
king-not-into-check, and promotion (optional vs. forced).

## Files likely to change

- `backend/shogi/__init__.py`
- `backend/shogi/types.py`
- `backend/shogi/board.py`
- `backend/shogi/moves.py`
- `backend/shogi/legality.py`
- `backend/tests/test_fen.py`
- `backend/tests/test_moves.py`
- `backend/tests/test_legality.py`
- `backend/tests/test_promotion.py`
- `backend/pyproject.toml`
- `README.md`

## Data model changes

- `Color` enum: `BLACK`, `WHITE`.
- `PieceType` enum: `K, R, B, G, S, N, L, P, +R, +B, +S, +N, +L, +P`
  (promoted gold-equivalents collapse where appropriate).
- `Piece` frozen dataclass: `(type, color)`.
- `Square` is an `int` 0..80 (rank*9 + file, file 0 = file 9 in shogi
  notation), wrapped in a `Square` newtype helper.
- `Move` frozen dataclass: `(from_sq: Square, to_sq: Square, promote: bool)`.
- `Board` frozen dataclass: `(squares: tuple[Piece|None, ...], side: Color, move_no: int)`.

## UI changes

None (library-only). The README documents `python -m pytest backend/tests`.

## Test plan

`backend/tests/`:

- `test_fen.py`
  - Initial-position FEN matches the canonical string.
  - Round-trip 10 hand-picked positions through `to_fen` / `from_fen`.
  - Malformed FEN raises `ValueError`.
- `test_moves.py`
  - For each of K, R, B, G, S, N, L, P (black), drop one piece on an
    empty board at 5e; assert the candidate-square set matches the
    textbook expectation.
  - Rook blocker scenario: friendly pawn at 5g, opposing pawn at 5b;
    expected ray = {5d, 5c, 5b, 5f}.
  - Bishop blocker scenario along the 1a-9i diagonal.
- `test_legality.py`
  - King-into-check filter: black king at 5e, white rook at 5a;
    `legal_moves()` contains no destination on the 5-file.
- `test_promotion.py`
  - Black pawn at 8b -> 8a: exactly one legal move, `promote=True`.
  - Black silver at 7d -> 7c: two legal moves, `promote ∈ {False, True}`.
  - Black knight at last-but-one rank: forced promotion when moving forward.

## QA plan

- `python -m pytest backend/tests -v` from the worktree root, with
  `PYTHONPATH=backend` exported.
- Record the command in `qa/commands.txt`, capture pytest output to
  `qa/artifacts/pytest.txt`, summarize counts in `qa/report.md`.

## Risks

- Shogi rule edge cases (promotion zone exact definition, knight's
  two-square move geometry) are easy to get subtly wrong. Tests cover
  the named cases; uncovered cases will be caught in a later run that
  adds drops.
- FEN convention for shogi is non-standard. We adopt the western
  `b`/`w` side token (see ASM-001) to avoid Unicode surprises.

## Definition of done

- All tests pass under `python -m pytest backend/tests`.
- `Board.initial().to_fen()` returns the canonical starting-position FEN.
- `Board` and `Move` are frozen dataclasses; `apply()` returns a new
  board without mutating the receiver.

## Preflight

- repo_path: /tmp/aw-shogi/repo
- repo_name: aw-shogi-repo
- base_ref: HEAD (new repo, single initial commit from scaffold)
- branch_name: agent/shogi-core
- worktree_name: shogi-core
- checks: target repo will be created by `start`; the monorepo scaffold
  provides `backend/`, which is where we land the package.

## Decisions & assumptions

### DR-001
- **Decision**: Use a flat `tuple[Piece|None, ...]` of length 81 for the
  board, indexed `rank*9 + file`.
- **Rationale**: Immutability is cheap (tuple), iteration is cache-friendly,
  the `Board` dataclass stays trivially hashable.
- **Alternatives considered**: dict keyed on `Square`; 2D nested tuples;
  bitboards per piece type.
- **Why not the alternatives**: dict is heavier and not order-stable for
  hashing; nested tuples make slicing rays awkward; bitboards are
  premature optimization for a rules-correctness pass.

### DR-002
- **Decision**: `Move.promote: bool` is a single field, not a separate
  `PromoteMove` subclass.
- **Rationale**: Promotion is a per-move decision, not a separate move
  kind. Move generation can yield both variants where promotion is
  legal-but-not-forced without type gymnastics.
- **Alternatives considered**: tagged union; separate iterator for
  promotion variants.
- **Why not the alternatives**: extra type surface for a one-bit choice;
  callers like `apply()` and FEN have to branch on the same bit anyway.

### DR-003
- **Decision**: `legal_moves()` filters by "king not into attacked square"
  but does NOT check for moves that leave the king in check from a
  discovered attack. Discovered-check filtering lands with the drops/
  full-check pass in a follow-up run.
- **Rationale**: Discovered-check filtering needs attacker enumeration
  from arbitrary squares, which is part of the full attack-map
  infrastructure that drops will need too. Bundle them.
- **Alternatives considered**: Implement the full pin/discovered-check
  filter now.
- **Why not the alternatives**: Scope. The brief explicitly excludes
  check/checkmate beyond "king can't move into attack."

### ASM-001
- **Text**: We use `b` and `w` for side-to-move in FEN, not 先手/後手.
- **Reason**: ASCII compatibility with chess-FEN conventions; agents
  parsing FEN strings won't need a Unicode-aware tokenizer.
- **Impact**: low.

### ASM-002
- **Text**: The new-repo monorepo scaffold lands `backend/` empty enough
  that we can place the package and tests at `backend/shogi/` and
  `backend/tests/` without colliding.
- **Reason**: The scaffold is documented as `README.md, docs/, backend/,
  frontend/`; it's a scaffold, not a populated app.
- **Impact**: medium — if `backend/` already contains a Python project,
  we have to nest under `backend/shogi/` regardless and add a
  `pyproject.toml` at a sub-level. Verified at build time.

### ASM-003
- **Text**: `pytest` is on the worktree's PATH (via the user's global
  Python environment); the run does not need a virtualenv.
- **Reason**: agent-workbench-live targets Python 3.10+ and the user's
  active env has pytest installed.
- **Impact**: low — if pytest is missing, QA logs the install command
  and the user installs.
