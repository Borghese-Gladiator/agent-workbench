# Assumptions

<!--
Every assumption the agent made instead of asking the human.
One per heading. Each `assumption_id` must also appear in `events.jsonl` as an
AssumptionRecorded event.
-->

## ASM-001

- **Text**: The poker variant is no-limit Texas Hold'em.
- **Reason**: The raw idea just says "poker"; Hold'em is the default modern
  reading and is the variant whose rules every player recognizes.
- **Impact**: Determines hole-card count (2), betting structure (no-limit),
  street count (pre-flop / flop / turn / river), and the 9-category hand
  ranking. Changing this assumption would invalidate most of the data model.
- **Source artifact**: brief.md

## ASM-002

- **Text**: V1 is local-only (single machine, pass-and-play or vs. bots), not
  networked.
- **Reason**: The raw idea says "local or online"; online is explicitly listed
  as a non-goal in `brief.md` because adding sockets/server/auth would push
  the run well beyond scope.
- **Impact**: No server, no transport layer, no auth, no session state. Drops
  the complexity of the project roughly an order of magnitude.
- **Source artifact**: brief.md

## ASM-003

- **Text**: The UI is a plain terminal CLI (stdin/stdout), not a TUI
  framework like Textual or curses.
- **Reason**: The acceptance criteria are all logic-correctness criteria.
  Polish is explicitly de-prioritized in the brief (`Correctness over polish`
  in Constraints). A plain CLI removes a whole class of UI bugs and lets us
  spend the effort on the engine.
- **Impact**: No Textual dependency despite the precedent set by
  `python-textual-first/`. We get standard `print()` / `input()` only. Output
  is monospace ASCII.
- **Source artifact**: brief.md, plan.md § UI changes

## ASM-004

- **Text**: Python 3.12+ is available on the target machine.
- **Reason**: Matches the precedent set by `python-textual-first/`
  (`requires-python = ">=3.12,<4.0.0"`). We get pattern matching, `Self`
  type, `@dataclass(slots=True, kw_only=True)`, etc.
- **Impact**: We use Python-3.12-isms freely. If the target machine has only
  3.10 or 3.11, the user must install 3.12 (Poetry will refuse).
- **Source artifact**: plan.md

## ASM-005

- **Text**: Poetry is acceptable as the dependency manager.
- **Reason**: Both relevant Python precedents in `new-tech-monorepo`
  (`python-textual-first/`, `python-registry-first/`) use Poetry. This is the
  established convention.
- **Impact**: Project ships with `pyproject.toml` + `poetry.lock`. Users run
  `poetry install` / `poetry run pytest`. No `pip install -r requirements.txt`.
- **Source artifact**: plan.md

## ASM-006

- **Text**: Bots are optional and may use trivial strategy ("always call" or
  "random legal action") if implemented.
- **Reason**: The brief explicitly scopes meaningful AI out
  (`Non-goals § No AI opponents with meaningful strategy`). The 2-6 player
  range is achievable with humans pass-and-play; bots are only there as a
  convenience for solo testing.
- **Impact**: We will implement a `RandomBot` (random legal action). Humans
  remain the primary playmode.
- **Source artifact**: brief.md

## ASM-007

- **Text**: Default blinds are 1/2 and default starting stack is 200 chips,
  configurable via CLI args.
- **Reason**: The brief calls these out as defaults under `Assumptions`. A
  100×BB starting stack is conventional.
- **Impact**: Out-of-the-box `poker --players 4` plays a recognizable game.
  Users can override with `--small-blind`, `--big-blind`, `--stack`.
- **Source artifact**: brief.md

## ASM-008

- **Text**: Side-pot correctness is required for the simple two-pot case
  (one all-in for less); exotic multi-way all-in edge cases are best-effort.
- **Reason**: The brief explicitly scopes 3+ simultaneous all-ins as
  "best-effort, no chips created/destroyed". Spec-perfect multi-way side
  pots are a well-known rabbit hole.
- **Impact**: We implement and test the canonical case. Multi-way all-in
  uses a "sort by stack, peel layers" algorithm that should be correct, but
  we don't claim guaranteed correctness for every permutation.
- **Source artifact**: brief.md
