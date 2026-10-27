# Implementation plan

## Current repo understanding

`/Users/timothy.shee/GitHub/shengji-browser-game` is a brand-new repo created by `agent-workbench new-run --new-repo-path`. It currently contains a default monorepo-layout scaffold the workbench planted:

```
shengji-browser-game/
  backend/    (empty)
  docs/       (empty)
  frontend/   (empty)
  README.md   (one-line placeholder)
```

There is one initial commit (fingerprint `9bb6398944c8f7e800d5c8e8d33103610ad9de51`) and no `package.json`, no `pnpm-workspace.yaml`, no source code. This is a clean slate.

The empty `backend/` and `frontend/` directories from the workbench scaffold do **not** match the brief's required structure (`packages/client`, `packages/server`, `packages/shared`, `tests/e2e`). DR-001 below records that we delete those and build the pnpm monorepo layout the brief specifies.

The `README.md` placeholder will be overwritten by the real README in step 17 of the implementation order.

## Relevant files

The plan creates everything; nothing pre-exists to preserve. The notable target files we'll create:

- `package.json` — root manifest with `private: true`, `packageManager: "pnpm@<pinned>"`, workspace scripts (`dev`, `build`, `test`, `lint`, `typecheck`).
- `pnpm-workspace.yaml` — declares `packages/*` and (optionally) `tests/e2e` as the workspace member set.
- `.gitignore` — ignores `node_modules`, build outputs, `packages/server/data/shengji.sqlite*`, Playwright outputs.
- `.npmrc` — sets `strict-peer-dependencies` off for shadcn/Radix peers if needed; pins `auto-install-peers=true` for pnpm.
- `tsconfig.base.json` — strict mode, shared compiler options, project references.
- `packages/shared/` — pure TS rule engine.
- `packages/server/` — Express + Socket.IO + SQLite (better-sqlite3).
- `packages/client/` — React + Vite + Tailwind + shadcn/ui.
- `tests/e2e/` — Playwright config + multi-context test files.
- `README.md` — run instructions, LAN play instructions, four-tab walkthrough.

## Proposed changes

The work proceeds in the 17-step order from the brief's "Implementation order" — that order is correct and minimizes rework. Below is the same order with concrete commits / chunks. Each step is a small commit (1–4 files) where practical, so the `build.md` diff is reviewable.

### Step 1 — bootstrap monorepo skeleton (1 commit)
- Delete `backend/`, `frontend/`, `docs/` placeholders.
- Add `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.npmrc`, `tsconfig.base.json`, `.editorconfig`, `.prettierrc`.
- Add empty `packages/{client,server,shared}/package.json` and `tests/e2e/package.json` so `pnpm install` resolves a workspace.

### Step 2 — shared types (1 commit)
- `packages/shared/src/types.ts`: `Suit`, `Joker`, `Rank`, `Card`, `Player`, `PlayerId`, `Seat` (0|1|2|3), `GamePhase`, `TrickPlay`, `CompletedTrick`, `RoundSummary`, `GameState`, `PublicGameState`, `PrivatePlayerState`.
- `packages/shared/src/index.ts` re-exports.
- `packages/shared/tsconfig.json` strict; `packages/shared/package.json` exports field and `main`.

### Step 3 — card / deck utilities (1 commit)
- `packages/shared/src/cards.ts`:
  - `RANKS: readonly Rank[]` in ascending order.
  - `SUITS: readonly Suit[]`.
  - `buildDeck(deckId: 1 | 2): Card[]` returns 54 cards with unique IDs of form `d{deckId}-{suit?|joker}-{rank?}-<counter>` so duplicate copies between the two decks are distinguishable.
  - `buildFullDeck(): Card[]` returns 108 cards (`[...buildDeck(1), ...buildDeck(2)]`).
  - `shuffle<T>(rng: () => number, arr: readonly T[]): T[]` — Fisher-Yates, RNG-injectable so tests can use a seeded RNG; the server uses `Math.random` by default but `crypto.randomInt`-backed in production.
  - `pointValue(card: Card): number` — 0, 5, or 10.
  - `deckPoints(cards: Card[]): number`.

### Step 4 — rule engine + unit tests (3–4 commits)

**Chunk A — trump + effective suit + ordering**:
- `packages/shared/src/trump.ts`:
  - `isTrump(card, trumpRank, trumpSuit | null): boolean` — joker, rank===trumpRank, or suit===trumpSuit.
  - `effectiveSuit(card, trumpRank, trumpSuit): "trump" | Suit` — collapses all effective trump to the literal `"trump"`; non-trump returns its printed suit.
  - `compareCards(a, b, trumpRank, trumpSuit): number` — the canonical ordering; positive means `a > b`. Implements the brief's high-to-low ordering: big joker > small joker > trump-suit/trump-rank > off-suit trump-rank (tied among themselves) > rest of trump suit (A high) > non-trump (A high in own suit; cards of different non-trump suits are incomparable for winning purposes but rankable for sort).
  - Vitest unit tests for: trump detection across all combinations, effective suit, total ordering on a hand-sorted basis, trump-rank tie behavior (DR-007).

