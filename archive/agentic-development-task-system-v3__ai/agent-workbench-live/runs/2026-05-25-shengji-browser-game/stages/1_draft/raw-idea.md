# Sheng Ji Browser Game

Build a playable local-first multiplayer web browser implementation of Sheng Ji / Tractor.

The app must let one user host a room and let three other users join from their browsers using a room code or invite link. The implementation should be easy to run locally, easy to debug, and backed by automated tests that prove the lobby, multiplayer flow, and rules engine work.

Use this stack:
- Monorepo: pnpm workspaces
- Client: React + TypeScript + Vite
- Server: Node.js + TypeScript + Express + Socket.IO
- Shared package: TypeScript rule engine, types, validators, reducers
- Styling: Tailwind CSS + shadcn/ui
- Database: SQLite
- Tests: Vitest for unit and server integration tests; Playwright for browser integration tests

Repository structure:

/shengji-browser-game
  /packages
    /client
      React + Vite app
    /server
      Express + Socket.IO server
      SQLite persistence
    /shared
      Shared TypeScript types, card model, rules engine, validators, reducers
  /tests
    /e2e
      Playwright browser integration tests
  package.json
  pnpm-workspace.yaml
  README.md

Local run requirements:
- pnpm install installs everything.
- pnpm dev starts both client and server.
- Client should run on http://localhost:5173.
- Server should run on http://localhost:3001.
- README must explain how to run locally, open four browser tabs, create a room, join a room, and play through a round.
- README must explain how another device on the same LAN can connect during local development.

Core architecture:
- Server is authoritative for all game state.
- Clients only send intents.
- Never trust client-computed shuffles, deals, legal moves, trick winners, scores, or level changes.
- Put all game-rule logic in /packages/shared.
- Socket handlers should be thin wrappers around shared validation and reducer-style state transitions.
- Persist room and game state to SQLite after every successful state transition.
- On server restart, load persisted rooms from SQLite.
- Use SQLite transactions for multi-step updates.
- Keep an in-memory room cache for active games, but SQLite is the source of recovery after restart.

SQLite persistence:
- Store the SQLite file at packages/server/data/shengji.sqlite.
- Add this file to .gitignore.
- Create schema automatically on server startup.
- Minimum schema:
  - rooms:
    - room_id TEXT PRIMARY KEY
    - host_player_id TEXT NOT NULL
    - status TEXT NOT NULL
    - public_code TEXT UNIQUE NOT NULL
    - state_json TEXT NOT NULL
    - created_at TEXT NOT NULL
    - updated_at TEXT NOT NULL
  - player_sessions:
    - session_id TEXT PRIMARY KEY
    - room_id TEXT NOT NULL
    - player_id TEXT NOT NULL
    - display_name TEXT NOT NULL
    - reconnect_token TEXT NOT NULL
    - connected INTEGER NOT NULL
    - last_seen_at TEXT NOT NULL
- Do not broadcast reconnect tokens.
- Store reconnect tokens in the browser's localStorage.
- A user who refreshes the page should be able to reclaim their same player and seat.

Game setup:
- 4 players.
- 2 teams:
  - Team A: seats 0 and 2
  - Team B: seats 1 and 3
- 2 standard 54-card decks, including jokers, for 108 physical cards.
- Deal 25 cards to each player.
- Leave 8 cards as the kitty / bottom.
- Start both teams at rank 2.
- First round dealer is seat 0.
- Later dealer is determined by round scoring.
- Use clockwise play for MVP.

Card model:
type Suit = "clubs" | "diamonds" | "hearts" | "spades";
type Joker = "small" | "big";
type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";

type Card = {
  id: string;
  deckId: 1 | 2;
  suit?: Suit;
  rank?: Rank;
  joker?: Joker;
};

Each physical card must have a unique ID.

Point cards:
- 5 = 5 points
- 10 = 10 points
- K = 10 points
- Total points across two decks = 200

Game phases:
type GamePhase =
  | "lobby"
  | "dealing"
  | "bidding"
  | "kitty"
  | "playing"
  | "scoring"
  | "gameOver";

Core state:
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

  teamLevels: [Rank, Rank];
  trumpRank: Rank;
  trumpSuit: Suit | null;

  currentTrick: TrickPlay[];
  completedTricks: CompletedTrick[];

  dealerTeamIndex: 0 | 1;
  defenderTeamIndex: 0 | 1;
  defenderPoints: number;

  lastRoundSummary?: RoundSummary;
};

