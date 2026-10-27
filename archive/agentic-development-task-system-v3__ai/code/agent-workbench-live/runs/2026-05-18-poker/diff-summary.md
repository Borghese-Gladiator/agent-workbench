# Diff summary

## Scope of change

Branch `agent/poker` vs `master`: **47 new files, 2 modified, 0 deleted,
~4085 LOC added**.

V1 (already documented) added the terminal Hold'em PoC. V2 layers on a
FastAPI + WebSocket server, an in-memory room manager with per-recipient
view filtering, and a React + Vite + TypeScript browser UI.

## Files added (V2 only — V1 covered previously)

**Engine refactor:**
- `python-poker-first/poker/engine.py` (~280 LOC) — `HandEngine` data API.
- `python-poker-first/.gitignore` — ignore `node_modules/`, `dist/`, `poetry.lock`, `__pycache__/`.

**Server (`server/`, 5 modules):**
- `__init__.py`
- `protocol.py` — TypedDicts + `parse_client_message`.
- `room.py` — `Settings`, `Seat`, `Room`, `RoomManager`, code generator.
- `views.py` — `lobby_view`, `hand_view`, `hand_result_view`. The
  hole-card secrecy filter lives here.
- `app.py` — FastAPI app, REST endpoints, WS endpoint, static-file mount
  for the built SPA, `poker-server` CLI entry point.

**Server tests (`tests/server/`, 4 files, 25 tests):**
- `test_room.py` (10) — room lifecycle, duplicate-nickname reconnect, host-only operations, mid-hand disconnect auto-fold, player-count bounds.
- `test_views.py` (4) — pre-showdown hole-card scrubbing, showdown reveal, folded-hand non-reveal.
- `test_api.py` (5) — REST: create, fetch, 404, healthz.
- `test_ws.py` (6) — WS lifecycle, duplicate nickname, host-only start, AC-3 raw-frame hole-card secrecy, spoofed-action rejection, uncontested hand to result.

**Engine tests:**
- `tests/test_engine.py` (7) — `HandEngine` API invariants.

**Web (`web/`, 13 source files):**
- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`.
- `src/main.tsx`, `src/App.tsx` (router), `src/Landing.tsx`, `src/Room.tsx`,
  `src/Lobby.tsx`, `src/Table.tsx`.
- `src/types.ts` (mirrors `server/protocol.py`).
- `src/useRoomSocket.ts` (~50 LOC, owns the WS).
- `src/styles.css` (~180 LOC, plain CSS).

## Files modified

- `python-poker-first/pyproject.toml` — bump to 0.2.0, add server deps
  (`fastapi`, `uvicorn[standard]`, `websockets`) + dev deps (`pytest-asyncio`, `httpx`). Register `server` package and `poker-server` script. Set asyncio test mode to auto.
- `python-poker-first/README.md` — V2 quickstart at the top, V1 retained
  as fallback, cloudflared recipe, project layout, known limitations.

## Files deleted

None.

## Highlights for reviewers

In recommended reading order:

1. **`server/views.py`** — the AC-3 fence. The only place where private
   state is filtered. Look at `_seat_view`: `is_recipient` decides
   whether to populate `hole_cards`, and the `reveal_at_showdown`
   parameter is the only way other-seat cards become visible
   (non-folded only). This is the entire defense; bug → cards leak.

2. **`server/app.py:handle_message`** — turn enforcement, action
   parsing, and the `auto-advance street` loop after a successful
   action. The "spoofed action" defense is the
   `if eng.current_actor != seat_idx` check.

3. **`poker/engine.py:HandEngine`** — the data-driven engine. Compare
   to `poker/game.py:play_hand` (the V1 generator). The interesting
   case: `_current_actor` skips folded/all-in seats, and
   `submit_action` re-opens action via `_to_act` when the current bet
   goes up.

4. **`server/room.py:Room`** — `join` enforces uniqueness, `disconnect`
   auto-folds, `start_hand` is host-only, `update_settings` is
   host-only and pre-engine-only.

5. **`tests/server/test_ws.py:test_ws_ac3_hole_card_secrecy_in_raw_frame`**
   — the critical test. If this passes, AC-3 holds; if it ever fails,
   private state has leaked.

6. **`web/src/useRoomSocket.ts`** — derives `wss://` from
   `window.location.protocol === 'https:'`. This is what makes the
   frontend work behind a tunnel without code changes.

## Lines added / removed

```
 47 files changed, 4085 insertions(+), 55 deletions(-)
```

(The 55 deletions are README rewrites.)

## Commit history on `agent/poker`

```
70310b7 chore(python-poker-first): bump to 0.2.0, add V2 deps + README
d347820 feat(web): React + Vite + TS frontend for the multiplayer browser UI
6a4f7c5 feat(server): FastAPI + WebSocket multiplayer server
ab610ee refactor(poker): add HandEngine data-driven API for V2 server use
f391fda test(python-poker-first): unit + scripted-hand tests (58 pass)
bdd27ad feat(python-poker-first): terminal I/O + CLI entrypoint
893ec68 feat(python-poker-first): poker engine (hand eval, betting, pot, game)
699be1b feat(python-poker-first): scaffold project + cards module
```