**Chunk B — play structure detection**:
- `packages/shared/src/plays.ts`:
  - `classifyPlay(cards: Card[], trumpRank, trumpSuit): { kind: "single" | "pair" | "tractor" | "invalid", components: PairComponent[], suit: "trump" | Suit }`.
  - Pair detection: 2 cards with same effective rank and same effective suit (DR-006 handles joker pairs).
  - Tractor detection: N consecutive pairs in the same effective suit. Adjacency uses the engine's "consecutive rank in effective suit" relation (DR-008).
  - Unit tests: single, pair across two decks, pair of jokers (small-small, big-big), 2-pair tractor, 3-pair tractor, gapped pair sets are *not* tractors, mixed-suit groups are invalid as pairs/tractors, jokers don't form normal-suit tractors.

**Chunk C — follow-suit validation**:
- `packages/shared/src/followSuit.ts`:
  - `legalFollow(leadKind, leadComponents, leadSuit, hand, trumpRank, trumpSuit, attemptedPlay): { legal: boolean, reason?: string }`.
  - Implements: must match card count; must follow effective suit when possible; must match structure (pair / tractor) when possible in that effective suit; off-suit make-up rules.
  - Unit tests parametrized over scenarios: 11 listed in the brief's Suggested QA scenarios for follow-suit.

**Chunk D — trick winner + scoring + level progression**:
- `packages/shared/src/trick.ts`: `trickWinner(plays: TrickPlay[], leadKind, leadSuit, trumpRank, trumpSuit): seatIndex`.
- `packages/shared/src/scoring.ts`:
  - `applyTrickPoints(trick, teamPoints): teamPoints'`.
  - `roundSummary(defenderPoints, kittyPoints, defendersWonFinalTrick, currentLevels, dealerTeamIndex): RoundSummary` — implements the 6 scoring bands, including dealer-team change.
  - `advanceRank(rank, by): Rank | "game-over"` — clips at A and signals game-over per ASM-13.
- Unit tests: each band, kitty 2x with and without defender final-trick win, rank advancement at boundaries (K→A, A→game-over).

