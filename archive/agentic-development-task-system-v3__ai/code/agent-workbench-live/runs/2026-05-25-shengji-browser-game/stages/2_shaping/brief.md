# Brief

## Goal

Build a playable local-first multiplayer web browser implementation of Sheng Ji / Tractor (升级 / 拖拉机). A human host opens a browser tab, creates a room, and shares a room code or invite link with three friends. All four browsers connect to a local Node server, the server deals 108 cards (two decks plus jokers) from an authoritative shuffle, players play singles / pairs / tractors in clockwise order, and a round summary updates each team's "level" rank. The whole stack runs locally — `pnpm install` + `pnpm dev` is sufficient — and is backed by Vitest unit tests, Vitest+socket.io-client server integration tests, and Playwright multi-context browser integration tests.

The product is a **vertical-slice MVP**: lobby, deal, bidding, kitty, single trick play, pair trick play, tractor trick play, scoring, next round, reconnect, restart-resume. Not a polished product; not a hosted service.

## User-facing behavior

### Landing view
- Visitor sees an input for display name, a "Create room" button, an input for a room code, and a "Join room" button.
- If the visitor has a recently-used room in localStorage (room code + reconnect token), a "Rejoin <code>" prompt appears.
- Submitting "Create room" with a non-empty name creates a fresh room on the server, seats the visitor in seat 0 as host, and navigates the browser to `/room/<publicCode>`.
- Submitting "Join room" with a room code and a non-empty name connects to the existing room (if it exists, is in lobby phase, and has fewer than four players) as an unseated player, then navigates to `/room/<publicCode>`.
- Visiting an invite link (`/room/<publicCode>` or similar) without a session prompts for a display name first.

### Lobby view (`/room/<publicCode>`, phase = `lobby`)
- Shows the room code prominently and a "Copy invite link" button.
- Shows the visitor's own name, with a "Host" badge if they are the host.
- Four seat cards arranged so seats 0 and 2 are labeled Team A and seats 1 and 3 are labeled Team B.
- Each seat shows the seated player's name (if any), connected/disconnected indicator, and ready status.
- An empty seat is selectable by any player not currently seated; clicking it moves the player into that seat.
- A "Ready" toggle for the visitor's own seat.
- A "Start game" button visible only to the host. Enabled only when all four seats are filled, all four players are connected, and all four are ready. When disabled, the UI shows the reason (e.g. "Need 4 seated and ready players to start").
- The host has a "Remove" affordance next to disconnected unready seated players (lobby only).
- The host has a "Reset room" affordance (lobby only).
- A toast / error area surfaces server rejection messages.

### Game view (phase ∈ {`dealing`, `bidding`, `kitty`, `playing`})
- Status panel: current phase, dealer indicator (seat + name), trump rank, trump suit (or "—" before bidding completes), team levels for Team A / Team B, defender points so far this round, current turn indicator (seat + name).
- Around the table: the other three players, each shown with name, seat number, team color, card count remaining, and connected/disconnected status. Layout is roughly four-corners on desktop and a vertical stack on narrow screens.
- The visitor's own hand is shown at the bottom (or in the stacked-mobile order: status → current trick → other players summary → hand → action buttons). Cards are clickable / tappable to select; selected cards are visually distinguished.
- Current trick area in the center: the cards played this trick, one per player, in seat order, with the leader highlighted.
- A phase-specific action panel:
  - **Bidding panel**: shows the trump rank for this round, lists suits the visitor is allowed to call (each suit they hold at least one card of the trump rank in), a button per legal suit, and a "Pass" button. If all four players pass, the dealer sees an additional "Choose trump suit" panel with all four suits enabled.
  - **Kitty panel** (dealer only, phase = `kitty`): dealer sees their hand including the 8 cards picked up from the bottom. A "Discard selected" button is enabled only when exactly 8 cards are selected.
  - **Trick play panel** (phase = `playing`): "Play selected cards" button. Active only when it's the visitor's turn and the selection forms a legal play given the lead.

### Round summary view (phase = `scoring`)
- Defender trick points captured this round.
- Kitty points and whether the kitty multiplier (2x) applied.
- Final defender score for the round.
- Outcome label: dealer team held, or defenders take over.
- Level changes for both teams (e.g. "Team A: 2 → 4", "Team B: 2 → 2").
- Next dealer (seat + name).
- "Start next round" button visible to the host or to the next dealer.