Public/private state:
- Public room state may include players, seats, ready state, phase, dealer, trump rank/suit, current trick, completed trick summaries, team levels, and defender points.
- Private hand state must only be sent to the player who owns that hand.
- Do not send all hands to every client.
- Do not send the hidden kitty to clients except when the dealer is in the kitty phase and needs to discard.
- At round summary, show kitty points and relevant scoring results.

Required user workflows:

Host workflow:
1. User opens the landing page.
2. User enters a display name.
3. User clicks "Create room".
4. Server creates a room, creates a player session, marks this player as host, and seats the host in seat 0 by default.
5. Client navigates to /room/:publicCode.
6. Lobby shows:
   - room code
   - copy invite link button
   - host badge
   - four seats
   - teams
   - ready status
   - connected/disconnected status
7. Host can change seats before the game starts.
8. Host waits for three other players.
9. Host can start only when:
   - all four seats are filled
   - all four players are connected
   - all four players are ready
10. If start fails, show a clear error.

Join workflow:
1. User opens an invite link or enters a room code on the landing page.
2. If the user does not already have a valid session for that room, ask for a display name.
3. Server adds the user as an unseated player if the room exists, is in lobby phase, and has fewer than four players.
4. Client navigates to /room/:publicCode.
5. User chooses an open seat.
6. User clicks ready.
7. If the room is full, missing, already in progress, or the seat is taken, show a clear error.

Reconnect workflow:
1. User refreshes the page or temporarily disconnects.
2. Client sends room code plus stored reconnect token.
3. Server restores the player session if the token is valid.
4. Player keeps the same seat and hand.
5. Other players see the player as reconnected.
6. If the token is invalid, show the join flow instead.

Host controls:
- Copy invite link.
- Start game.
- Remove disconnected unready players from lobby only before the game starts.
- Reset room before the game starts.
- Start next round after scoring.

Do not build:
- Account login
- AI bots
- Spectators
- Chat
- Throws / 甩牌
- No-trump variants
- Multiple table rule variants
- Production deployment
- Mobile perfection

UI styling:
- Use Tailwind CSS and shadcn/ui.
- Use only simple shadcn components:
  - Button
  - Input
  - Card
  - Badge
  - Dialog
  - Select
  - Separator
  - Tooltip
  - Sonner or Toast
- Keep visuals clean and simple.
- Desktop-first layout.
- Responsive design is required.

Client views:

1. Landing view
- Display name input
- Create room button
- Room code input
- Join room button
- Recent/rejoin room prompt if localStorage has a valid-looking previous room

2. Lobby view
- Room code
- Copy invite link button
- Player's own name
- Host badge
- Four seat cards
- Team display:
  - Team A: seats 0 and 2
  - Team B: seats 1 and 3
- Connected/disconnected indicators
- Ready toggle
- Start button visible to host
- Clear error area
- Basic explanation: "Need 4 seated and ready players to start"

3. Game view
- Current phase
- Current player name and seat
- Team levels
- Dealer indicator
- Trump rank
- Trump suit
- Defender points
- Current turn indicator
- Current trick area
- Other players shown around table with:
  - name
  - seat
  - team
  - card count
  - connected/disconnected
- Player hand
- Selected cards
- Play selected cards button
- Phase-specific action panel:
  - bidding actions
  - kitty discard actions
  - trick play actions
- Toast/error display

4. Bidding action panel
- Show trump rank.
- Show suits the player is allowed to call based on their hand.
- Allow a valid player to call trump.
- If no one calls, allow dealer to choose trump suit manually.

5. Kitty action panel
- Only dealer can act.
- Dealer sees their hand including picked-up kitty.
- Dealer must select exactly 8 cards.
- Discard button is disabled unless exactly 8 cards are selected.

6. Round summary view
- Defender trick points
- Kitty points
- Kitty multiplier
- Final defender score
- Whether dealer team held or defenders took over
- Level changes
- Next dealer
- Next round button for host/dealer

Responsive requirements:
- Desktop: four-player table layout around a central trick area.
- Narrow screens:
  - status section first
  - current trick
  - other players summary
  - hand
  - action buttons