### Step 5 — SQLite storage (1 commit)
- `packages/server/src/db/sqlite.ts`:
  - Uses `better-sqlite3` (synchronous, simplest for this use case).
  - `openDatabase(path): Database` — opens, runs `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, runs the schema migration.
  - Migration: creates `rooms` and `player_sessions` tables per the brief.
  - `saveRoomState(roomId, state)`, `loadRoomState(roomId)`, `loadAllActiveRooms()`, `upsertPlayerSession(...)`, `getSessionByToken(token)`, `markConnected(sessionId, connected)`.
  - All multi-step writes wrap in `db.transaction(...)`.
- `packages/server/data/.gitkeep` ensures the dir exists; SQLite file itself is gitignored.

### Step 6 — room manager (1 commit)
- `packages/server/src/rooms/roomManager.ts`:
  - In-memory cache `Map<roomId, RoomEntry>` where `RoomEntry` is `{ state: GameState, players: PlayerSession[] }`.
  - On startup: `loadAllActiveRooms()` from SQLite to hydrate cache.
  - Helpers: `createRoom(hostName)`, `joinRoom(publicCode, name)`, `resumeSession(token, publicCode)`, `withRoomLock(roomId, fn)` — serializes mutations per room.
  - Each successful state-mutating helper calls `saveRoomState` inside the same transaction-aware path.
- `packages/server/src/rooms/codes.ts`: `generatePublicCode()` returns a 6-char alphanumeric code (DR-002), retrying on collisions.
- `packages/server/src/rooms/tokens.ts`: `generateReconnectToken()` returns a `crypto.randomBytes(32).toString("base64url")` value (DR-003).

### Step 7 — Socket.IO server + integration tests (2 commits)

**Chunk A — server wiring**:
- `packages/server/src/index.ts`: bootstrap Express app, mount HTTP server, attach Socket.IO, register handlers, listen on port `3001` (configurable via `PORT`).
- `packages/server/src/socket/handlers.ts`: registers each event from the brief. Each handler is a 5–15 line wrapper that:
  1. Validates session (`socket.data.session`).
  2. Looks up the room (rejects with `errorMessage` if missing).
  3. Calls the reducer in `packages/shared` (or a server-side wrapper that owns the RNG and DB).
  4. On success: persist + broadcast `publicRoomState`; send `privatePlayerState` to each seated player.
- `packages/server/src/reducers/gameReducer.ts`: pure reducer (state, action) → state. Re-exports validators from `shared`. Server-side wrappers in `handlers.ts` add the side effects (RNG seed, DB persistence, broadcast).
- `packages/server/src/socket/projection.ts`: `projectPublic(state)` strips hands, kitty, and reconnect tokens; `projectPrivate(state, playerId)` returns just `{ hand, isDealer, ... }`. Tests assert no field leaks.

**Chunk B — integration tests**:
- `packages/server/test/integration/createAndJoin.test.ts`: spin up server on an ephemeral port, four `socket.io-client` instances perform the lobby flow.
- `packages/server/test/integration/seatsAndReady.test.ts`: duplicate seat selection rejected; all-ready start succeeds; non-ready start fails.
- `packages/server/test/integration/handPrivacy.test.ts`: assert public events never include `hands` for other seats; assert each client only receives its own hand on `privatePlayerState`.
- `packages/server/test/integration/bidding.test.ts`: valid trump call; invalid trump call rejected.
- `packages/server/test/integration/kitty.test.ts`: dealer receives kitty; non-8 discard rejected; 8-card discard succeeds.
- `packages/server/test/integration/play.test.ts`: out-of-turn rejected; card-not-in-hand rejected; legal single trick resolves; defender points update.
- `packages/server/test/integration/fixtures.test.ts`: uses the test-only fixture loader (see step 7 Chunk A) to deal known hands and exercise legal-pair trick, legal-tractor trick, illegal-follow rejections, defender-takes-final-trick → 2x kitty multiplier.
- `packages/server/test/integration/reconnect.test.ts`: a fourth client disconnects and reconnects with the token; recovers seat and hand.
- `packages/server/test/integration/restartResume.test.ts`: start a server against a temp SQLite file; create a room; stop the server; start a new server pointing at the same DB file; assert the room hydrates and a reconnect with the saved token succeeds.
- Fixture loader: `packages/server/src/test/fixtures.ts` exports `loadFixture(state)` which is registered as a socket event ONLY when `process.env.NODE_ENV === "test"`. Lives alongside production code but gated by the env guard.

### Step 8 — client connection / session handling (1 commit)
- `packages/client/src/lib/socket.ts`: singleton socket wrapper with reconnect handling.
- `packages/client/src/lib/session.ts`: localStorage read/write for `{ publicCode, playerId, reconnectToken }`.
- `packages/client/src/state/usePublicState.ts`, `usePrivateState.ts`: React hooks that subscribe to socket events; use `useSyncExternalStore` to avoid stale closures.

### Step 9 — landing, lobby, seat/ready (2 commits)

**Chunk A — landing + routing**:
- React Router v6 routes: `/` (landing), `/room/:publicCode` (room shell which renders lobby or game view based on phase), `/game-over/:publicCode` (terminal).
- `packages/client/src/pages/Landing.tsx`: display name, create room, join room, rejoin prompt.
- shadcn `Input`, `Button`, `Card`, `Sonner` (toast).

**Chunk B — lobby + seating + ready**:
- `packages/client/src/pages/Room.tsx` switches on `phase`.
- `packages/client/src/views/Lobby.tsx`: room code, copy invite link, four seat cards (Team A/B grouping), ready toggle, start button (host only), remove (host only), reset (host only), error area.
- `data-testid` on every interactable per the brief.

### Step 10 — deal + start game (1 commit)
- Server handler for `startGame`: shuffle the 108-card full deck; deal 25 to each player; remaining 8 = kitty; set `phase: "dealing"` → immediately advance to `"bidding"`; persist; broadcast.
- Client deal-animation is out of scope; the phase just flips to bidding. The hand renders immediately.

### Step 11 — bidding (1 commit)
- `packages/shared/src/bidding.ts`: `canCall(hand, trumpRank, suit)` → boolean.
- Server handler for `callTrump`: validate `canCall` against the hand; first valid call wins; set `trumpSuit`; advance phase to `kitty`.
- Server handler for `passTrump`: track passes; if all four players pass, transition to "dealer must choose"; expose a `dealerChooseTrump` handler.
- Client `views/Bidding.tsx`: list the suits the player can call (computed locally from their hand for UX, but the server is the source of truth on submit); pass button; dealer-choice fallback panel.

### Step 12 — kitty discard (1 commit)
- Server handler for `discardKitty`: validate `selectedCardIds.length === 8` and all 8 are in dealer's hand; remove them; store the discarded set in state as `kitty` (replacing the original 8 dealt, since after the dealer absorbs the kitty their hand is 33 cards and the discard returns 8 hidden cards to `state.kitty`); advance phase to `playing`; set `currentTurnSeat = dealerSeat`.
- Client `views/Kitty.tsx`: dealer sees their 33-card hand; selection counter; "Discard 8" button disabled unless exactly 8 selected.

### Step 13 — trick play (2 commits)

**Chunk A — singles + pairs**:
- Server handler for `playCards`: validate turn, card-ownership, count, and structure (via shared `legalFollow`); apply; if trick complete (4 plays), compute winner via `trickWinner`, add points, set winner as next turn, clear `currentTrick`, archive into `completedTricks`; if hands empty → phase `scoring`; persist; broadcast.
- Client `views/GameTable.tsx`: status bar, four-player layout with each player's name/seat/team/card count/connected state, current trick area, hand at bottom (or in mobile stack order), selected cards, "Play selected" button.

**Chunk B — tractors**:
- Already covered by `classifyPlay` in step 4 Chunk B; add an integration test that constructs a fixture deal where a tractor is the lead and follower must play a tractor.

### Step 14 — scoring + next round (1 commit)
- After the final trick of a round, server handler computes:
  - `defenderPoints` total.
  - Kitty bonus = `2 * deckPoints(state.kitty)` if defenders won the last trick else 0.
  - Resolve scoring band; update `teamLevels`; set new `dealerTeamIndex` and new `dealerSeat` (DR-009).
  - Set `phase = "scoring"`; populate `lastRoundSummary`.
  - Emit `roundSummary` event to all clients.
- Server handler for `startNextRound`: if the new dealer-team's current rank > A, set phase `gameOver` (DR-010); otherwise re-deal and advance to bidding.
- Client `views/RoundSummary.tsx` + `views/GameOver.tsx`.

### Step 15 — Playwright e2e (2 commits)

**Chunk A — Playwright bootstrap**:
- `tests/e2e/playwright.config.ts`: `webServer` starts `pnpm dev` (with a flag to skip if already running); 4 browser contexts.
- `tests/e2e/fixtures.ts`: helper to spin up a room with 4 contexts.

**Chunk B — flow tests**:
- `lobby.spec.ts`: create + invite-link join + sit + ready + start.
- `hand-privacy.spec.ts`: each browser sees only its own hand by `data-testid`.
- `bidding.spec.ts`: bidding UI shows up; legal call advances phase.
- `kitty.spec.ts`: dealer kitty UI; 8-card discard required.
- `table.spec.ts`: game-table renders trick area, team levels, trump, defender points, turn indicator.
- `responsive.spec.ts`: 375px-wide viewport; primary action buttons remain visible/tappable.
- The full single-trick / pair-trick / tractor-trick deterministic flows happen in `packages/server` integration tests using fixtures, not Playwright (Playwright stays at the UI smoke level to keep e2e runtime bounded).

### Step 16 — responsive polish (1 commit)
- Tailwind breakpoints; CSS grid table on `md+`, flex column on `<md`; horizontal scroll on hand at narrow widths.

### Step 17 — README finalize (1 commit)
- Top-down: prerequisites (Node ≥20, pnpm ≥9), install, `pnpm dev`, open four tabs at `http://localhost:5173`, walkthrough of creating + joining + starting + playing a round.
- LAN play: how to find the host's LAN IP (`ipconfig getifaddr en0` on macOS), how Vite needs `--host 0.0.0.0`, how to set `VITE_SERVER_URL=http://<lan-ip>:3001` (and the server `CORS_ORIGIN=http://<lan-ip>:5173`).
- Testing: `pnpm test` (unit + integration), `pnpm test:e2e` (Playwright).
- Troubleshooting: SQLite file location, how to wipe (`rm packages/server/data/shengji.sqlite*`), how to view server logs.