### Game over view (phase = `gameOver`)
- Triggered when a team levels past A.
- Shows the winning team.
- "Reset room" returns to lobby.

### Reconnect behavior
- On every successful join / create / sit, the client stores `{ publicCode, playerId, reconnectToken }` in localStorage.
- On page load, if localStorage has a valid-looking entry, the client attempts `resumeSession` before showing the join form.
- If the server accepts the reconnect token, the player keeps their seat and their hand. Other clients see the player flip from disconnected back to connected.
- If the token is invalid (room gone, token rotated, player evicted), the client falls back to the join flow and clears the stale entry.

### Server restart resume
- Stopping the Node server and restarting it does not erase rooms. On startup, the server reads persisted rooms from SQLite, rehydrates them into the in-memory cache, and clients that reconnect with a valid token find their state intact (modulo each client needing to reconnect the socket).

## Acceptance criteria

A reviewer following the README on a fresh checkout can do all of these:

1. `pnpm install` succeeds at the repo root and resolves the workspace.
2. `pnpm dev` starts both the client (port 5173) and the server (port 3001).
3. Open four browser tabs (or four browser contexts). One creates a room; three join by room code or invite link. All four can sit, ready, and the host can start.
4. Refreshing any player's tab keeps them as the same player, same seat, same hand. Other players see them disconnect and reconnect.
5. Stop the server, restart it; clients reconnect and find the same room state in the same phase.
6. Each player sees only their own hand; the public state pushed to other clients never reveals private hands.
7. Trump selection works: a legal bidder can call; bidders without the right cards cannot; if everyone passes, the dealer can pick.
8. Dealer kitty discard works: exactly 8 cards required; any other count is rejected by the server.
9. Singles, pairs, and tractors are playable. Illegal plays (wrong count, wrong follow-suit, attempting to outrank a structured lead with an unstructured group) are rejected by the server.
10. Tricks resolve correctly: trump beats non-trump; higher pair beats lower pair; same-length higher tractor beats lower; the winner leads the next trick.
11. Defender points accumulate as defenders win point-card-bearing tricks (5 = 5pt, 10 = 10pt, K = 10pt; 200 total across both decks).
12. Round summary shows defender points, kitty points (with 2x multiplier when defenders take the final trick), and the resulting level changes per the bands below. A "Start next round" advances state with the new dealer.
13. The `packages/shared` Vitest suite passes.
14. The `packages/server` Vitest integration suite passes, including the fixture-based deterministic trick scenarios.
15. The Playwright suite under `tests/e2e` passes, including a mobile-width smoke test.
16. README explains how to run locally, how to open four tabs, how to invite, how to play a round, and how another device on the same LAN can connect.

Scoring bands the implementation must enforce:
- 0–35 defender points: dealer team levels up by 2.
- 40–75 defender points: dealer team levels up by 1.
- 80–115 defender points: defenders become dealer team; no level gain.
- 120–155 defender points: defenders become dealer team and level up by 1.
- 160–195 defender points: defenders become dealer team and level up by 2.
- 200+ defender points: defenders become dealer team and level up by 3.

Rank progression: `2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A`. Leveling past A ends the game with the dealer-team-of-record as the winner.

## Non-goals

Explicitly NOT in scope for this run:
- Account login or any identity beyond a display name + reconnect token.
- AI bots, even a "fill empty seats" stub.
- Spectators or watch-only mode.
- In-game chat or emoji reactions.
- Throws (甩牌) — multi-component plays that force opponents to match each component.
- No-trump rounds.
- Alternative regional rule variants (Shanghai vs. Beijing scoring, different dealer-determines-trump rules, etc.).
- Counter-clockwise variant.
- Production deployment, TLS, hosting, public matchmaking, lobby browser, persistent player accounts across rooms.
- Mobile polish beyond "responsive enough that no important action is offscreen at narrow widths."
- Accessibility audit beyond using semantic HTML and keyboard-focusable controls.
- Internationalization or localization.
- Persisting completed rounds for replay / history beyond what's needed for the current round's display.

## Good examples

