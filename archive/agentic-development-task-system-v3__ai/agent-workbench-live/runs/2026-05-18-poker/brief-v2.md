# Brief — V2 (change request)

> **Supersedes:** [brief.md](./brief.md) (V1, accepted then bounced).
> **Origin:** human bounce on 2026-05-18 requesting browser UI + online
> multiplayer + shareable lobby link.
> **What carries over:** the V1 engine (`cards.py`, `hand_eval.py`, `pot.py`,
> `betting.py`, `players.py`, `actions.py`) is reused as-is. Hand-ranking,
> betting legality, side-pot resolution, and seeded shuffling do **not** need
> to be rebuilt — they were validated in V1 with 58 passing tests.
> **What is removed:** the V1 terminal-only pass-and-play UX (`io.py`,
> `cli.py`, `game.py` driver) is replaced. The V1 CLI is preserved as a
> fallback / smoke harness but is no longer the primary play path.

<!--
Code-blind. Convert the bounce reason and the user's clarifications into a
high-quality spec. Engine is settled; UX and transport are the new work.
-->

## Goal

Deliver a **browser-based** no-limit Texas Hold'em game for 2-6 players where
a host can **create a room, copy a shareable link, and have friends join from
their own devices** to play together over the internet.

Concretely: when the user opens the page they see a "Create room" button.
After creating, they get a URL like `https://<host>/r/AB12CD` they can paste
to Discord/iMessage/etc. Each invitee opens the link, picks a nickname, and
lands in a lobby together. When ≥2 are seated and the host clicks "Start",
hands begin. Each player sees only their own hole cards in their own browser.
Action prompts appear at the right player's UI; the rest of the table sees
"P3 is thinking…". When the hand ends, everyone sees the showdown and chip
deltas. Hands keep coming until ≤1 player has chips or the host ends the
game.

## User-facing behavior

**Host flow:**
1. Open the site root (`/`).
2. Click **Create room**. Land at `/r/<code>`. Enter a nickname.
3. See the lobby: own nickname, list of joined players, **copy link** button,
   table settings (player cap, starting stack, blinds), and a disabled
   **Start hand** button.
4. Share the link.
5. Once ≥2 players are seated and the host has confirmed settings, **Start
   hand** is enabled. Click it.
6. Play out hands: when it's your turn, action buttons (`Fold` / `Check` /
   `Call N` / `Bet (slider)` / `Raise to (slider)` / `All-in`) light up. When
   it's not your turn, the buttons are disabled and the current actor is
   indicated.
7. Showdown reveals all surviving hands. After a short delay (or click
   **Next hand**), the next hand begins.

**Joiner flow:**
1. Open the shared URL.
2. Enter a nickname. Land in the lobby with the host and any other joiners.
3. Same play UX as the host. Joiners cannot start or kick.

**Spectators / late joiners:** not in V2 (Non-goal).

**Disconnects:** if a player's tab closes or websocket drops, they're
auto-folded from any active hand. They can rejoin via the same link with the
same nickname during the next hand (their stack is preserved across
disconnect/rejoin within the same room session).

## Acceptance criteria

- [ ] **Create + join via link.** A host can create a room and get a URL.
      Opening that URL in another browser (different cookie / private window)
      lets a second user join with a chosen nickname. Both end up in the
      same lobby and see each other's nicknames.
- [ ] **Lobby and start.** The host (and only the host) can configure
      stack/blinds/max-players in the lobby and start the first hand once
      ≥2 players are seated. Joiners see the same settings live.
- [ ] **Per-player private state.** A player's own hole cards are visible in
      their browser only. Opening DevTools / inspecting websocket frames at
      another player's device does **not** reveal someone else's hole cards
      until showdown. (Tested by inspecting the actual websocket payload
      delivered to a non-actor client — it must contain `null` or the cards
      stripped, not the cards themselves.)
- [ ] **Correct game flow.** All V1 acceptance criteria still hold:
      deal cards, manage betting rounds, determine winner by hand ranking,
      support 2-6 players. Drives the existing engine — should not regress.
- [ ] **Action turn enforcement.** The server rejects an action submitted by
      a player who is not the current actor. The frontend disables the
      buttons for non-actors, but the server is the source of truth.
- [ ] **Internet-shareable.** With the server running locally and a tunnel
      (e.g. `cloudflared tunnel --url http://localhost:8000`) pointed at it,
      the printed public URL works end-to-end. **Note: the tunnel is run
      manually by the user; this run does NOT test it.** Server design must
      not break when bound to `0.0.0.0` and reached via HTTPS through a
      reverse proxy (X-Forwarded-Proto etc. handled, websocket upgrade works
      through standard tunnel configs).

## Non-goals

