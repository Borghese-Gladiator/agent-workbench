# Shogi rules core

A minimal Shogi (Japanese chess) engine in Python.

Scope:
- 9x9 board state with the seven base piece types (K, R, B, G, S, N, L, P)
  in both promoted and unpromoted forms.
- Legal move generation per piece, including blockers along sliding rays for
  R/B/L.
- Promotion: optional in the promotion zone (last three ranks for the moving
  side), forced when the piece would otherwise have no legal move (P/L on
  the last rank, N on the last two ranks).
- A FEN-style string serializer/parser for board state + side-to-move.
- A small property-test suite (Hypothesis or hand-rolled) covering:
  - king isn't allowed to move into check
  - sliding pieces stop at the first blocker
  - promotion forced/optional cases

Out of scope for this first pass:
- Captures-to-hand and drops.
- Check / checkmate detection beyond "king can't move into attacked square".
- Any AI or evaluation.
- A CLI or GUI.

The deliverable is a clean rules core that a later run can extend with drops
and search.