## Files likely to change

Workbench-relative (everything is under the worktree of the new repo):

```
shengji-browser-game/package.json
shengji-browser-game/pnpm-workspace.yaml
shengji-browser-game/.gitignore
shengji-browser-game/.npmrc
shengji-browser-game/tsconfig.base.json
shengji-browser-game/.editorconfig
shengji-browser-game/.prettierrc
shengji-browser-game/README.md
shengji-browser-game/packages/shared/package.json
shengji-browser-game/packages/shared/tsconfig.json
shengji-browser-game/packages/shared/src/index.ts
shengji-browser-game/packages/shared/src/types.ts
shengji-browser-game/packages/shared/src/cards.ts
shengji-browser-game/packages/shared/src/trump.ts
shengji-browser-game/packages/shared/src/plays.ts
shengji-browser-game/packages/shared/src/followSuit.ts
shengji-browser-game/packages/shared/src/trick.ts
shengji-browser-game/packages/shared/src/bidding.ts
shengji-browser-game/packages/shared/src/scoring.ts
shengji-browser-game/packages/shared/test/*.test.ts
shengji-browser-game/packages/server/package.json
shengji-browser-game/packages/server/tsconfig.json
shengji-browser-game/packages/server/src/index.ts
shengji-browser-game/packages/server/src/db/sqlite.ts
shengji-browser-game/packages/server/src/rooms/roomManager.ts
shengji-browser-game/packages/server/src/rooms/codes.ts
shengji-browser-game/packages/server/src/rooms/tokens.ts
shengji-browser-game/packages/server/src/socket/handlers.ts
shengji-browser-game/packages/server/src/socket/projection.ts
shengji-browser-game/packages/server/src/reducers/gameReducer.ts
shengji-browser-game/packages/server/src/test/fixtures.ts
shengji-browser-game/packages/server/test/integration/*.test.ts
shengji-browser-game/packages/server/data/.gitkeep
shengji-browser-game/packages/client/package.json
shengji-browser-game/packages/client/tsconfig.json
shengji-browser-game/packages/client/vite.config.ts
shengji-browser-game/packages/client/tailwind.config.js
shengji-browser-game/packages/client/postcss.config.js
shengji-browser-game/packages/client/index.html
shengji-browser-game/packages/client/src/main.tsx
shengji-browser-game/packages/client/src/App.tsx
shengji-browser-game/packages/client/src/index.css
shengji-browser-game/packages/client/src/lib/socket.ts
shengji-browser-game/packages/client/src/lib/session.ts
shengji-browser-game/packages/client/src/state/*.ts
shengji-browser-game/packages/client/src/pages/Landing.tsx
shengji-browser-game/packages/client/src/pages/Room.tsx
shengji-browser-game/packages/client/src/views/Lobby.tsx
shengji-browser-game/packages/client/src/views/Bidding.tsx
shengji-browser-game/packages/client/src/views/Kitty.tsx
shengji-browser-game/packages/client/src/views/GameTable.tsx
shengji-browser-game/packages/client/src/views/RoundSummary.tsx
shengji-browser-game/packages/client/src/views/GameOver.tsx
shengji-browser-game/packages/client/src/components/SeatCard.tsx
shengji-browser-game/packages/client/src/components/HandCard.tsx
shengji-browser-game/packages/client/src/components/TrickArea.tsx
shengji-browser-game/packages/client/src/components/ui/*.tsx  (shadcn primitives)
shengji-browser-game/tests/e2e/package.json
shengji-browser-game/tests/e2e/playwright.config.ts
shengji-browser-game/tests/e2e/*.spec.ts
shengji-browser-game/tests/e2e/fixtures.ts
```

Plus deletions: `shengji-browser-game/backend/`, `shengji-browser-game/frontend/`, `shengji-browser-game/docs/`.

## Data model changes

This is a greenfield repo, so there are no migrations from a prior schema — only the initial creation. The SQLite schema and the in-memory `GameState` are both defined in this run.

### SQLite (in `packages/server/data/shengji.sqlite`)

