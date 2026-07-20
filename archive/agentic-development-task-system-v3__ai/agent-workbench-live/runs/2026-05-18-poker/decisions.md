# Decisions

<!--
Every design/implementation choice made before or during the run.
One per heading. Each `decision_id` (DR-NNN) must also appear in `events.jsonl`
as a DecisionRecorded event.
-->

## DR-001

- **Decision**: Implement the poker game as a new top-level directory in the
  monorepo named `python-poker-first/`.
- **Rationale**: Matches the established `{tech}-first` naming convention used
  throughout `new-tech-monorepo`. Keeps the project self-contained, which is
  the repo's documented model (root README: "Navigate to a specific PoC,
  follow its README").
- **Alternatives considered**:
  (a) `poker-cli-first/`, (b) `texas-holdem-first/`, (c) Place under an
  `apps/` subdir.
- **Why not the alternatives**: (a) and (b) don't lead with the tech, which
  breaks the `{tech}-first` pattern. (c) — no `apps/` directory exists in
  the monorepo; every PoC is at root depth, and inventing structure not
  used by anyone else hurts discoverability.
- **Source artifact**: plan.md § Proposed changes

## DR-002

- **Decision**: Use Python 3.12 + Poetry, no other runtime or package
  manager.
- **Rationale**: Matches the closest existing precedent
  (`python-textual-first/`, `python-registry-first/`). Python's standard
  library has everything we need: `random` for shuffling, `dataclasses`,
  `enum`, `itertools.combinations` for best-5-of-7 selection,
  `unittest.mock` if needed. `pytest` covers testing.
- **Alternatives considered**: Rust, Go, Node/TypeScript.
- **Why not the alternatives**: Rust would compound risk (new language *and*
  poker logic) for no benefit; Go has no precedent here for CLIs/games; Node
  precedents exist but Python is closer to the documented "PoC" character
  of the repo and has more mature testing ergonomics for parameterized
  table-driven tests over hand-evaluation cases.
- **Source artifact**: plan.md

## DR-003

- **Decision**: Use a plain `print()` / `input()` CLI, not Textual or curses.
- **Rationale**: All acceptance criteria are pure-logic. The UI is a means to
  *play* the game; it is not what we are graded on. A plain CLI is harder to
  break, easier to test (capture stdin/stdout), and keeps the diff small.
- **Alternatives considered**: Textual TUI, curses, `rich`-based pretty
  output.
- **Why not the alternatives**: Textual is a heavy dep with a steep learning
  curve and a fully event-driven model — overkill for a turn-based game
  with at most ~10 visible elements. Curses is even harsher and OS-finicky.
  `rich` is nice but adds a dep with no AC-relevant benefit; if we want
  unicode card suits, plain `print()` can emit them too.
- **Source artifact**: brief.md § Constraints, plan.md § UI changes

## DR-004

- **Decision**: Hand evaluation evaluates the best 5 of all 7 cards by
  enumerating `C(7,5) = 21` combinations and taking the max-rank tuple.
- **Rationale**: Simplest correct algorithm. 21 combinations × ranking-cost
  per combination is trivial on modern hardware. No need for the bit-packed
  "TwoPlusTwo" lookup tables or hash-based fast evaluators — those optimize
  problems we don't have.
- **Alternatives considered**: TwoPlusTwo evaluator, custom flush/straight
  detector over the 7-card multiset, Cactus Kev's perfect-hash evaluator.
- **Why not the alternatives**: Premature optimization. Each is a ~200-line
  bug surface for a perceived ~milliseconds-per-hand speedup that doesn't
  matter for an interactive game.
- **Source artifact**: plan.md § Risks (R1)

## DR-005

- **Decision**: Represent player actions as a discriminated union:
  `Fold | Check | Call | Bet(int) | Raise(to_amount: int) | AllIn`.
  Validate via a single `legal_actions(state, player) -> set` function that
  the betting driver and the I/O prompt both call.
- **Rationale**: One source of truth for legality. Eliminates the
  "engine accepts an action the UI didn't offer" class of bug. Lets us
  unit-test legality independently of the I/O loop.
- **Alternatives considered**: Pass `(action_name: str, amount: int)` and
  scatter validation across the prompt and the resolver.
- **Why not the alternatives**: Validation drift. Easy to forget to update
  one of two locations when a rule changes (e.g. minimum raise size).
- **Source artifact**: plan.md § Proposed changes (betting.py)

## DR-006

- **Decision**: All RNG goes through a single `random.Random` instance owned
  by `Deck`, seedable via CLI flag `--seed`.
- **Rationale**: The brief requires deterministic-given-a-seed behavior for
  testability and bug reports. Centralizing the RNG ensures we don't
  accidentally fall back to global `random` state from another module.
- **Alternatives considered**: Use module-level `random.seed()` once at
  startup.
- **Why not the alternatives**: Module-level seeding leaks state into any
  other library that uses `random` (bots, UI shuffling, future code). An
  owned instance is safer.
- **Source artifact**: brief.md § Constraints (Deterministic given a seed)

## DR-007

- **Decision**: Isolate all I/O in `io.py`. The engine never calls `input()`
  or `print()`; it returns prompts as values and accepts actions as values.
- **Rationale**: Makes the engine 100% testable without mocking stdin/stdout
  and lets us write scripted-hand integration tests trivially (give the
  engine a list of `Action`s, assert the resulting state).
- **Alternatives considered**: Engine prints prompts directly; tests use
  `capsys` + `monkeypatch(input)`.
- **Why not the alternatives**: `monkeypatch(input)` works but is brittle
  and obscures what each test is asserting. The cost of one extra module
  boundary is tiny compared to the testability win.
- **Source artifact**: plan.md § Proposed changes

## DR-008

- **Decision**: Reject `--players` < 2 or > 6 at setup time (before any
  shuffle or deal), with a clear error message and a non-zero exit code.
- **Rationale**: The brief explicitly requires this (bad-examples lists
  "7-player game is accepted at setup, then crashes on the 7th seat" as a
  bug). Failing fast keeps the engine simple — it can assume `2 ≤ n ≤ 6`
  everywhere internally.
- **Alternatives considered**: Allow any count and only complain when
  seating exceeds available logic.
- **Why not the alternatives**: Engine code would have to guard against
  out-of-range player counts in many places; better to enforce the
  invariant at the boundary.
- **Source artifact**: brief.md § Acceptance criteria, brief.md § Bad examples
