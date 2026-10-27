# Handoff

<!--
Everything the human needs to start their review. Keep short.
-->

## Where to look

- **branch**: `agent/poker` (8 commits, base `master` on `new-tech-monorepo`)
- **worktree**: `agent-workbench-live/worktrees/new-tech-monorepo/poker/`
- **code lives in**: `python-poker-first/`
- **briefs**: `brief.md` (V1, superseded) and **`brief-v2.md`** (current ask)
- **audit**: ./audit.md
- **review**: ./review.md
- **qa report**: ./qa/report.md

## What was built

V1 + V2 together. V1 was the terminal Hold'em game (still works, 58 tests
pass). V2 adds **browser multiplayer**:

- FastAPI + WebSocket server (`server/`) wrapping a new data-driven
  `HandEngine` that reuses V1's `cards`, `hand_eval`, `pot`, `betting`,
  `players`, `actions` modules unchanged.
- React + Vite + TypeScript frontend (`web/`) — landing page, lobby with
  copy-link button + host settings, game table with per-seat panels, action
  buttons gated to the current actor.
- Hole-card secrecy enforced server-side in `server/views.py`. Verified by
  a test that inspects the raw WebSocket frame Alex receives during Tim's
  hand (Tim's `hole_cards` is `null` in Alex's frame).
- Server is designed to be safely fronted by an HTTPS tunnel
  (`--proxy-headers`, `--forwarded-allow-ips='*'`, frontend derives `wss://`
  from `window.location`). **The tunnel itself is yours to run; not tested.**

90 tests pass (V1: 58, V2: 32). Frontend `tsc --noEmit` and `vite build`
are clean.

## What works

- V1 CLI (smoke fallback): `poetry run poker --players 4 --bots 4 --seed 42`.
- V2 web mode end-to-end on `localhost`:
  - Create a room via REST → SPA route `/r/<code>`.
  - Open WS, join with nickname, see lobby with copy-link.
  - Host starts a hand. Each player sees only their own hole cards.
  - Actions are rejected if it isn't your turn.
  - Disconnect → auto-fold; reconnect (between hands) → seat preserved.
- 6-player table supported.
- Player count enforced at the server (`max_players` setting, default 6).
- Deterministic seed: `--seed N` on the CLI or `seed` field on lobby
  settings.

## What doesn't work / known issues

- **AC-6 (internet-shareable) is design-only, not tested.** Per ASM-013
  ("local QA only, no network simulation") the cloudflared/ngrok path was
  not exercised. Server flags + frontend WS URL derivation suggest it will
  work; you'll find out when you point a tunnel at it.
- Side pots are spec-perfect only for the canonical 2-pot case; 3+ way
  all-ins are best-effort (carried over from V1).
- No persistence: server restart drops rooms.
- No reconnect-during-hand. Mid-hand drops auto-fold; rejoin works only
  between hands.
- The "next hand" handoff is simpler than the plan: any client's
  `next_hand` message clears the engine, then the host starts the next
  hand. The plan envisioned a coordinated all-acks-before-advance flow.

Findings F-005 through F-011 in `review.md` are minor non-blocking
follow-ups.

## Suggested first checks

In order — ~10 minutes:

1. **Install everything.**
   ```bash
   cd python-poker-first
   poetry install
   cd web
   npm install
   npm run build
   cd ..
   ```
2. **Run the test suite.**
   ```bash
   poetry run pytest
   ```
   Expected: **90 passed**.
3. **Start the server.**
   ```bash
   poetry run poker-server --host 0.0.0.0 --port 8000
   ```
4. **Open two browsers (or a private window for the second).**
   - In window A: open `http://localhost:8000`, nickname `Tim`, click **Create room**.
   - Copy the link (browser address bar or the Copy-link button).
   - In window B: paste the link, nickname `Alex`.
   - Verify both see each other in the lobby.
   - In window A click **Start first hand**. Verify each browser shows only its own hole cards.
5. **Inspect the websocket frames.** In window A, DevTools → Network → WS. Pick the frame named lobby/hand_state. Confirm `seats[Alex].hole_cards` is `null`.
6. **Try a tunnel (your responsibility).**
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
   Open the printed `*.trycloudflare.com` URL on your phone. Confirm the lobby loads and the WS connects.

If steps 1-5 pass, V2 is delivered. Step 6 is the only AC that lives
outside QA's reach.