```sql
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  host_player_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- room-level status: "active" | "archived"
  public_code TEXT UNIQUE NOT NULL,
  state_json TEXT NOT NULL,        -- serialized GameState
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_sessions (
  session_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  reconnect_token TEXT NOT NULL,
  connected INTEGER NOT NULL,      -- 0 | 1
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms (room_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_sessions_room ON player_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_token ON player_sessions(reconnect_token);
```

### In-memory game state shape

Authoritative `GameState` matches the brief's TypeScript definition verbatim. The projection module derives:

- `PublicGameState = Omit<GameState, "hands" | "kitty"> & { handCounts: Record<PlayerId, number> }` — what every connected client receives on `publicRoomState`. Note `kitty` is omitted entirely (defender-side spoilers); `lastRoundSummary` exposes kitty points only at scoring time.
- `PrivatePlayerState = { hand: Card[]; isDealer: boolean; kittyView?: Card[] }` — sent only to its owner. `kittyView` is set only for the dealer during the `kitty` phase and is the dealer's now-33-card view (their original 25 + the 8 kitty).

`reconnect_token` is **never** included in any projection. It returns once on `createRoom` / `joinRoom` / `resumeSession` direct ack to the requesting socket.

## UI changes

The client is greenfield. Views map 1:1 to the brief:

- `Landing` — name input, create button, code input, join button, optional rejoin prompt sourced from localStorage.
- `Lobby` — room code + copy-link, 4 seat cards (grouped Team A/B), ready toggle, start button (host), remove/reset (host), error area.
- `Bidding` — trump rank display; list of callable suits (computed locally for UX; server is the source of truth); pass button; dealer-choice fallback when all four pass.
- `Kitty` — dealer-only view of 33-card hand with selection counter; discard button enabled at exactly 8 selected.
- `GameTable` — status bar (phase, dealer, trump, defender points, turn indicator), four-player layout, current trick area, hand at bottom, action buttons.
- `RoundSummary` — defender points breakdown, kitty bonus details, level changes, next dealer, "Start next round".
- `GameOver` — winning team + reset.

### Component inventory (shadcn primitives only)
`Button`, `Input`, `Card`, `Badge`, `Dialog`, `Select`, `Separator`, `Tooltip`, `Sonner` toast — installed via the shadcn CLI into `packages/client/src/components/ui/`. No other shadcn / Radix components.

### `data-testid` policy
Every clickable / actionable element used by Playwright gets a stable `data-testid`. Convention: `kebab-case`, scoped by view. Examples:

- `landing-name-input`, `landing-create-button`, `landing-code-input`, `landing-join-button`, `landing-rejoin-button`.
- `lobby-room-code`, `lobby-copy-link`, `lobby-seat-{0..3}`, `lobby-ready-toggle`, `lobby-start-button`, `lobby-error`.
- `bidding-call-{suit}`, `bidding-pass`, `dealer-choose-{suit}`.
- `kitty-card-{cardId}`, `kitty-discard-button`, `kitty-selection-count`.
- `hand-card-{cardId}`, `play-button`, `trick-play-{seat}`, `status-phase`, `status-dealer`, `status-trump-rank`, `status-trump-suit`, `status-defender-points`, `status-turn`, `player-summary-{seat}`.
- `round-summary-defender-points`, `round-summary-kitty-points`, `round-summary-next-round-button`.
- `game-over-winner`, `game-over-reset-button`.

### Responsive layout
- `md+`: 4-corner grid. The current trick area sits center; seats 0/1/2/3 occupy N/E/S/W slots; the visitor is always rotated to the bottom (south) regardless of their seat number; status bar across the top; action panel near the bottom.
- `<md`: vertical stack — status bar → current trick → other players summary (3 compact tiles) → hand (horizontal scroll) → action buttons.

## Test plan

### Vitest unit tests (`packages/shared/test/`)
Mirrors the brief's "Shared unit tests" list one-for-one:
- `cards.test.ts` — 108-card deck, unique IDs across decks, `pointValue`, `deckPoints` totals to 200.
- `trump.test.ts` — `isTrump`, `effectiveSuit`, `compareCards` total ordering; off-suit trump-rank tie behavior (DR-007).
- `plays.test.ts` — pair detection (including two-deck duplicates, joker pairs), tractor detection (2-pair, 3-pair, gapped negatives, mixed-suit negatives), invalid play classification, joker-no-suit-tractor.
- `followSuit.test.ts` — singles, pairs, tractors, off-suit make-up rule.
- `trick.test.ts` — trick winner for singles, pairs, tractors; trump beats non-trump; structured beats unstructured at same count.
- `scoring.test.ts` — defender point tallying, kitty 2x multiplier on/off, all six bands, rank advancement (K→A→game-over).
- `bidding.test.ts` — `canCall` returns true only when the player holds at least one card with `rank === trumpRank` in the candidate suit.

### Vitest server integration tests (`packages/server/test/integration/`)
Mirrors the brief's "Server integration tests" list:
- `createAndJoin.test.ts`, `seatsAndReady.test.ts`, `bidding.test.ts`, `kitty.test.ts`, `play.test.ts`, `handPrivacy.test.ts`, `defenderPoints.test.ts`, `roundSummary.test.ts`, `nextRound.test.ts`, `reconnect.test.ts`, `restartResume.test.ts`, `fixtures.test.ts`.
- Each test boots the real Express+Socket.IO server on an ephemeral port, against an ephemeral SQLite file (`mkdtemp` per test), then tears down.

### Playwright e2e (`tests/e2e/`)
Six smoke flows listed in step 15 Chunk B. Bounded runtime (target < 60s total).