- Hand must remain clickable/tappable.
- Cards may horizontally scroll on narrow screens.
- No important action should be inaccessible on mobile width.

Trump rules:
- Each round has trump rank and trump suit.
- Dealer team's current level determines trump rank.
- Effective trump cards:
  - jokers
  - all cards with rank === trumpRank
  - all cards with suit === trumpSuit
- Trump order, high to low:
  1. Big joker
  2. Small joker
  3. Trump-suit card of trump rank
  4. Other cards of trump rank
  5. Other cards in trump suit
  6. Non-trump cards
- Centralize trump logic in shared rules.

Effective suit:
- Jokers are trump.
- Cards matching trump rank are trump.
- Cards matching trump suit are trump.
- Other cards use printed suit.
- Use effective suit for following suit and play validation.

Bidding:
- After deal, enter bidding phase.
- A player may call a trump suit if they hold at least one card matching the current trump rank in that suit.
- First valid call sets trump suit.
- If all players pass or no one calls, dealer chooses trump suit manually.
- After trump is set, move to kitty phase.

Kitty:
- Dealer receives the 8-card kitty.
- Dealer discards exactly 8 cards.
- Discarded kitty remains hidden until scoring.
- If defenders win the final trick, defenders capture kitty points at 2x.
- Otherwise kitty points do not count for defenders.

Supported play types:
1. Single
2. Pair
3. Tractor

Single:
- One card.

Pair:
- Two cards with the same effective rank and same effective suit.
- Because there are two decks, duplicate physical cards can form a pair.

Tractor:
- Consecutive pairs in the same effective suit.
- Example: 6 spades 6 spades + 7 spades 7 spades when spades are not trump and neither rank is trump rank.
- Trump tractors use trump effective suit and trump ordering.
- Jokers do not form normal suit tractors.
- Tractor detection must be pure and tested.

Trick play:
- Dealer leads first trick.
- Players act in clockwise seat order.
- A trick contains one play from each player.
- Everyone must play the same number of cards as the lead.
- Everyone must follow the effective suit of the lead if possible.
- If lead is a pair and a follower has a pair in the led effective suit, they must play a pair.
- If lead is a tractor and a follower can match the tractor structure in the led effective suit, they must play that structure.
- If a follower cannot match the structure but has cards in the led effective suit, they must play as many cards as required from that effective suit.
- Highest valid play wins the trick.
- Winner leads the next trick.
- Trick winner collects point cards in that trick for their team.

Comparison:
- A play can beat another play only if it matches the led play type and card count, unless it is a legal trump play against a non-trump lead.
- Trump beats non-trump.
- Within the same effective suit and same structure, compare by the highest relevant component.
- Pair beats lower pair.
- Same-length tractor beats lower same-length tractor.
- A random group of high cards cannot beat a structured pair or tractor lead.
- Centralize trick comparison in shared rules.

Scoring:
- Dealer team tries to keep defenders below 80 points.
- Defending team collects points from tricks they win.
- At round end:
  - Count defender trick points.
  - If defenders won final trick, add 2x kitty points.
- Level progression:
  - 0-35 defender points: dealer team levels up by 2
  - 40-75 defender points: dealer team levels up by 1
  - 80-115 defender points: defenders become dealer team, no level gain
  - 120-155 defender points: defenders become dealer team and level up by 1
  - 160-195 defender points: defenders become dealer team and level up by 2
  - 200+ defender points: defenders become dealer team and level up by 3
- Rank progression:
  2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A
- If a team levels past A, show game over and allow room reset.

Socket events:

Client to server:
- createRoom
- joinRoom
- resumeSession
- leaveRoom
- sitAtSeat
- setReady
- startGame
- callTrump
- passTrump
- dealerChooseTrump
- discardKitty
- playCards
- startNextRound
- resetRoom

Server to client:
- publicRoomState
- privatePlayerState
- errorMessage
- toast
- roundSummary

Validation:
- Reject actions from players not in the room.
- Reject actions with invalid reconnect/session tokens.
- Reject actions in the wrong phase.
- Reject actions from the wrong player.
- Reject startGame unless all four seats are filled and ready.
- Reject sitting in an occupied seat.
- Reject trump calls the player cannot legally make.
- Reject kitty discard unless exactly 8 cards are selected.
- Reject cards not in the acting player's hand.
- Reject out-of-turn plays.
- Reject plays with wrong card count.
- Reject invalid singles, pairs, and tractors.
- Reject illegal follow-suit plays.
- Reject illegal attempts to beat a structured play with an unstructured play.

