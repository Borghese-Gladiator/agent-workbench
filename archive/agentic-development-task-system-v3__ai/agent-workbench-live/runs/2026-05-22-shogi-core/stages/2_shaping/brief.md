# Brief

<!--
Code-blind. Do not read the target repo. Convert raw-idea.md (+ answers.md) into
a high-quality spec.
-->

## Goal

Ship a minimal, well-tested Python rules core for Shogi (Japanese chess)
that a later run can extend with captures-to-hand, drops, and search.
This first pass is a clean, immutable board representation plus legal-move
generation for the seven base piece types (in both unpromoted and promoted
forms), promotion-zone logic, and a FEN-style serializer/parser.

## User-facing behavior

The deliverable is a Python package importable as `shogi` with a small
public surface:

- `shogi.Board.initial()` returns the standard starting position.
- `shogi.Board.from_fen(s)` / `board.to_fen()` round-trip a position.
- `board.legal_moves()` returns every legal `Move` for the side to move
  (drops excluded — out of scope this pass).
- `board.apply(move)` returns a new `Board` (immutable, no in-place mutation).
- `Move` is a dataclass: `from_sq`, `to_sq`, `promote: bool`.
- A `pytest` suite covers move generation per piece type, the king-into-check
  constraint, and FEN round-tripping.

No CLI, no GUI, no public web API. Library only.

## Acceptance criteria

1. `shogi.Board.initial().to_fen()` returns the canonical starting-position
   FEN (`lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1`).
2. `Board.from_fen(s).to_fen() == s` for every FEN the test suite generates.
3. For each of the seven piece types, `legal_moves()` returns the textbook
   move set from an empty board at d5 (5e in shogi notation), with no
   spurious moves and no missing moves.
4. Sliding pieces (R, B, L) stop at the first blocker; they may capture the
   blocker if it is an opposing piece, and may not pass through it.
5. The king may not move into a square attacked by any opposing piece.
   `legal_moves()` filters those candidates out.
6. Promotion is **optional** when a piece moves into the promotion zone
   (last three ranks for the moving side). It is **forced** when the
   piece would otherwise be stuck: pawn or lance on the last rank,
   knight on either of the last two ranks. `legal_moves()` reflects this.
7. `pytest` passes from the worktree root with `python -m pytest`.

## Non-goals

- Captures-to-hand and drop moves (next run).
- Check / checkmate detection beyond "king can't move into attacked square".
- Repetition / sennichite, perpetual check, impasse / jishogi.
- Any evaluation, search, or opening book.
- A CLI, REPL, GUI, or notation parser beyond FEN.
- Performance work. A naive `O(squares * piece_types)` move generator is
  fine for now.

## Good examples

- A standard-position pawn push: `P-7f` (file 7, rank f). `to_fen()` after
  apply reflects only that one pawn moving and side-to-move flipping.
- A bishop diagonal capture along an empty diagonal: blocker is an
  opposing pawn; `legal_moves()` contains the capturing move, contains no
  move past the captured square, and post-apply the captured square holds
  the bishop.
- A knight on the last rank: `legal_moves()` must not return a move that
  leaves it stuck. Either it doesn't move there, or it promotes on entry.

## Bad examples

- Returning a `legal_moves()` set that lets the king step onto an attacked
  square because we forgot to filter against `attackers_of(square)`.
- Mutating the input board inside `apply()` (the API is immutable).
- Allowing a sliding piece to leap over a blocker because the ray
  generator forgot to break at the first occupant.
- A FEN parser that silently tolerates extra ranks or a missing
  side-to-move token. Invalid FEN must raise.
- Promotion logic that promotes on entry into the zone regardless of
  source square — promotion is only legal when the move's *from* or
  *to* square is in the zone.

## Constraints

- Stdlib + `pytest` only. No `python-chess` analogues, no `numpy`.
- Python 3.10+ (match what `agent-workbench-live` itself targets).
- Board is immutable; `apply()` returns a new `Board`.
- `Move` is a `dataclass(frozen=True)`.
- One file per logical concern is fine; resist a deep package tree.

## Assumptions

- Side-to-move is encoded as `b` / `w` in FEN even though shogi
  traditionally uses 先手 / 後手. We use `b` (black / 先手) and `w`
  (white / 後手) for ASCII compatibility with the chess-FEN convention.
- Files numbered 1-9 from black's right (textbook convention); ranks
  a-i from black's far rank. FEN ranks are written from white's
  near rank to black's near rank (i.e. rank a first).
- "Last rank for the moving side" is rank i for white-moving and rank a
  for black-moving (which is the side's own promotion zone's deepest row).

## Suggested QA scenarios

1. **Round-trip FEN** — for a hand-picked set of ~10 positions, assert
   `from_fen(to_fen(p)) == p`.
2. **Empty-board piece sets** — drop one piece of each type at 5e on an
   empty board and snapshot `legal_moves()` against a hand-computed
   expected set.
3. **Blocker stop** — rook at 5e with a friendly pawn at 5g and an
   opposing pawn at 5b. Expected: rook moves cover 5d, 5c, 5b (capture);
   not 5a; and on the file the friendly side, only 5f.
4. **King in check** — black king at 5e, white rook at 5a, empty file.
   `legal_moves()` for black must not contain any move that leaves the
   king on the 5-file.
5. **Forced promotion** — black pawn at 8b moving to 8a: `legal_moves()`
   contains exactly one move, with `promote=True`.
6. **Optional promotion** — black silver at 7d moving to 7c (just
   entered the zone): `legal_moves()` contains two moves, one with
   `promote=False` and one with `promote=True`.
