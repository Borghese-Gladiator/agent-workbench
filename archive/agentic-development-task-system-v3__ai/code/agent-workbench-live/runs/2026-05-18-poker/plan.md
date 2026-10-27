# Implementation plan

> **V2 update (2026-05-18):** the V1 plan below describes what was shipped
> and bounced. V2 reuses V1's engine modules and adds a FastAPI server +
> React/Vite frontend. The V2 plan section is at the bottom of this file
> under "## V2 plan".

<!-- May read the target repo. May not ask the human questions. -->

## Current repo understanding

`new-tech-monorepo` is a **flat, ungoverned PoC playground**: ~51 independent
project directories live at the repo root with no workspace manifest (no
Cargo.toml / pyproject.toml / package.json at root), no monorepo build runner,
no CI, and no shared lint/test gate. The root README explicitly says: "Clone.
Navigate to a specific PoC. Follow the instructions in the corresponding
README.md."

Notable existing precedent for our use case:

- `python-textual-first/` — Python 3.12+, Poetry, single `main.py`, depends on
  `textual`. Demonstrates the accepted shape of a Python TUI PoC in this repo.
- `python-registry-first/` — Python with a `tests/` directory, plugin layout,
  `runner.py`. Demonstrates per-project testing structure.
- `doom-fps__ai/` — game PoC, but Node-based.

There are **no shared libraries** to integrate with. There is **no CI** to
satisfy. The only repo-wide infrastructure is `.beads/` (issue tracking) and
its associated git hooks, which validate commit messages but do not gate
correctness.

This is the easiest possible drop-in environment: pick a directory name
matching the `{tech}-first` convention, add a self-contained project with its
own pyproject.toml, README, source, and tests, commit.

## Relevant files

In the **target repo** (`/Users/timothy.shee/GitHub/new-tech-monorepo/`):

- `README.md` — repo-wide intro; nothing to change.
- `.beads/config.yaml` and `.git/hooks/*` — pre-commit will fire when we
  commit inside the worktree; expected behavior, not a blocker.
- `python-textual-first/pyproject.toml` — reference for our pyproject layout
  (Poetry, Python ≥3.12, `[tool.poetry.group.dev.dependencies]`).
- `python-registry-first/tests/` — reference for tests directory layout.

In the **workbench repo** (this one):

- `runs/2026-05-18-poker/brief.md` — the spec we are implementing.
- `runs/2026-05-18-poker/raw-idea.md` — original ask.

## Proposed changes

Create a new top-level directory in the target monorepo:

```
new-tech-monorepo/
└── python-poker-first/
    ├── README.md
    ├── pyproject.toml
    ├── poker/
    │   ├── __init__.py
    │   ├── __main__.py         # entry point: `python -m poker`
    │   ├── cards.py            # Card, Rank, Suit, Deck (with seeded shuffle)
    │   ├── hand_eval.py        # evaluate 7-card best-5 hand; rank categories
    │   ├── pot.py              # main pot + side pots; payout distribution
    │   ├── betting.py          # legal-actions engine + betting round driver
    │   ├── game.py             # high-level Game / Hand state machine
    │   ├── players.py          # Player dataclass, seating, button rotation
    │   ├── io.py               # all terminal I/O (prompts, screen clear, render)
    │   └── cli.py              # argparse setup; wires args → Game
    └── tests/
        ├── __init__.py
        ├── test_cards.py
        ├── test_hand_eval.py   # all 9 categories + wheel + tie kickers
        ├── test_pot.py         # split pots, odd-chip rule, side pots
        ├── test_betting.py     # action order, legal-action filter, fold-skip
        └── test_game.py        # end-to-end scripted hands, deterministic seed
```

**Why the I/O layer is isolated:** the acceptance criteria are all pure-logic
(deal, betting, ranking, player bounds). The interactive terminal flow is
necessary to play but should not be entangled with the engine. `io.py` is the
only module that touches `input()` / screen-clearing.

**Why a single Python package, not multiple:** correctness over polish. One
package, one entry point, one test suite.

## Files likely to change

All new. No existing files in the target repo are modified.

Within the worktree:
- `python-poker-first/` (new directory, ~10 source files, ~5 test files).

## Data model changes

No DB, no persistence — but the in-process model:

- `Suit` enum: `CLUBS, DIAMONDS, HEARTS, SPADES`.
- `Rank` enum: `TWO … ACE`, with `Rank.value` mapping to 2..14.
- `Card`: frozen dataclass of `(rank, suit)`. Hashable.
- `Deck`: list of 52 `Card`, `shuffle(seed: int | None)`, `deal(n) -> list[Card]`.
- `HandRank`: enum / int representing the 9 categories (HIGH_CARD..STRAIGHT_FLUSH);
  evaluation returns a comparable tuple `(category, tiebreakers...)`.