Testing requirements:

1. Shared unit tests with Vitest
Add unit tests for:
- 108-card deck creation with unique physical IDs
- point counting
- trump detection
- effective suit
- trump ordering
- non-trump ordering
- pair detection
- tractor detection
- lead play classification
- follow-suit validation for singles
- follow-suit validation for pairs
- follow-suit validation for tractors
- trick winner calculation for singles
- trick winner calculation for pairs
- trick winner calculation for tractors
- kitty discard count
- defender score calculation
- kitty capture with 2x multiplier
- level progression bands
- rank advancement
- game-over detection after passing A

2. Server integration tests with Vitest and socket.io-client
Spin up the real Express + Socket.IO server against a temporary SQLite database.

Add integration tests for:
- host creates a room and receives room code/session token
- three users join by room code
- users sit in seats 0, 1, 2, 3
- duplicate seat selection is rejected
- all players ready
- host starts game
- each player receives only their own hand
- public state does not expose other players' hands
- valid trump call succeeds
- invalid trump call is rejected
- dealer receives kitty in kitty phase
- dealer discard with fewer or more than 8 cards is rejected
- dealer discard with exactly 8 cards succeeds
- out-of-turn play is rejected
- playing a card not in hand is rejected
- legal single trick resolves
- legal pair trick resolves
- legal tractor trick resolves
- defender points update after a trick
- round summary is emitted after the round ends
- next round can start
- refresh/reconnect restores the same player, seat, and hand
- server restart reloads persisted room from SQLite

For deterministic tests:
- Add a test-only fixture loader that is available only when NODE_ENV === "test".
- The fixture loader may create known hands, kitty, trump rank, trump suit, phase, and current turn.
- Do not expose fixture loading in normal development or production mode.
- Use fixtures to test pair and tractor trick resolution through the real socket layer.

3. Browser integration tests with Playwright
Use multiple browser contexts to simulate separate users.

Add browser tests for:
- one browser creates a room
- invite link is copied or read from the UI
- three separate browser contexts join the room
- all four users choose seats and ready up
- host starts the game
- each browser sees a hand
- each browser sees only its own hand
- trump selection UI appears
- dealer kitty discard UI appears after trump selection
- game table renders current trick, team levels, trump, defender points, and turn indicator
- responsive smoke test at mobile width verifies main actions remain visible and usable

Developer experience:
- TypeScript strict mode.
- Clear README.
- Useful server logs for room creation, join, reconnect, state transition, and rejected action.
- Use data-testid attributes on critical UI elements to make Playwright tests stable.
- Keep rule functions pure where possible.
- Keep socket handlers small.
- Keep persistence isolated in a server storage module.

Implementation order:
1. Create pnpm monorepo.
2. Create shared types.
3. Implement card/deck utilities.
4. Implement rule engine and unit tests.
5. Implement SQLite storage.
6. Implement room manager.
7. Implement Socket.IO server and server integration tests.
8. Implement client connection/session handling.
9. Implement landing, host, join, reconnect, lobby, seating, and ready flow.
10. Implement deal/start game.
11. Implement bidding.
12. Implement kitty discard.
13. Implement trick play for singles, pairs, and tractors.
14. Implement scoring and next round.
15. Implement Playwright browser integration tests.
16. Polish responsive UI.
17. Finalize README.

Acceptance criteria:
- I can run pnpm install and pnpm dev.
- I can create a room from one browser.
- I can join from three other browsers using the room code or invite link.
- Four users can sit, ready, and start.
- Refreshing a player's browser reclaims the same player and seat.
- Server restart can reload persisted room state from SQLite.
- Each player only sees their own hand.
- Trump selection works.
- Dealer kitty discard works.
- Singles, pairs, and tractors are playable.
- Illegal moves are rejected by the server.
- Tricks resolve correctly.
- Defender points are counted.
- Round summary works.
- Next round can start.
- Unit tests pass.
- Server integration tests pass.
- Browser integration tests pass.
- README explains how to run and play locally.