## QA plan

Manual QA after `pnpm test` (unit + integration) is green and `pnpm test:e2e` (Playwright) is green:

1. `pnpm install && pnpm dev` on a fresh checkout; verify both ports come up cleanly.
2. Open four Chrome tabs at `http://localhost:5173`; perform the 4-tab happy path (QA scenario 1 from the brief).
3. Use the invite-link button rather than the code (QA scenario 2).
4. Refresh one tab mid-lobby and again mid-round (scenarios 3 & 4).
5. Ctrl-C the server, restart, verify clients reconnect (scenario 5).
6. Mobile-viewport smoke at 375px (scenario 23).
7. The fixture-driven scenarios (15, 16, 17, 18) are covered by integration tests, not manual QA — they would require fixture endpoints we deliberately gate behind `NODE_ENV === "test"`.

The QA report records the manual results and references the test suites for the deterministic ones.

## Risks

1. **Tractor adjacency under trump ordering** — when trump suit and trump rank interact, the "consecutive rank" relation that defines tractor adjacency among trump cards is fuzzy. The brief calls out "Trump tractors use trump effective suit and trump ordering" but does not pin down whether `2♥ 2♥ + 2♦ 2♦` is a tractor when trump-rank is 2 (different printed suits, both trump-rank, both trump). DR-008 addresses with an explicit rule. Mitigation: a focused unit-test block covers the edge cases we pick; if a future user reports differently we revisit.
2. **Sheng-Ji-rule edge cases** — different regional variants differ on, e.g., off-suit follow rules, throws, and dealer-determines-trump after a robbery. The brief explicitly excludes throws and no-trump; we apply the simplest off-suit make-up rule (ASM-2). Risk: the user expects a regional variant we didn't implement. Mitigation: ASM-2 is recorded; deviations are easy to fix at follow-up time.
3. **better-sqlite3 native build on macOS** — `better-sqlite3` is a native module. On macOS arm64 with the user's pnpm cache it generally works but can fail under unusual Node versions. Mitigation: README documents `pnpm rebuild better-sqlite3` and Node ≥ 20.
4. **Tailwind + shadcn install footprint** — the shadcn CLI mutates `tsconfig`, `tailwind.config`, and adds Radix peer deps. Each shadcn add is committed separately so a future bounce can revert it cleanly.
5. **Playwright runtime in CI-less local** — Playwright downloads browser binaries on first run (~250 MB). Mitigation: README documents `pnpm exec playwright install chromium` as a one-time setup; only Chromium is exercised (no firefox/webkit).
6. **Socket reconnect storms** — Socket.IO's auto-reconnect plus our `resumeSession` flow could double up on simultaneous restarts. Mitigation: `withRoomLock` serializes mutations per room; the server tolerates duplicate `resumeSession` events idempotently.
7. **Scope creep** — the brief is long. We resist adding host succession, spectator mode, throws, or any UI polish beyond the listed minimum.
8. **Off-suit follow-suit on tractors is genuinely complex** — the brief's rule "If a follower cannot match the structure but has cards in the led effective suit, they must play as many cards as required from that effective suit" is implementable but has subtle cases (e.g. holder has 1 pair + 2 singletons in led suit when lead is 2-pair tractor). DR-011 records the resolution.
9. **Sheng-Ji is a 2-deck card game which complicates standard pair/tractor logic** — pair / tractor detection must allow two physically distinct cards with same `(rank, suit)` to form a pair. Tests directly cover this (`plays.test.ts`).

## Definition of done

A reviewer can:
1. Clone the worktree, `pnpm install`, `pnpm dev`, and reach the landing page in a browser.
2. Open four tabs and play through a full round (lobby → bidding → kitty → playing → scoring → next round).
3. Refresh a tab mid-round; the same player returns to the same seat with the same hand.
4. Stop and restart the server; the same room rehydrates from SQLite.
5. Run `pnpm test` and see Vitest unit + integration suites green, with at minimum the test names from the brief present.
6. Run `pnpm test:e2e` and see Playwright green, with at minimum the six smoke specs.
7. Read the README and find: install, dev, four-tab walkthrough, LAN play instructions, and how to wipe persisted data.

The Definition of Done aligns to the brief's Acceptance Criteria 1–16. No item is dropped.

## Preflight

| Check | Status | Notes |
|---|---|---|
| `repo_path` exists | ✅ | `/Users/timothy.shee/GitHub/shengji-browser-game` |
| `repo_name` resolved | ✅ | `shengji-browser-game` |
| `base_ref` resolves | ✅ | `HEAD` → initial commit `9bb6398` |
| `branch_name` derived | ✅ | `agent/shengji-browser-game` |
| `worktree_name` derived | ✅ | `shengji-browser-game` |
| pnpm available | ⚠️ | Will verify in build session via `command -v pnpm`; install if absent (`npm i -g pnpm`). Pinned via `packageManager` field in root `package.json`. |
| Node ≥ 20 available | ⚠️ | Will verify in build session via `node --version`. |
| Existing repo state | ✅ | Repo has one commit; tree has placeholder `backend/`, `frontend/`, `docs/`, `README.md`. Plan accounts for deleting placeholders. |
| Workbench config compatible | ✅ | `monorepo_default_for_new_repos: true` matches our pnpm-monorepo plan. |

Warnings: none blocking. The pnpm and Node availability checks happen at the start of the build stage and surface as `Commands run` entries in `build.md` so the reviewer sees the environment versions.

## Decisions & assumptions