- `Player`: `name, stack, hole_cards, has_folded, is_all_in, current_bet`.
- `Pot`: `main_amount` plus list of side-pot dicts
  `{amount, eligible_player_ids}`.
- `GameState`: button index, blinds, players, deck, board, pot, street.
- `Action`: tagged union `Fold | Check | Call | Bet(amount) | Raise(to_amount) | AllIn`.

## UI changes

Pure terminal I/O:

- On a player's turn:
  1. Clear screen (`os.system('clear')` or ANSI escape).
  2. Show: `Player <name>'s turn. Press Enter to continue…` (privacy gate).
  3. Render: community board, pot, this player's stack + hole cards,
     current bet to call, legal actions.
  4. Prompt: `Action [F/C/K/B/R/A] (amount): `.
- Illegal actions: print a clear message, re-prompt; do not advance state.
- Between hands: show end-of-hand summary (winner(s), pot delta).
- End of game: show final standings.

No curses. No animation. Plain `print()` and `input()`.

## Test plan

**Unit tests (pytest):**

- `test_cards.py` — 52 unique cards; seeded shuffle is deterministic; `deal(n)`
  removes from top; `deal(53)` raises.
- `test_hand_eval.py` — parameterized over hand strings:
  - Each of the 9 categories beats every lower category.
  - Royal flush beats straight flush (king-high) beats all flushes.
  - Wheel `A-2-3-4-5` ranks as 5-high straight, beats `K-high`, loses to
    `6-high straight`.
  - Tie kickers: pair-of-aces with `K` kicker beats pair-of-aces with `Q`
    kicker.
  - Best-5-of-7 selection: a board paired flush correctly resolves to flush
    not full house.
- `test_pot.py` — split pots with even and odd amounts; odd-chip rule;
  side-pot creation when one player is all-in for less.
- `test_betting.py` — legal-action filter (can't check when there's a bet;
  can't raise less than min raise); fold removes player from rotation;
  round ends when all non-folded match or are all-in.
- `test_game.py` — end-to-end scripted hands with seeded RNG and a list of
  pre-canned actions; assert final stacks and pot location. Includes all 12
  QA scenarios from `brief.md` as test cases.

Run with `poetry run pytest` from `python-poker-first/`.

## QA plan

A human runs through the 12 scenarios listed in
`brief.md § Suggested QA scenarios`. The QA report records pass/fail per
scenario, plus a smoke test:

- 4-player game, mix of fold/call/raise, run to showdown, verify chip totals.
- 2-player heads-up, verify pre-flop SB-acts-first and post-flop BB-acts-first.
- Invalid setup: player count 1 and 7 are rejected at setup with a clear
  error.

## Risks

- **R1: Hand evaluator correctness.** The most failure-prone module. Mitigation:
  exhaustive parameterized tests covering every category and the wheel.
- **R2: Side-pot edge cases.** Multi-way all-ins of different sizes are
  notoriously easy to mis-implement. Mitigation: explicitly scope this as
  "best-effort, no chips created/destroyed" per `brief.md § Non-goals`; one
  unit test asserts the simple two-pot case.
- **R3: Betting-round termination logic.** "Round ends when all active
  players have matched the current bet OR are all-in" is subtle (a raise
  re-opens action). Mitigation: explicit state machine with per-round
  `last_aggressor` and `to_act` set.