- **Server is authoritative**: a client sending `playCards` with cards that aren't in their server-side hand gets an `errorMessage` and no state change broadcasts; the client's UI rolls back its optimistic selection.
- **Public/private split**: the broadcast after a `playCards` includes which cards each seat played that trick (those are publicly visible), the trick winner, and updated defender points. The same broadcast does NOT include any other player's remaining hand. Each player receives a separate `privatePlayerState` event with their own hand.
- **Pair detection across decks**: with two decks, the spec calls out that two physically distinct copies of `7♠` form a legal pair. The rule engine recognizes this.
- **Tractor**: leading `6♠ 6♠ 7♠ 7♠` when spades are not trump and neither rank is trump rank is a 2-pair tractor. The engine classifies it, validates follower attempts, and beats it only with a same-length-or-longer same-suit higher tractor.
- **Trump ordering**: when trump rank = 2 and trump suit = hearts, the trump order from highest is: big joker, small joker, `2♥`, the other `2♥` copy, `2♠`/`2♦`/`2♣` (the three off-suit twos, all trump but lower than the trump-suit two), then high-to-low hearts (`A♥, K♥, Q♥, ...`). A `2♣` beats any non-trump card.
- **Effective suit**: when trump rank = 5 and trump suit = clubs, the `5♥` is trump, not a heart for follow-suit purposes. A heart lead does not force the holder of `5♥` to play it.
- **Reconnect**: a player refreshes their tab mid-round; their hand reappears intact; the trick still in progress is shown with the seats that have already played; their turn indicator is preserved if it was theirs.
- **Restart resume**: the dev kills the server (Ctrl-C), restarts it, and the four browsers (still open) reconnect via stored tokens to the same room in the same phase, with the same hands.

## Bad examples

- A client computes its own shuffle and tells the server the deal order. ❌ The server shuffles.
- A client computes the trick winner and tells the server who won. ❌ The server computes.
- The server broadcasts `{ hands: { p1: [...], p2: [...], p3: [...], p4: [...] } }` to everyone. ❌ Hands are private per-recipient.
- The kitty is sent to all clients during the kitty phase so the UI can render the dealer's pick. ❌ Only the dealer receives the kitty cards.
- Clicking "Start game" with only 3 ready players starts the game with a bot in seat 3. ❌ No bots; the button stays disabled.
- A reconnect token is logged to the public room state. ❌ Tokens stay private to the owning session.
- "Play selected cards" sends two singles when the lead was a pair, the client validates locally, the play sneaks through, and the server treats it as a pair. ❌ The server rejects the play with an `errorMessage`.
- The server stores game state only in memory; a restart wipes everything. ❌ SQLite persistence is the source of truth for recovery.

## Constraints

### Stack (non-negotiable)
- **Monorepo manager**: pnpm workspaces.
- **Client**: React + TypeScript + Vite. Runs on `http://localhost:5173`.
- **Server**: Node.js + TypeScript + Express + Socket.IO. Runs on `http://localhost:3001`.
- **Shared package**: TypeScript-only. Types, card model, rule engine (trump detection, effective suit, ordering, pair/tractor detection, follow-suit validation, trick winner, scoring, level progression). Pure where possible. No socket or DB dependencies.
- **Styling**: Tailwind CSS. UI components: shadcn/ui — and only the simple ones (Button, Input, Card, Badge, Dialog, Select, Separator, Tooltip, Sonner/Toast).
- **Persistence**: SQLite. File at `packages/server/data/shengji.sqlite` (gitignored). Schema created on startup. Transactions for multi-step writes.
- **Tests**: Vitest (shared unit + server integration), Playwright (browser e2e).
- **TypeScript strict mode** across all packages.

### Repository structure
```
shengji-browser-game/
  packages/
    client/      # React + Vite app
    server/      # Express + Socket.IO server, SQLite persistence
    shared/      # Types, card model, rule engine, validators, reducers
  tests/
    e2e/         # Playwright browser integration tests
  package.json
  pnpm-workspace.yaml
  README.md
```

### Architecture
- Server is authoritative for all game state. Clients send intents (socket events listed below). Clients never compute shuffles, deals, legal moves, trick winners, scores, or level changes.
- All rule logic lives in `packages/shared`. Socket handlers in `packages/server` are thin wrappers around `shared` validators and reducer-style transitions.
- After every successful state transition, persist the room's `state_json` to SQLite. Multi-step updates wrap in a transaction.
- In-memory room cache for active games; SQLite is the recovery source on restart.