- **Persistence beyond server process lifetime.** Server restart = rooms
  gone. No DB. No save/load.
- **Authentication / accounts.** Link-based access only. Nickname is
  whatever the user types. No email, password, OAuth, captcha.
- **Spectators or kibitzers.** If you're not seated, you don't see cards.
- **In-game chat.** Out of scope.
- **Hand history / replay.** No record of previous hands.
- **Mobile-native or PWA.** Plain responsive web is enough; no app.
- **Production deployment, hosting, TLS termination, anti-cheat.** The user
  handles tunneling/exposure; this run only validates that the server is
  compatible with being fronted by such a tunnel.
- **Game variant changes.** Still no-limit Texas Hold'em. Still 2-6.
- **Sound, animations, fancy graphics.** Plain CSS. Cards as text/svg.
- **Reconnection within an active hand.** If you drop mid-hand, you fold for
  that hand. Rejoin works between hands.
- **AI bots.** Removed from V2. The CLI still has the V1 random bot for
  smoke tests, but the web UI is human-only.
- **Network simulation in QA.** Per user instruction, we will **not** run
  ngrok/cloudflared during QA, and we will not stub a fake tunnel. We test
  only on `localhost`.

## Good examples

- Host opens `http://localhost:8000`, clicks Create, lands at
  `/r/HQ7K9P`, enters nickname `Tim`. URL is in clipboard. Friend opens
  `http://localhost:8000/r/HQ7K9P` (or the tunneled URL on the internet),
  types `Alex`, lands in the lobby. Both see `Tim (host)` and `Alex`.
  Tim hits Start. Cards deal in both browsers. Tim sees `Ah Kh`; Alex sees
  `7c 2d`. Inspecting the websocket frame in Tim's DevTools shows Alex's
  hole_cards field is `null`.

- A 4-player hand goes to showdown. All four players see the winner
  announcement, the revealed hands of non-folded players, and updated chip
  stacks at the same time (within ~500ms).

- Tim is in seat 0, mid-hand, closes the tab. Within ~2 seconds the other
  three players see "Tim disconnected — auto-folded for this hand". The
  hand continues. After the hand ends, Tim reopens the link, types `Tim`,
  and is back in his seat with his stack intact.

## Bad examples

- A player visits the room URL and sees another player's hole cards in the
  page source or websocket frame. **Severe bug — leak of private state.**
- A user submits an action via DevTools `ws.send` impersonating another
  seat, and the server processes it. **Severe bug — server didn't validate
  the connection's identity.**
- The host's Start button is enabled with only 1 player seated. **Bug.**
- Two players visit the same link, both type the same nickname, and the
  server silently puts them at the same seat. **Bug.** Reject duplicate
  nicknames within a room with a clear message.
- Server crashes when a player disconnects mid-hand. **Bug.**
- Refreshing the page in the middle of a hand causes the hand to abort for
  everyone. **Bug.** (The other players' hand should continue; the
  refreshed player auto-folds.)
- A tab loses its websocket, reconnects, and the room is gone or the user
  is dropped from their seat. Within the same hand → expected (auto-fold).
  Between hands → bug; they should be able to rejoin with their stack.

## Constraints

- **Server in Python.** Reuse the engine. FastAPI + uvicorn is the obvious
  default given the existing precedents in `new-tech-monorepo`
  (`fastapi-hugging-face`) and the engine being Python. Other Python
  webframeworks (Starlette, Flask) are acceptable; not Django.
- **Websockets for real-time.** Polling is acceptable as a fallback but
  must not be the primary channel — turn-by-turn play needs sub-second
  push.
- **Frontend in TypeScript + React + Vite.** Matches the
  `react-vite-first/` precedent in this monorepo.
- **Single process for V2.** No Redis, no separate matchmaker. Room state
  lives in server memory.
- **No new heavy deps.** FastAPI, uvicorn, websockets, pydantic. React,
  Vite, TypeScript. That's it. No state-manager libs (Redux/Zustand), no
  UI kit (MUI/AntD) — plain CSS or one small primitive lib if needed.
- **Correctness over polish (still).** The game engine is correct; the
  UI's job is to not let that correctness leak or get corrupted.
- **Compatible with a tunnel.** Server must work when fronted by HTTPS via
  `cloudflared`/`ngrok`/etc., specifically: trust `X-Forwarded-Proto`,
  bind `0.0.0.0`, websocket upgrade works through standard tunnels. We
  don't test this end-to-end (user will), but design choices that break it
  (e.g. hardcoding `ws://localhost`) are bugs.
- **Deterministic seed still supported.** A room can be created with a
  seed for testing; defaults to random.

## Assumptions

