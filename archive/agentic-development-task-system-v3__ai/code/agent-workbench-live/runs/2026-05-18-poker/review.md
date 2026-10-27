# Review

<!--
Adversarial self-review against brief.md + brief-v2.md + plan.md.
The reviewer is not the builder.
-->

## Decision

approve

## Did the implementation satisfy the brief?

Yes for V2's locally-testable scope. The 6 V2 acceptance criteria
have mechanical implementation + test coverage; the only AC not tested
end-to-end is **internet-shareable**, and that is *by user instruction*
(ASM-013: no network simulation in QA). The server's design choices
that enable tunneling — `--proxy-headers`, `--forwarded-allow-ips='*'`,
`window.location`-derived WS URLs, no hardcoded localhost — are present
and reviewable.

V1 acceptance criteria still hold: V1 engine modules are untouched, V1
pytest suite (58 tests) is part of the 90 that pass.

## Did it accidentally expand scope?

No major scope creep. Some V2 brief-listed risks were not implemented:

- No "reconnection-during-hand resumes" — by design (brief said
  auto-fold on disconnect, rejoin between hands; this is what we built).
- No pydantic models for the protocol — chose TypedDicts + lightweight
  parser. This is a *reduction* in scope (fewer deps) and arguably a
  small simplification.
- No `useRoomSocket` reducer tests — flagged in implementation summary
  as a deferral.

Things explicitly out of scope and confirmed absent:
- No spectator mode, chat, persistence, AI bots in the web UI,
  hand-history, tournament structure, or mobile-PWA features.

## Are there fragile assumptions?

1. **F-005 below.** `views._seat_view` is the *only* fence between
   private and broadcast state. A future refactor that adds a new
   broadcast path (e.g. a debug log, an analytics hook) must route
   through `_seat_view` or it will leak. Comment-only mitigation right
   now.

2. **F-006 below.** The `_drain(ws, count)` helper in WS tests assumes
   the server broadcasts in a deterministic order. It works today but
   would silently break (test flakiness) if FastAPI ever interleaves
   broadcasts. Stronger tests would assert on *content* not *position*.

3. **Heads-up disconnect ends the hand instantly.** This is correct
   gameplay, but the UI then has nothing to show — V2's `HandResult`
   panel handles `uncontested` because `views.hand_result_view`
   returns it. A reviewer should mentally walk through what the UI
   shows when the disconnecting player rejoins between hands.

4. **`asyncio.Lock` per room is fine but not battle-tested.** A
   thrashing client (open/close WS rapidly) could conceivably surface
   a race; not in tests.

5. **Tunneling is unverified.** The `wss://` derivation, the
   `--proxy-headers` setting, and the SPA fallback routes are all
   *correctly designed* but no QA exercises them. F-007 below.

## Are there missing tests?

What is covered well:
- AC-3 (hole-card secrecy) via raw-frame inspection — the single most
  important V2 test.
- AC-5 (spoofed-action rejection) via WS.
- Room lifecycle: create, join, duplicate-reconnect, host-only ops,
  mid-hand disconnect, player-count gating.
- Pre/post-flop action order via `HandEngine` tests.
- REST endpoints.
- V1 non-regression (full V1 suite).

What is not covered:
- **Multi-hand session.** No test runs two consecutive hands through
  the server. Button rotation between hands relies on `Game._next_seed`
  semantics adapted into `Room.start_hand` — well-tested in
  `test_room.py::test_only_host_can_start` but only one hand. **F-008.**
- **3+ player full hand to showdown.** Engine tests cover heads-up and
  3+ action order, but no scripted multi-player hand walks all 4
  streets to a showdown. **F-009.**
- **Network/tunnel.** Out of scope per ASM-013.
- **Reconnect after disconnect (between hands).** Logic exists in
  `Room.join`'s reconnect path; no test exercises stack restoration.
  **F-010.**

## Are there security / data loss / migration risks?

- **No persistence**, so no data loss. Server restart drops in-flight
  state by design.
- **No auth**, by design. Anyone with a 6-char code can join. The room
  code alphabet excludes ambiguous chars (no `0/O/1/I/L`), giving
  31^6 ≈ 887M codes; collision is the only "security" surface and is
  retried in `RoomManager.create`.
- **WebSocket identity = `(room_code, nickname)`.** A malicious client
  who knows another player's nickname *and* the room code can claim
  that seat after the original drops. Brief explicitly accepts this
  in ASM-014 ("rejoin works between hands with same nickname"). For a
  link-shared friend game, this is the simplest correct behavior. For
  competitive play it would need a token.