### SQLite schema (minimum)
- `rooms(room_id TEXT PK, host_player_id TEXT NOT NULL, status TEXT NOT NULL, public_code TEXT UNIQUE NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
- `player_sessions(session_id TEXT PK, room_id TEXT NOT NULL, player_id TEXT NOT NULL, display_name TEXT NOT NULL, reconnect_token TEXT NOT NULL, connected INTEGER NOT NULL, last_seen_at TEXT NOT NULL)`
- Reconnect tokens are never broadcast and never logged. They live in browser localStorage on the client and in `player_sessions.reconnect_token` on the server.

### Card model
```
type Suit = "clubs" | "diamonds" | "hearts" | "spades";
type Joker = "small" | "big";
type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A";
type Card = { id: string; deckId: 1 | 2; suit?: Suit; rank?: Rank; joker?: Joker };
```
- Each of the 108 physical cards has a unique `id`. Two physical copies of `7♠` have different `id`s but the same `(suit, rank, deckId-differs)`.
- Point cards: `5` = 5 points, `10` = 10 points, `K` = 10 points. Total across both decks = 200.

### Game state
```
type GamePhase = "lobby" | "dealing" | "bidding" | "kitty" | "playing" | "scoring" | "gameOver";

type GameState = {
  roomId: string;
  publicCode: string;
  phase: GamePhase;
  players: Player[];
  seats: Array<PlayerId | null>;
  readyPlayerIds: PlayerId[];
  hands: Record<PlayerId, Card[]>;
  kitty: Card[];
  dealerSeat: number;
  currentTurnSeat: number;
  teamLevels: [Rank, Rank];   // [Team A level, Team B level]
  trumpRank: Rank;
  trumpSuit: Suit | null;
  currentTrick: TrickPlay[];
  completedTricks: CompletedTrick[];
  dealerTeamIndex: 0 | 1;
  defenderTeamIndex: 0 | 1;
  defenderPoints: number;
  lastRoundSummary?: RoundSummary;
};
```

### Game setup
- 4 players, 2 teams: Team A = seats 0 & 2, Team B = seats 1 & 3.
- 2 standard 54-card decks (jokers included) → 108 cards.
- Deal 25 to each player, leave 8 as the kitty.
- Both teams start at rank `2`. First round dealer is seat 0. Subsequent dealers are derived from scoring.
- Clockwise turn order (seats `0 → 1 → 2 → 3 → 0`).

### Trump rules
- Each round has a trump rank (= the dealer team's current level rank) and a trump suit (set in bidding).
- A card is effectively trump if it is a joker, has `rank === trumpRank`, or has `suit === trumpSuit`. Otherwise its effective suit is its printed suit.
- Trump order, high to low: big joker → small joker → trump-suit card of trump rank → other cards of trump rank (i.e. off-suit trump-rank cards, in implementation-defined inter-suit order but consistent) → other cards in trump suit (A high) → non-trump cards (within their suit, A high). Centralize in `shared`.
- Jokers are trump but do not participate in normal suit tractors.

### Bidding
- After the deal, enter the `bidding` phase.
- A player may call a trump suit if they hold at least one card with `rank === trumpRank` in that suit.
- The first valid call sets `trumpSuit` and the phase advances to `kitty`.
- If all four players pass, the dealer chooses `trumpSuit` manually.

### Kitty
- Dealer receives the 8 kitty cards into their hand for the duration of the `kitty` phase.
- Dealer must discard exactly 8 cards (any cards in their now-33-card hand). Server rejects any other count.
- Discarded kitty is hidden until scoring.
- If defenders win the **final** trick of the round, defenders capture the kitty's point total **multiplied by 2**.

### Play types
1. **Single** — one card.
2. **Pair** — two cards with the same effective rank and same effective suit. Two physical copies of the same printed card qualify.
3. **Tractor** — N consecutive pairs in the same effective suit, N ≥ 2. Trump tractors use trump ordering and treat all trump as one suit for tractor adjacency purposes (with implementation-defined ordering for trump-rank pairs etc.). Jokers do not form normal suit tractors.

### Trick play
- Dealer leads the first trick.
- Players play in clockwise seat order, one play per trick per player.
- Followers must play the same count as the lead.
- Followers must follow the lead's effective suit when possible. If the lead is a pair and the follower has a pair in that effective suit, the follower must play a pair. If the lead is a tractor and the follower can match the structure in that effective suit, they must. If the follower has cards in the led effective suit but cannot match the structure, they must play as many cards of that effective suit as required and may complete the count with off-suit cards.
- Highest valid play wins the trick. Winner leads the next.
- Trick winner collects point cards in that trick for their team's running point total (only defenders' points matter for scoring, but the engine tallies points per team).

### Comparison
- A play can beat the lead only if it matches the lead's play type and card count, **unless** it is a legal trump play against a non-trump lead.
- Trump beats non-trump.
- Within same effective suit and same structure, compare by highest relevant component (highest single for singles; higher pair for pairs; higher same-length tractor for tractors).
- A random group of high cards cannot beat a structured pair or tractor lead.

### Socket events
Client → server: `createRoom`, `joinRoom`, `resumeSession`, `leaveRoom`, `sitAtSeat`, `setReady`, `startGame`, `callTrump`, `passTrump`, `dealerChooseTrump`, `discardKitty`, `playCards`, `startNextRound`, `resetRoom`.
Server → client: `publicRoomState`, `privatePlayerState`, `errorMessage`, `toast`, `roundSummary`.

### Validation (server-enforced rejections)
- Action from a player not in the room.
- Action with an invalid reconnect / session token.
- Action in the wrong phase.
- Action from the wrong player (not their turn).
- `startGame` unless all four seats filled and ready.
- `sitAtSeat` for an occupied seat.
- `callTrump` for a suit the caller can't legally call.
- `discardKitty` unless exactly 8 cards selected.
- `playCards` referencing a card not in the player's hand.
- Out-of-turn play.
- Play with wrong card count.
- Invalid singles, pairs, or tractors as structures.
- Illegal follow-suit play.
- Illegal attempt to outrank a structured lead with an unstructured group.

### Determinism for tests
- A fixture loader is exposed only when `NODE_ENV === "test"`. It can override hands, kitty, trump rank/suit, phase, and current turn for a specific room. It is unreachable in dev or prod mode. Integration tests use it for pair / tractor scenarios.

### Developer experience
- TypeScript strict on every package.
- `data-testid` attributes on every critical UI element (seat slots, ready toggle, start button, hand cards, action buttons, trick area, round summary, error/toast region) so Playwright selectors are stable.
- Useful server logs (info-level) for: room created, player joined, player reconnected, state transition (per phase), action rejected (with reason).
- Rule functions are pure where possible. Persistence is isolated in a server storage module.

## Assumptions

The following resolve ambiguities in the raw idea without further user input. Each is recorded so the plan and the implementation can act on them.

1. **Off-suit trump-rank ordering**: the raw idea says "Other cards of trump rank" sit between the trump-suit-trump-rank card and the rest of the trump suit, but doesn't pin down inter-suit ordering among off-suit trump-rank cards. Assume off-suit trump-rank cards rank equal to each other (a player who plays the second off-suit trump-rank card to the first does not win on rank alone — first-played wins ties), and document this in `shared`.
2. **Off-suit follow when out of led suit**: when a follower has no cards in the led effective suit, they may play any cards they like to make up the count. No "must trump" rule; no over-trumping requirement.
3. **Final-trick definition**: the "final trick" is the last trick before the hands are empty (the 25th trick assuming 25 cards each post-kitty, minus 8 from the dealer = 17 tricks per round? — actually each player has 25 cards minus the dealer who discards 8 back, so 25 cards each → 25 tricks). Assume the final trick is whichever trick empties all four hands.
4. **Public code format**: 6-character uppercase alphanumeric (e.g. `7K2QXM`). Generated server-side, unique per active room.
5. **Reconnect token format**: opaque ≥ 32-byte random string base64url-encoded. Generated server-side; never broadcast; never logged.
6. **Invite link format**: `http://<server-host>:5173/room/<publicCode>`. The README explains how to substitute the host's LAN IP for cross-device play.
7. **Player ID vs session ID**: player ID is stable for the lifetime of the room and binds to the seat / hand. Session ID is rotated on each `resumeSession`. The reconnect token binds session to player.
8. **Host successor on disconnect**: not in scope. The host may disconnect; the room remains and can be resumed by the host. If the host never returns and the room is in lobby, other players may manually leave; we do not auto-promote anyone.
9. **Re-shuffles on tie / abandon**: not in scope. If the room is mid-play and the host abandons, the room sits idle until manually reset.
10. **Concurrency**: only one in-flight intent per player at a time. The server handles intents serially per room (single Node event-loop turn through the reducer); two clients submitting simultaneously to the same room are ordered by socket receive order.
11. **Spectators after game start**: the join workflow rejects new players once the phase leaves `lobby`. The room remains a fixed four-player set after start.
12. **Dealer choice of trump after universal pass**: dealer must choose one of the four suits; "no trump" is not allowed (it's an explicit non-goal). UI presents all four suits as enabled.
13. **Kitty capture only on final trick**: kitty 2x bonus applies only if defenders win the **final** trick of the round (not any trick that happens to include high-point cards). This matches the raw idea's "If defenders win the final trick" wording.
14. **First-round dealer-team-of-record**: at the start of round 1, the dealer team is team A (seats 0+2). Both teams start at level `2`. Trump rank for round 1 is `2`.

## Suggested QA scenarios

The validating stage's QA pass should at minimum exercise these end-to-end paths. Several are also Playwright targets; the rest can be covered by Vitest server-integration tests or unit tests in `shared`.

1. **Four-tab happy path**: open four contexts; one creates, three join via room code; all sit (0/1/2/3), ready, host starts; verify each context sees only its own hand and the correct public state; let the bidding panel render; call a legal trump from a holder of the trump-rank card; verify the dealer enters the kitty phase with 8 extra cards visible only to them; dealer discards 8; first trick plays out; trick area updates; round summary appears after the last trick; "Start next round" advances state.
2. **Invite link**: instead of the room code, the join browsers open the invite URL copied from the host's "Copy invite link" button.
3. **Refresh mid-lobby**: a player closes and re-opens their tab from localStorage; their seat and ready state survive.
4. **Refresh mid-round**: a player refreshes during the playing phase; their hand reappears with the right cards; the trick state is preserved on their screen.
5. **Server restart mid-round**: kill the server, wait, restart it; clients reconnect; the room rehydrates from SQLite; the same phase, hands, dealer, trump, defender points, and current trick are present.
6. **Illegal trump call**: a player who holds no card with `rank === trumpRank` in spades clicks the spades button (via dev tools, since the UI should hide it); the server rejects with `errorMessage`.
7. **Illegal play count**: a player tries to play 2 cards when the lead was a single; server rejects.
8. **Illegal follow-suit on a single**: a player holding cards of the led suit plays an off-suit card; server rejects.
9. **Illegal follow-suit on a pair**: lead is a pair of hearts; follower has a pair of hearts but plays a single heart + one off-suit; server rejects.
10. **Illegal tractor follow**: lead is a 2-pair tractor in spades; follower has a 2-pair tractor in spades but plays four singletons; server rejects.
11. **Unstructured group cannot beat a structured lead**: lead is `9♣9♣`, follower plays `A♣ + K♣`; server treats it as a non-pair attempt and the lead's pair wins.
12. **Trump beats non-trump**: non-trump lead; later seat trumps; trump wins.
13. **Higher pair beats lower pair in same effective suit**: `7♠ 7♠` lead beaten by `J♠ J♠` (when spades are not trump).
14. **Same-length higher tractor beats lower tractor**: lead is `6♠ 6♠ 7♠ 7♠`, beaten by `9♠ 9♠ 10♠ 10♠`.
15. **Defender takes final trick → 2x kitty bonus**: fixture-driven scenario where defenders win the last trick of the round; round summary shows kitty multiplier 2x and the added kitty points.
16. **Dealer team takes final trick → no kitty bonus**: same setup but dealer team wins the final trick; round summary shows 0 kitty points captured by defenders.
17. **Each scoring band**: fixture-driven rounds that land defender-points totals in each band (0–35, 40–75, 80–115, 120–155, 160–195, 200+) and assert the expected level changes and dealer-team-of-record changes.
18. **Game over past A**: fixture starts both teams at K; a round produces a level-up that would push the dealer team past A; phase → `gameOver`; reset returns to lobby.
19. **Reject join mid-game**: a fifth visitor tries to join a room whose phase is not `lobby`; server rejects.
20. **Reject duplicate seat**: two players race to click seat 2; the second is rejected.
21. **Hand secrecy**: a player inspects the public room state events they receive and finds no other player's cards.
22. **Reconnect token secrecy**: a player inspects the public room state events they receive and finds no other player's reconnect token (and not even their own — their own token came back only on `createRoom`/`joinRoom`/`resumeSession` direct responses).
23. **Mobile-width smoke**: load the lobby and game view at a narrow viewport; verify the status, current trick, others-summary, hand, and primary action button are all visible and the primary action button is tappable; cards in the hand may scroll horizontally.
24. **Reset room in lobby**: host clicks reset; everyone returns to lobby with their seats cleared.
25. **Remove disconnected unready player in lobby**: host removes a disconnected unready seated player; the seat empties; another player can sit there.
