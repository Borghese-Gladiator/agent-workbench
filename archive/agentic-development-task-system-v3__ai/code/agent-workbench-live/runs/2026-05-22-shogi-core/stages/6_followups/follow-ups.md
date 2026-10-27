---
title: White-side per-piece move-set tests
motivation: The current `test_moves.py` only verifies black-side move sets directly; white symmetry rides on FEN round-trip and the `_apply_color` mirror. A subtle bug in the mirror would not surface in a black-only suite.
suggested_scope: Add a parametrized companion to `test_moves.py` that drops each piece type at 5e as WHITE on an empty board and asserts the mirrored expected set. Reuse the same expected-set helpers; flip rank coordinates via a single helper. In scope = move-set tests for white K/G/S/N/P/L/R/B plus mirrored rook/bishop blocker scenarios. Out of scope = anything beyond move generation.
category: tech_debt
---

White-side coverage gap noted in `review.md`. A small parametrized suite
closes it in well under a day.

---
title: Drops and captures-to-hand
motivation: The brief explicitly deferred drops to the next run; without them the engine can't represent a real shogi game. This is the largest pending step toward a usable rules core.
suggested_scope: Implement `Hand` (per-color multiset of unpromoted piece types), capture-to-hand on `apply()`, drop-move generation with the standard restrictions (nifu, uchifuzume, no last-rank pawn/lance/knight drops), and the FEN hand field. In scope = drop legality + capture mechanics + FEN hand serialization. Out of scope = repetition / sennichite / impasse.
category: scope_extension
---

This is the natural next bite. DR-003 in the plan already flagged that
attack-map infrastructure would be shared between drops and full-check
filtering.

---
title: Discovered-check filter
motivation: Per DR-003 we only filter "king cannot step into attack". A discovered check from a pinned piece moving aside is currently legal in `legal_moves()`. The brief allowed this for now, but it's a sharp corner that will bite the moment we add search.
suggested_scope: Add an attack-map computation parameterized on "with this piece removed from square X", build a post-move attacker enumeration, and reject any move that leaves own king in attack from any opposing piece. Cover with tests for: rook pin along a file/rank, bishop pin along a diagonal, lance pin, multi-piece pin. In scope = the legality filter + tests. Out of scope = checkmate detection.
category: bug_risk
---

Lands naturally alongside drops because both need the same attack-map
infrastructure.

---
title: USI / KIF notation
motivation: FEN is fine for testing but every real shogi tool (Shogidokoro, ShogiGUI, USI engines) speaks USI move notation and / or KIF position notation. Without one of them this library is hard to interop with the ecosystem.
suggested_scope: Add `Move.to_usi()` / `Move.from_usi(b)`, `Board.to_usi_position()`. Out of scope for the first pass = KIF; out of scope = engine protocol — just the notation.
category: scope_extension
---

Low-risk, high-payoff. The board-to-board conversion is already FEN; this
is mostly a serialization layer on top.

---
title: Ruff + mypy
motivation: The repo has no lint or typecheck. The shogi package has many type hints already; we should enforce them. A future run touching `moves.py` would benefit greatly.
suggested_scope: Add `ruff` + `mypy` configs at the worktree root, fix any baseline findings, wire them into `qa/commands.txt` so future validate passes run them. In scope = config + clean baseline. Out of scope = strict mode if it produces > 20 baseline findings (defer).
category: tech_debt
---

Cheap; pays off the moment someone refactors `_push_move` or the slider
section.