(Append-only; new IDs continue from V1's ASM-008.)

- **ASM-009:** "Send a link" means link-based access with no auth. Anyone
  with the link is in. Nickname is self-declared.
- **ASM-010:** Server uses FastAPI + native WebSocket support. Justified
  by Python engine reuse and monorepo precedent
  (`fastapi-hugging-face/`).
- **ASM-011:** Frontend uses React + Vite + TypeScript. Justified by
  monorepo precedent (`react-vite-first/`).
- **ASM-012:** Room state is in-process memory. No DB. Server restart =
  rooms lost. Acceptable per V2 Non-goals.
- **ASM-013:** "Local QA only, no network simulation." Per user
  instruction: QA does not exercise the tunneling layer. The server is
  designed to be tunnel-compatible (no hardcoded `localhost` URLs in
  frontend; respects `X-Forwarded-Proto`), but the cloudflared/ngrok step
  is the user's responsibility, documented in README, never executed in
  QA.
- **ASM-014:** Reconnection within a hand auto-folds. Rejoin between hands
  restores the seat by `(room_id, nickname)`. This is the simplest design
  that survives flaky links without complicating the engine.
- **ASM-015:** Room codes are 6-char base32 (capital letters + digits 2-9,
  avoiding ambiguous 0/O, 1/I/L). Collision probability is negligible at
  the scale of this PoC; if a collision occurs the server retries.

## Suggested QA scenarios

(All run **locally** — no tunnel, no network sims.)

1. **Two-browser end-to-end.** Open the server. In browser A, create room.
   In browser B (or A's private window), open the same `/r/<code>` URL.
   Both join. Host starts. Play one hand to showdown. Verify each browser
   showed only its own hole cards at the right times.

2. **Hole-card secrecy via DevTools.** Open browser A's DevTools Network →
   WS tab. Filter to the room websocket. During a hand where A is **not**
   the current actor, inspect every incoming frame. Confirm that frames
   describing other players' state have `hole_cards: null` (or absent).
   Only after showdown should other players' cards appear in A's frames.

3. **Server rejects spoofed actions.** In browser A, when it is **not** A's
   turn, in the DevTools console, run `ws.send(JSON.stringify({type:
   'action', action: 'fold'}))` (with whatever the protocol uses).
   Confirm the server either drops the message or sends back an error,
   and does **not** mutate the hand.

4. **Lobby duplicate-nickname rejection.** In browser A, join as `Tim`.
   In browser B, open the same room URL, try to join as `Tim`. Expect
   error "nickname taken".

5. **Lobby player count gating.** Host can't click Start with only 1
   player. Becomes clickable with 2. Disabled when 7+ try to join (server
   rejects past 6).

6. **Disconnect mid-hand auto-folds.** Host and one joiner. Mid-hand,
   close the joiner's tab. Within ~3s, the host's UI shows the joiner
   auto-folded and the hand continues. Host wins uncontested.

7. **Rejoin between hands restores stack.** Same as (6), but after the
   hand ends, the joiner reopens the link with the same nickname. Their
   chip stack is whatever it was when they disconnected (not reset to
   starting stack).

8. **Refresh during own turn.** Host refreshes the page when it's their
   turn. Confirm the websocket reconnects, the host sees the same hand
   state, and the action prompt is restored. (If too complex, downgrade
   to "auto-fold on refresh" — but document that.)

9. **Deterministic seed.** Create a room with `?seed=42`. Play through
   one hand with scripted actions. Tear down. Create another room with
   `?seed=42`. Identical hole cards and board.

10. **No-tunnel base URL correctness.** When accessed via
    `http://localhost:8000/r/AB12CD`, the page's "copy link" button copies
    `http://localhost:8000/r/AB12CD`, not a hardcoded URL. When accessed
    via a different host header, "copy link" reflects that. (We don't
    test through a real tunnel, but we verify the URL is constructed from
    `window.location`, not from a constant.)

11. **V1 engine non-regression.** Re-run V1's `pytest` suite from
    `python-poker-first/`. Expected: still 58 passed.

12. **6-player full table.** Open 6 private windows. All join. Host
    starts. Play one hand to showdown. Verify action order is correct
    (UTG acts first pre-flop; SB acts first post-flop) and at most one
    player has the "your turn" UI at any time.

## Open questions deferred to /plan

- Exact websocket message schema (event names, payload shape).
- Whether the engine's generator-based `play_hand` is the right primitive
  or whether to refactor to event-driven for V2. (Likely yes — the
  generator yields prompts synchronously, which doesn't fit
  await-on-websocket.)
- Where to mount the static frontend (FastAPI `StaticFiles`, or serve
  separately). Default plan: build the frontend to `web/dist/` and have
  FastAPI serve it from there in production; in dev, run `vite dev` on
  port 5173 with a websocket proxy to `8000`.
