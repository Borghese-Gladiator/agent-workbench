# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

### V1 (carried over from prior validate cycle)

- V1 pytest suite: 58 passed.
- CLI smoke: 4-bot 3-hand deterministic run; player-count bounds rejected at 1 and 7.

### V2

- Full Python pytest suite: **90 passed** (V1's 58 + V2's 32 new).
- Frontend `tsc --noEmit`: clean.
- Frontend `vite build`: clean, output to `web/dist/`.
- Server smoke: `poker-server --port 8765` started; `/healthz`, `POST /api/rooms`, `GET /r/<code>` all return correct responses.
- **Browser e2e (Playwright MCP, single tab):** navigated to `http://127.0.0.1:8765/`, filled `nickname=Tim`, clicked **Create room**. URL changed to `/r/DRVX9G`. Lobby rendered: room code, host badge, player count `1/6`, Start button disabled with "Need ≥2 players (you have 1)", Copy-link button populated with the correct URL. WebSocket round-trip confirmed (lobby_state landed in the React state). Screenshot in `qa/artifacts/v2/lobby-host.png`.

### Not run (out of scope per ASM-013)

- `cloudflared tunnel` or any actual internet exposure.
- Multi-browser, real-time two-player game session (would require multiple browser contexts and is more brittle than the WS test suite covers; the WS suite asserts the same invariants on raw frames).
- Frontend unit tests (Vitest) — flagged as time-permitting in the plan; the WS test suite covers the protocol.
- Mobile browsers / responsive layout sweeps.

## Results

### Unit + integration tests

```
============================== 90 passed in 0.52s ==============================
```

Mapping V2 acceptance criteria to tests:

| V2 AC | Tests |
|-------|-------|
| AC-1 Create+join via link | `test_api::test_create_room_returns_code`, `test_ws::test_ws_join_and_lobby_state`, Playwright smoke |
| AC-2 Lobby + start | `test_room::test_only_host_can_start`, `test_room::test_can_start_requires_two_players`, `test_ws::test_ws_start_hand_only_by_host` |
| AC-3 Per-player private state | **`test_views::test_hand_view_reveals_only_recipient_cards_preshowdown`**, **`test_ws::test_ws_ac3_hole_card_secrecy_in_raw_frame`** (raw-frame inspection), `test_views::test_hand_result_view_does_NOT_reveal_folded_hands` |
| AC-4 V1 non-regression | V1's 58 tests + `test_engine.py`'s 7 new tests |
| AC-5 Action turn enforcement | `test_ws::test_ws_spoofed_action_rejected` |
| AC-6 Internet-shareable | **Design-only**, not tested. Server runs with `--proxy-headers --forwarded-allow-ips='*'`; frontend derives WS URL from `window.location`. README documents cloudflared recipe. |

### Lint / typecheck

```
$ npm run typecheck
> tsc --noEmit
(no output — clean)
```

### Browser / Playwright

One scripted Playwright session through the Create → Lobby flow.
Screenshot captured: `qa/artifacts/v2/lobby-host.png`.

### Smoke scripts

- Server starts on `:8765` and serves the built SPA (`<!doctype html>` with the Vite-built JS bundle).
- `POST /api/rooms {"nickname":"Tim"}` → `{"code":"DSRSGB"}`.
- `GET /r/<code>` → 200 (SPA fallback).
- `GET /healthz` → 200 `{"status":"ok"}`.

## Captured artifacts

- `qa/artifacts/v2/pytest-v2.log` — full pytest output (90 passed).
- `qa/artifacts/v2/tsc-noemit.log` — TypeScript check output (clean).
- `qa/artifacts/v2/lobby-host.png` — browser screenshot of the lobby after Create.
- `qa/artifacts/pytest.log` — V1 pytest output (58 passed) [prior validate cycle].
- `qa/artifacts/smoke-4bot-3hand.log` — V1 CLI smoke [prior validate cycle].
- `qa/artifacts/reject-7players.log`, `qa/artifacts/reject-1player.log` — V1 CLI rejection [prior validate cycle].
- `qa/commands.txt` — verbatim command list (V1 + V2).