- **No SQL, no shell, no eval/exec, no file write outside `web/dist`.**
  Action `amount` is `int(raw["amount"])` after a try/except — no
  injection surface.
- **AC-3 (hole-card secrecy)** is the load-bearing security guarantee.
  Tested via raw-frame inspection. Documented in `views.py` module
  docstring. F-005 below proposes hardening.

No migration risks (no DB).

## What should the human review first?

In order — should take ~10 minutes:

1. **`server/views.py`** — confirm `_seat_view` is the only place
   that decides whether to populate `hole_cards`. If a new broadcast
   path is added anywhere, it must go through here.
2. **`tests/server/test_ws.py:test_ws_ac3_hole_card_secrecy_in_raw_frame`**
   — run it. Try mutating `views._seat_view` to deliberately leak
   (e.g. always populate `hole_cards`); the test should fail.
3. **Smoke run.** `poetry install`, `cd web && npm install && npm run build`,
   `poetry run poker-server --port 8000`, open
   `http://localhost:8000` in two browsers, follow the README V2
   quickstart, play one hand.
4. **Internet smoke (optional, *you* do this).** With the server
   running on `:8000`, in another terminal:
   `cloudflared tunnel --url http://localhost:8000`. Open the printed
   `*.trycloudflare.com` URL on your phone. Verify the lobby renders,
   the websocket connects (DevTools → Network → WS shows frames), and
   the link is shareable.
5. **Skim `poker/engine.py`** — verify the new data API mirrors V1's
   generator semantics. Pay attention to `_current_actor` and the
   `to_act` re-opening logic in `submit_action`.

## Findings

### F-005
- **Severity**: minor (design)
- **Where**: `server/views.py`
- **Issue**: The hole-card secrecy filter is enforced by *convention*
  (use `_seat_view`) not by *type*. A new broadcast path that
  hand-rolls a seat dict will bypass the filter.
- **Suggested fix**: Have `Seat` raise on `seat.player.hole_cards`
  access from anywhere except `views._seat_view`, or wrap the engine
  state in a private/public split where the public view is the only
  serializable form. Either is more work than V2 warranted.

### F-006
- **Severity**: minor (test brittleness)
- **Where**: `tests/server/test_ws.py:_drain`
- **Issue**: Tests count expected message frames in advance
  (`_drain(ws_tim, 2)`). If FastAPI's broadcast ordering ever changes,
  tests will fail in confusing ways.
- **Suggested fix**: Drain-until-content-matches helper:
  `wait_for(ws, predicate, max_msgs=5)`.

### F-007
- **Severity**: minor (scope deferral)
- **Where**: AC-6 (internet-shareable)
- **Issue**: Tunneling is not exercised in any test, per ASM-013.
  Server config flags (`--proxy-headers`, `--forwarded-allow-ips='*'`,
  WS URL derivation) are present but their correctness behind a
  real tunnel is asserted by reading, not by execution.
- **Suggested fix**: Out of scope. The brief explicitly defers this
  to the user. A follow-up could add a one-shot test using a local
  reverse proxy (e.g. `caddy` config) without real internet exposure.

### F-008
- **Severity**: minor
- **Where**: `tests/`
- **Issue**: No test runs two consecutive hands through the server.
  Button rotation across hands is implemented in `Room.start_hand`
  via `_next_non_eliminated` and exercised in unit tests
  (`test_room.py`), but the full lifecycle (hand → end_hand →
  start_hand again) isn't covered.
- **Suggested fix**: Add `test_ws.py::test_two_consecutive_hands`.

### F-009
- **Severity**: minor
- **Where**: `tests/test_engine.py`
- **Issue**: No scripted 3+ player hand walks all four streets to a
  showdown.
- **Suggested fix**: Add a parametrized test with a stacked deck and
  pre-canned action list; assert on `eng.state == 'showdown'` and
  payout distribution.

### F-010
- **Severity**: minor
- **Where**: `server/room.py:Room.join` reconnect path
- **Issue**: Stack restoration on rejoin-between-hands is implemented
  (the existing `Seat` survives) but never exercised by a test.
- **Suggested fix**: Add `test_room.py::test_rejoin_between_hands_preserves_stack`.

### F-011
- **Severity**: minor (visibility)
- **Where**: `server/app.py:broadcast_state`
- **Issue**: Send errors are swallowed (`except Exception: pass`).
  This is correct for "client disconnected" cases, but it also masks
  unexpected failures.
- **Suggested fix**: Log the exception at WARN level rather than
  silently discarding.

All findings are minor / non-blocking. The 6 V2 acceptance criteria
all hold to the extent allowed by ASM-013.