### DR-001
- **Decision**: Delete the workbench's default `backend/`, `frontend/`, `docs/` placeholder directories and replace with the brief-specified pnpm monorepo layout (`packages/{client,server,shared}` + `tests/e2e`).
- **Rationale**: The brief's directory shape is part of the acceptance criteria; the placeholders are scaffolding artifacts not requirements.
- **Alternatives considered**: keep `backend/` for the server and `frontend/` for the client and avoid `packages/`.
- **Why not the alternatives**: the brief specifies `/packages/` explicitly; honoring the brief beats accommodating scaffolding defaults.

### DR-002
- **Decision**: Public room code is 6-character uppercase alphanumeric using the alphabet `[A-Z0-9]` minus visually-confusable characters (`0/O`, `1/I/L`). Effective alphabet of 32 → ≈1.07B codes.
- **Rationale**: Short enough to read aloud; ambiguity-free for typing; collision-resistant for any plausible local-host count.
- **Alternatives considered**: UUID v4; 4-character codes; word-pair codes ("happy-tiger").
- **Why not the alternatives**: UUIDs are too long for verbal sharing; 4 chars collides too easily; word pairs add dependency on a wordlist and don't materially help here.

### DR-003
- **Decision**: Reconnect token is `crypto.randomBytes(32).toString("base64url")` (43 chars). Stored only in SQLite + browser localStorage. Never broadcast.
- **Rationale**: Cryptographically random; URL-safe; easy to compare server-side; aligned with the brief's "do not broadcast" rule.
- **Alternatives considered**: JWT with short TTL; shorter 16-byte token.
- **Why not the alternatives**: JWT adds signing-key management and clock skew; 16 bytes is enough but 32 costs nothing and matches common conventions.

### DR-004
- **Decision**: Use `better-sqlite3` for SQLite access (synchronous API).
- **Rationale**: Simpler than `sqlite3` (callback-based) or `node:sqlite` (experimental in some LTS versions); fits a single-process Node server.
- **Alternatives considered**: `sqlite3` (async), `node:sqlite` (built-in, experimental), Prisma/TypeORM.
- **Why not the alternatives**: ORMs add overhead with no payoff at this scale; `sqlite3` async adds promise plumbing for no benefit; `node:sqlite` stability is Node-version-dependent.

### DR-005
- **Decision**: Use React Router v6 for client routing.
- **Rationale**: Two routes (`/` and `/room/:publicCode`); React Router is the standard.
- **Alternatives considered**: TanStack Router, Wouter, no router.
- **Why not the alternatives**: TanStack adds type-routing we don't need; Wouter is fine but less familiar; no router would require manual history management for the join-by-link case.

### DR-006
- **Decision**: Joker pairs are allowed only when both jokers are the same kind: two small jokers form a "small-joker pair"; two big jokers form a "big-joker pair". A small + a big do NOT form a pair.
- **Rationale**: Matches standard Sheng Ji rules; matches the brief's "two cards with the same effective rank and same effective suit" definition (jokers have distinct effective rank via the `joker` discriminator).
- **Alternatives considered**: treat all jokers as one rank so any two jokers pair.
- **Why not the alternatives**: would let a small+big "pair" beat the big-joker pair, breaking the trump ordering.

### DR-007
- **Decision**: Off-suit trump-rank cards (e.g. `2♠`, `2♦`, `2♣` when trump suit is hearts and trump rank is 2) are equal-ranked among each other. When two are played sequentially in a trick, first-played wins ties.
- **Rationale**: Standard Sheng Ji; the brief lists them all at "tier 4" of the ordering without distinguishing.
- **Alternatives considered**: rank by suit (e.g. fixed C<D<H<S order); rank by player position.
- **Why not the alternatives**: arbitrary; not in the brief.

### DR-008
- **Decision**: For tractor adjacency, two pairs are "consecutive" if their effective ranks are adjacent in the trump-aware order *within the same effective suit*. Among non-trump suits, "adjacent" means adjacent in `RANKS` skipping the trump rank (since trump-rank cards in non-trump suits are trump, not in that non-trump suit). Among trump, "adjacent" means adjacent in the trump ordering, with off-suit trump-rank pairs treated as a single rank tier (so `2♣2♣ + 2♦2♦` cannot tractor; both are at the same tier). Jokers cannot extend a trump tractor (small-joker pair and big-joker pair are at distinct singleton tiers and are not "adjacent" to anything).
- **Rationale**: Matches the brief's "consecutive pairs in the same effective suit" + "jokers do not form normal suit tractors" + the spirit of tractor play in the standard rules.
- **Alternatives considered**: allow joker-pair + trump-suit-trump-rank-pair to tractor; allow cross-suit off-suit trump-rank tractors.
- **Why not the alternatives**: opens the door to ill-defined orderings that fight the brief's explicit list.

### DR-009
- **Decision**: New dealer after a round = the next player counter-clockwise from the current dealer if the dealer team retains, or the player on the defender team who is "to the right" of the previous dealer if the defender team takes over. Concretely: dealer-retention → dealer seat advances by `+2` (their partner); defender-takeover → dealer seat advances by `+1` (next clockwise seat, who is on the new dealer team).
- **Rationale**: Standard Sheng Ji rotation. Keeps clockwise turn order while making teams alternate the dealer role within the team for retention, and handing the deal to the team that just took over for takeovers.
- **Alternatives considered**: always advance by +1 regardless of takeover; always advance by +2.
- **Why not the alternatives**: +1 means the same player keeps dealing on retention; +2 means after takeover the new dealer is on the wrong team.