- **R4: Pass-and-play hole-card leakage.** A bug where the screen-clear fails
  silently could leak hole cards between players. Mitigation: the privacy
  gate (`Press Enter to continue` before AND after each player's turn) makes
  this hard to mishandle.
- **R5: Beads pre-commit hook noise.** The monorepo's pre-commit hook fires
  on commits in the worktree (per the user's earlier handoff note). Expected,
  not blocking, but slow commits.

## Definition of done

1. All 4 acceptance criteria in `brief.md` are demonstrably met.
2. `poetry run pytest` is green inside `python-poker-first/`.
3. All 12 QA scenarios from `brief.md` pass when manually exercised
   (recorded in `qa/report.md` during the validate phase).
4. `README.md` in `python-poker-first/` documents:
   - How to install (`poetry install`).
   - How to run (`poetry run python -m poker --players 4 --seed 42`).
   - How to test (`poetry run pytest`).
   - Known limitations (no online, no GUI, side-pot caveats).
5. No edits to any other directory in `new-tech-monorepo/`.
6. Branch `agent/poker` contains commits with a meaningful history (not one
   giant squash).

---

## V2 plan

### Repo understanding (delta from V1)

The V1 implementation in `python-poker-first/` is intact on `agent/poker`.
Modules to reuse unchanged: `cards`, `hand_eval`, `players`, `actions`,
`pot`, `betting`. Module to refactor: `game.py` — its generator-based
`play_hand` yields synchronously, which doesn't compose with
`await ws.receive()`. We will keep the generator for the CLI smoke path
but add a new `engine.py` that wraps the betting state machine in a
purely-data step API (`request_action(seat) -> ActionRequest` and
`submit_action(seat, action) -> StateUpdate`) so an async server can
drive it.

Frontend precedent in monorepo: `react-vite-first/` (React, Vite, TS).
Backend precedent: `fastapi-hugging-face/` (FastAPI).

Local tooling available: node v22, poetry, pyenv 3.12.9.

### Proposed changes

Extend the project to:

```
python-poker-first/
├── poker/                       # V1 engine (kept)
│   ├── cards.py                 # kept
│   ├── hand_eval.py             # kept
│   ├── players.py               # kept
│   ├── actions.py               # kept
│   ├── pot.py                   # kept
│   ├── betting.py               # kept
│   ├── game.py                  # kept (CLI smoke path)
│   ├── io.py                    # kept (CLI smoke path)
│   ├── cli.py                   # kept (CLI smoke path)
│   ├── engine.py                # NEW: data-driven hand stepper for server use
│   └── room.py                  # NEW: Room model (players, seats, settings, state)
├── server/                      # NEW
│   ├── __init__.py
│   ├── app.py                   # FastAPI app, static mounts, REST endpoints
│   ├── ws.py                    # WebSocket connection + per-room broadcast hub
│   ├── protocol.py              # pydantic models for client/server messages
│   ├── room_manager.py          # in-memory dict of room_code -> Room
│   └── views.py                 # build per-player public view (strips others' hole_cards)
├── web/                         # NEW (Vite + React + TS)
│   ├── package.json
│   ├── vite.config.ts           # proxies /ws and /api to localhost:8000
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx              # router: '/' (landing) vs '/r/:code' (room)
│       ├── Landing.tsx          # "Create room" button
│       ├── Lobby.tsx            # join + lobby UI + settings + Start button
│       ├── Table.tsx            # board, seats, hole cards, action panel
│       ├── ActionPanel.tsx      # Fold/Check/Call/Bet/Raise/All-in
│       ├── useRoomSocket.ts     # websocket hook
│       ├── types.ts             # mirror of server's protocol.py
│       └── styles.css           # plain CSS, no UI lib
└── pyproject.toml               # ADD fastapi, uvicorn[standard], websockets, pydantic, httpx (test)
```

### Server design

**Transport.**
- One websocket per browser tab. URL: `/ws/<room_code>?nickname=Tim`.
- Client→server messages: `{type: "join" | "leave" | "start_hand" |
  "action", ...payload}`.
- Server→client messages: `{type: "lobby_state" | "hand_state" |
  "error" | "kicked", ...payload}`.

**Per-player view.**
- After every state change, server sends each connected client a
  *personalized* `hand_state` payload built by `views.player_view`.
- That function strips other seats' `hole_cards` to `null` until either
  showdown reveals them or the player has folded so their cards don't
  matter. Only the recipient's own seat carries the real cards.
- AC-3 lives or dies here. The test for it inspects the *raw* websocket
  frame received by a non-actor client.

**Identity.**
- Identity = `(room_code, nickname)`. No tokens for V2. The websocket URL
  carries the nickname as a query string. The server enforces uniqueness
  per room.
- A reconnecting client (same room, same nickname) takes over the
  previous connection. If a hand is in progress and the client is mid-
  hand, they remain auto-folded for that hand but their seat survives.

**Concurrency model.**
- All room mutations go through `asyncio.Lock` per room. The engine
  itself is sync and fast; the lock serializes WS handlers.

**Action handling.**
- Server receives `{type: "action", ...}` on the WS.
- Validates: connection's seat == current actor seat.
- Calls `engine.submit_action(room, seat, action)`.
- Broadcasts new `hand_state` to all room subscribers (personalized
  per recipient via `views.player_view`).

**Hand progression.**
- Engine is data-driven: after `submit_action`, the engine internally
  advances streets and updates `current_actor`. If `current_actor` is
  `None` and `street != showdown`, the next street is auto-dealt.
- When `street == showdown`, server emits `hand_result` with revealed
  hands and payouts, waits for all `next_hand` ack messages (or a
  timeout), then starts the next hand.
- Disconnect handler auto-folds the player and re-triggers the next-actor
  check.

**Tunnel compatibility.**
- Uvicorn launched with `--forwarded-allow-ips=*` and
  `--proxy-headers`. WebSocket frontend uses `window.location` to derive
  ws URL — `ws://` if `http`, `wss://` if `https`.

### Frontend design

**State.**
- One `useRoomSocket` hook owns the WS. It exposes `(lobbyState |
  handState, sendAction)`. No Redux/Zustand.

**Routing.**
- `/` → Landing (button creates a room via `POST /api/rooms`, then
  navigates to `/r/<code>`).
- `/r/<code>` → joins WS, shows Lobby until host starts, then Table.

**Components.**
- `Landing`: one button + room code input + nickname memory in
  `localStorage`.
- `Lobby`: nickname prompt (modal), player list, settings form (host
  only), copy-link button, Start button (host only, gated on ≥2
  players).
- `Table`: shows community board, pot, seats with stacks and chip-in-front,
  and the recipient's own hole cards in a dedicated panel. Highlights the
  current actor. Shows "P3 is thinking…" when it's not your turn.
- `ActionPanel`: action buttons; for Bet/Raise, a numeric input clamped
  to legal range; disabled when not current actor.

**Styling.**
- Plain CSS. Cards as `<span class="card hearts">A♥</span>`.

### Files likely to change

- All new code in `python-poker-first/server/`, `python-poker-first/web/`,
  and two new modules in `python-poker-first/poker/`.
- `python-poker-first/pyproject.toml` — add server deps (fastapi,
  uvicorn[standard], websockets, pydantic, httpx for tests, pytest-asyncio).
- `python-poker-first/README.md` — V2 quickstart, add a `poker-server`
  section, document the cloudflared recipe.

### Data model changes

In-process only:
- `Room`: code, settings, list of `Seat`, `engine.HandState | None`,
  `asyncio.Lock`, set of WS connections.
- `Seat`: nickname, stack, eliminated, websocket (`WeakRef`-ish, may be
  None if disconnected).
- `protocol.ClientMessage` / `protocol.ServerMessage`: pydantic
  discriminated unions for type-safe WS payloads.

### UI changes

Entire UI is new. No terminal UI is touched. The V1 CLI continues to work
for smoke testing the engine.

### Test plan

**Backend unit tests** (pytest):
- `test_engine.py` — the new data-driven engine API: request_action,
  submit_action, state transitions; mirrors the V1 game.py invariants but
  uses the new API.
- `test_views.py` — `player_view` strips other seats' hole_cards
  pre-showdown and reveals them at showdown for non-folded seats.
- `test_room.py` — Room lifecycle, duplicate-nickname rejection,
  player-count cap, disconnect → auto-fold.
- `test_protocol.py` — pydantic discriminated unions parse correctly.

**Backend integration tests** (FastAPI `TestClient` + `httpx`):
- `test_api.py` — `POST /api/rooms` creates a code; `GET /api/rooms/{code}`
  returns lobby state.
- `test_ws.py` — open two WS connections, simulate join + start + a few
  actions. Assert per-client frames have the right `hole_cards`
  scrubbing. AC-3 lives here.

**Frontend tests**:
- TypeScript `tsc --noEmit` for type safety. If time permits, one
  Vitest test for `useRoomSocket` reducer logic.

**Manual QA recipe** (recorded, not executed in this run beyond
spot-checks):
- Open `localhost:8000` in two browsers. Run scenarios 1-12 from
  brief-v2.

### QA plan

Per ASM-013, **no network simulation**. QA stays on localhost:

1. `pytest` — full suite (V1 + V2). All pass.
2. `tsc --noEmit` in `web/` — type-clean.
3. `uvicorn server.app:app` starts cleanly, `curl localhost:8000`
   returns the page.
4. Documented manual recipe in `handoff.md` for the human to walk
   through scenarios 1-12.

### Risks

- **R6: Generator → async refactor breaks engine semantics.** Mitigation:
  port `_run_betting_round` to a data-driven `Engine.step()`; preserve V1
  pytest suite as a regression gate.
- **R7: Per-player view filter is the only thing standing between cards
  and leakage.** Mitigation: AC-3 test inspects raw websocket frames, not
  parsed game state. Server-side `views.player_view` is the single place
  the filter lives.
- **R8: WS reconnection + state replay is subtle.** Mitigation: V2 scope
  says "mid-hand disconnect = auto-fold, rejoin between hands OK". This
  drops the complexity floor; we don't have to replay or merge state.
- **R9: Frontend won't build/run if `npm install` fails for any reason.**
  Mitigation: lockfile committed; README documents `node >=20`. If `npm
  install` fails in this session, ship the source + types and mark
  frontend QA as "static review only".

### Definition of done (V2)

1. All 6 V2 acceptance criteria demonstrably met.
2. Backend `pytest` is green and includes a test for AC-3 that inspects
   websocket frames.
3. Frontend `tsc --noEmit` is clean.
4. `uvicorn server.app:app --host 0.0.0.0 --port 8000` starts, serves
   the built frontend at `/`, and the page loads in a browser.
5. README documents the cloudflared recipe. Server is documented as
   "designed for tunneling, tunneling itself is the user's
   responsibility, not tested in this run".
6. V1 acceptance criteria still hold — V1 `pytest` suite is still 58
   passing.
7. Branch `agent/poker` has additional commits with meaningful history.

