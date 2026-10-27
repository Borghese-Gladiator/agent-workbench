# Implementation summary

> This run shipped twice. V1 (terminal-only) was bounced for change request;
> V2 adds browser multiplayer on top of the V1 engine. Both halves of the
> implementation live on branch `agent/poker`.

## What changed

V1 (commits `699be1b`..`f391fda`) added a self-contained Texas Hold'em PoC
to `new-tech-monorepo/python-poker-first/`. Pure Python, terminal-only,
pass-and-play.

V2 (commits `ab610ee`..`70310b7`) layers browser multiplayer on top:

- A new `poker.engine.HandEngine` provides the same betting state machine
  as V1's generator-based `play_hand`, but as a data API
  (`current_actor`, `legal_actions()`, `submit_action(seat, action)`,
  `advance_street()`, `fold_seat(seat)`). The V1 engine modules (`cards`,
  `hand_eval`, `pot`, `betting`, `players`, `actions`) are unchanged.
- A new `server/` FastAPI app with REST + WebSocket endpoints, an
  in-memory room manager, and a per-recipient view filter that strips
  other players' hole_cards.
- A new `web/` React + Vite + TS frontend (Landing, Lobby, Table,
  ActionPanel, HandResult).
- The V1 CLI (`poker.cli`, `poker.io`, `poker.game`) is intact and still
  works as a smoke harness.

## Files changed

Total branch: **47 new files, 2 modified** vs. master.

V1 (already covered in the previous validate cycle): 19 new files,
2004 LOC.

V2 adds: 28 new files, ~2080 LOC.

- `python-poker-first/.gitignore` — keeps `node_modules/`, `dist/`,
  `__pycache__/`, `poetry.lock` out of git.
- `python-poker-first/pyproject.toml` (modified) — bumps to 0.2.0,
  adds fastapi, uvicorn, websockets runtime deps and httpx,
  pytest-asyncio dev deps. Adds `poker-server` console script and
  registers the `server` package.
- `python-poker-first/README.md` (modified) — V2 quickstart, cloudflared
  recipe, project layout, known limitations.
- `python-poker-first/poker/engine.py` — data-driven hand engine.
- `python-poker-first/server/{__init__,protocol,room,views,app}.py` —
  the server package.
- `python-poker-first/tests/test_engine.py` — 7 tests for the engine.
- `python-poker-first/tests/server/{__init__,test_room,test_views,test_api,test_ws}.py` —
  25 server tests (10 + 4 + 5 + 6).
- `python-poker-first/web/{package.json,vite.config.ts,tsconfig.json,index.html}`
- `python-poker-first/web/src/{main,App,Landing,Room,Lobby,Table,types,useRoomSocket}.tsx/.ts` plus `styles.css`.

## Acceptance criteria coverage

### V1 criteria (still hold — non-regression)

| AC | Where covered | Status |
|----|----------------|--------|
| Deal cards | `poker.cards`, V1 tests | ✅ unchanged |
| Manage betting rounds | `poker.betting` + new `poker.engine`, V1 + V2 engine tests | ✅ unchanged |
| Determine winner by hand ranking | `poker.hand_eval`, V1 tests | ✅ unchanged |
| Support 2-6 players | `poker.cli` + `server.room.Room` enforces at lobby | ✅ unchanged in CLI; mirrored in server (`max_players` setting) |

### V2 criteria (from brief-v2.md)

| AC | Implementation | Tests |
|----|----------------|-------|
| **Create + join via link** | `POST /api/rooms` returns 6-char code; SPA route `/r/<code>`; WS `/ws/<code>?nickname=...`. | `test_api.py::test_create_room_returns_code`, `test_ws.py::test_ws_join_and_lobby_state`. End-to-end verified manually in Playwright (lobby renders, code in URL). |
| **Lobby and start** | `server.room.Room.start_hand` enforces host-only and `2 ≤ players ≤ max`. SPA `Lobby.tsx` Start button gated on `can_start`. | `test_room.py::test_only_host_can_start`, `test_can_start_requires_two_players`, `test_invalid_player_count_blocks_start`. WS: `test_ws_start_hand_only_by_host`. |
| **Per-player private state** | `server.views.hand_view` returns null `hole_cards` for non-recipient seats unless showdown. | `test_views.py::test_hand_view_reveals_only_recipient_cards_preshowdown` and **`test_ws.py::test_ws_ac3_hole_card_secrecy_in_raw_frame`** — the latter inspects the literal WS frame Alex receives and asserts Tim's `hole_cards` is `null`. |
| **Correct game flow (V1 non-regression)** | V1 engine modules unchanged; V1 pytest suite unchanged. | All 58 V1 tests still pass. New `HandEngine` mirrors V1 invariants — 7 new tests verify same semantics. |
| **Action turn enforcement** | `server.app.handle_message` checks `eng.current_actor == seat_idx` before calling `submit_action`; spoofs get an error frame. | `test_ws.py::test_ws_spoofed_action_rejected` — Alex tries to act while it's Tim's turn, gets an error frame and the engine state is untouched. |
| **Internet-shareable** | Uvicorn launched with `--proxy-headers --forwarded-allow-ips='*'`. Frontend derives WS URL from `window.location` (so `wss://` when served over HTTPS). README documents the cloudflared one-liner. | **Not exercised in QA per user instruction** (ASM-013: no network simulation). Server design is documented as tunnel-compatible. |

## Deviations from plan

- **Per-recipient view filter is implemented in plain dicts**, not pydantic
  models. The brief-v2 plan listed pydantic as a dep; we chose a lighter
  approach with TypedDicts and `parse_client_message` validation. Net
  effect: one fewer runtime dep, same behavior.
- **No `useRoomSocket` reducer tests.** The plan said "if time permits";
  it didn't. The hook is small (~50 lines) and the WS protocol is
  exercised end-to-end through `tests/server/test_ws.py`.
- **Mid-hand `next_hand` ack flow is simpler than planned.** The plan
  envisioned waiting for all `next_hand` acks before starting the next
  hand. Implementation: any client's `next_hand` triggers `end_hand`,
  which clears the engine; the next start is again host-initiated. This
  matches the brief's "host clicks Start for the next hand" pattern.

## Known issues

None blocking. Documented limitations (in README):

- Side pots: spec-perfect for the canonical 2-pot case; 3+ way all-ins are
  best-effort (carried over from V1).
- Tunneling is the user's responsibility and is not tested.
- Mid-hand disconnect auto-folds; rejoin works between hands only.
- No persistence: server restart wipes rooms.

## Commands run

See `qa/commands.txt`. Highlights:

- `python -m pytest tests/` — 90 passed.
- `npm run typecheck` (in `web/`) — clean.
- `npm run build` (in `web/`) — clean.
- `poker-server` started on `127.0.0.1:8765`; `curl /healthz` 200,
  `POST /api/rooms` 200 with a room code, `GET /r/<code>` serves the SPA.
- Playwright: navigated to `http://127.0.0.1:8765/`, filled nickname,
  clicked Create, landed at `/r/DRVX9G` with the lobby rendered.
  Screenshot in `qa/artifacts/v2/lobby-host.png`.