### DR-010
- **Decision**: Game over fires when the band-applied level advance would push the dealer team's level past A. We still emit the `roundSummary` showing the would-be advance, but set phase to `gameOver` instead of `scoring`. The winning team is the dealer team at the moment of advance.
- **Rationale**: Brief says "If a team levels past A, show game over". This is the literal reading.
- **Alternatives considered**: cap the level at A (no game over); require landing exactly on A to win.
- **Why not the alternatives**: cap-no-game-over makes the game never end; require-exact-A complicates the bands.

### DR-011
- **Decision**: Off-suit follow on a structured lead — when a follower has cards in the led effective suit but cannot match the structure: (a) for a pair lead, they must play all pairs of the led suit they hold first, then any singles of that suit, then off-suit fill to count; (b) for a tractor lead of length N pairs (2N cards), they must play all pairs of the led suit they hold up to N pairs, then any single cards of that suit up to remaining count, then off-suit fill. They are not required to play their *best* pairs/singles in the led suit, only sufficient cards from it.
- **Rationale**: Standard Sheng Ji; the brief's wording maps to this. The "any pair / any single" relaxation avoids forcing greedy-play search.
- **Alternatives considered**: require the follower to play their highest cards in the led suit first.
- **Why not the alternatives**: not in the brief, harder to implement and to validate.

### DR-012
- **Decision**: Server logs go to stdout (Node) at INFO level by default. No logging library; just a tiny `log.ts` wrapper around `console.log` with structured fields.
- **Rationale**: No production deployment; stdout is enough.
- **Alternatives considered**: pino, winston.
- **Why not the alternatives**: adds dependency footprint with no payoff at this scale.

### DR-013
- **Decision**: Vite proxies `/socket.io` and the REST surface (if any) to `http://localhost:3001` in dev. Production-mode Vite build is not configured (out of scope).
- **Rationale**: Simplest cross-origin story for local dev.
- **Alternatives considered**: CORS-allow specific origins on the server.
- **Why not the alternatives**: CORS works too but the proxy is simpler and matches LAN play (one Vite-served URL).

### DR-014
- **Decision**: Test-fixture loader is registered as a socket event (`__loadFixture`) gated by `process.env.NODE_ENV === "test"`. The check happens at handler registration so the event is *not registered at all* in dev / prod.
- **Rationale**: Brief says "Do not expose fixture loading in normal development or production mode." Not registering the handler is stronger than rejecting calls at runtime.
- **Alternatives considered**: separate test-only HTTP endpoint; SQL injection of fixture state.
- **Why not the alternatives**: a registered-but-rejecting handler still announces the surface; SQL injection bypasses the socket layer the tests want to exercise.

### ASM-001
- **Text**: Off-suit trump-rank cards rank equal to each other (DR-007 details).
- **Reason**: Brief lists them at tier 4 without sub-ordering.
- **Impact**: medium.

### ASM-002
- **Text**: When a follower has no cards in the led effective suit, they may play any cards to make up the count — no "must trump" rule.
- **Reason**: Standard simplest variant; brief excludes throws and doesn't mandate over-trumping.
- **Impact**: medium.

### ASM-003
- **Text**: "Final trick" of a round = whichever trick empties all four hands.
- **Reason**: Brief's "If defenders win the final trick" wording.
- **Impact**: low.

### ASM-004
- **Text**: Six-character alphanumeric room codes are sufficient; collisions auto-retry.
- **Reason**: Local-host scale.
- **Impact**: low.

### ASM-005
- **Text**: Reconnect tokens are 32-byte base64url.
- **Reason**: Aligned with `crypto.randomBytes` conventions.
- **Impact**: low.

### ASM-006
- **Text**: Invite link format is `http://<host>:5173/room/<publicCode>`.
- **Reason**: README documents how to swap the LAN IP.
- **Impact**: low.

### ASM-007
- **Text**: Player ID is stable for the room's life; session ID rotates on `resumeSession`.
- **Reason**: Cleaner separation; the brief implies both.
- **Impact**: low.

### ASM-008
- **Text**: No host-successor logic; if host disconnects the room idles until host returns or someone manually leaves.
- **Reason**: Brief lists "remove disconnected unready players" as a *host* control; no symmetric "promote a new host" affordance.
- **Impact**: medium.

### ASM-009
- **Text**: One in-flight intent per player; mutations per room are serialized.
- **Reason**: Node single-thread + `withRoomLock` suffices.
- **Impact**: low.

### ASM-010
- **Text**: Spectators / new joins after lobby phase are rejected.
- **Reason**: Brief's join workflow requires lobby phase.
- **Impact**: low.

### ASM-011
- **Text**: Dealer must choose one of the four suits when all four pass; "no trump" is not allowed.
- **Reason**: No-trump is an explicit non-goal.
- **Impact**: low.

### ASM-012
- **Text**: Kitty 2x bonus only on defenders winning the *final* trick (not other point-bearing tricks).
- **Reason**: Brief wording.
- **Impact**: low.

### ASM-013
- **Text**: Round 1 dealer team is Team A (seats 0+2), starting at level 2.
- **Reason**: Brief's "First round dealer is seat 0" + "both teams start at rank 2".
- **Impact**: low.

### ASM-014
- **Text**: Tractor adjacency uses the rule in DR-008.
- **Reason**: The brief leaves trump tractor adjacency partly under-defined.
- **Impact**: high — directly affects validator behavior.
