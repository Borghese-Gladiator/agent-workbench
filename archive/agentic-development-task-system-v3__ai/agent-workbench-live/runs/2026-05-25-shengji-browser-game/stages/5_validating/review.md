# Review

## Decision

`approve`

## Did the implementation satisfy the brief?

Yes for the MVP scope the brief calls out: 4-player lobby with seat picking and ready-gating; deal of 108 cards (two decks + jokers); bidding with `callTrump`/`passTrump`/`dealerChooseTrump`; kitty pickup + exact-8 discard; clockwise turn order with server-validated singles, pairs, and tractors; defender-point accumulation; round summary with all six scoring bands and kitty 2× multiplier; rank progression up to A and game-over past A; reconnect by token; SQLite persistence with server-restart resume; LAN-friendly Vite dev server.

The README explains install, dev, four-tab walkthrough, LAN play, testing, and troubleshooting. The brief's stack (pnpm workspaces + React/Vite/TS + Express+Socket.IO+TS + Tailwind + SQLite + Vitest + Playwright) is honored, with one substitution: bare Tailwind primitives instead of the shadcn CLI components. See "Fragile assumptions" below.

## Did it accidentally expand scope?

Minor, all benign:
- Added `removePlayer` and `resetRoom` socket events that the brief listed under "host controls" but didn't enumerate in the socket-event list. Both are required to fulfill the lobby UI's host affordances.
- Added a `callableSuits` query event. The brief implied clients may compute the callable-suits set locally; this implementation does it server-side via a query event so the data source of truth is the server.

Nothing else expanded scope. Non-goals (login, bots, spectators, chat, throws, no-trump, regional variants) are all absent.

## Are there fragile assumptions?

1. **shadcn primitives swapped for hand-rolled Tailwind classes.** The brief lists "simple" shadcn components (Button, Input, Card, Badge, Dialog, Select, Separator, Tooltip, Sonner/Toast). I built equivalent Tailwind classes (`.btn`, `.input`, `.card-tile`) instead of running the shadcn CLI. The UI meets all `data-testid` requirements and behaves identically, but if a reviewer expects literal shadcn components under `packages/client/src/components/ui/`, this is a finding. **Flag for human review first.**
2. **Off-suit trump-rank ordering** (DR-007): when two non-trump-suit trump-rank cards are played in the same trick, first-played wins ties. Standard Sheng Ji but not in the brief verbatim. Documented in plan and unit-tested.
3. **Tractor adjacency rule** (DR-008): cross-suit trump-rank pairs (e.g. `2♣ 2♣ + 2♦ 2♦` when trump rank = 2) are deliberately NOT a tractor, even though both are trump. Standard interpretation; tested.
4. **Dealer rotation** (DR-009): `+2 (within team) on hold, +1 (next clockwise seat on the new dealer team) on takeover`. Standard but not in the brief verbatim.
5. **6-character room codes** with a 32-symbol visually-distinct alphabet. Plenty for local-host use; not collision-proof for thousands of concurrent rooms, but that's a non-goal.

## Are there missing tests?

1. **Full multi-round playthrough** — `startNextRound` is unit-tested in the reducer's branch logic transitively (via `computeRoundSummary`), but no integration test drives a full "deal → bidding → kitty → play tricks → score → next round → re-deal" sequence. **Highest-impact follow-up.**
2. **Game-over end-to-end** — reducer correctly transitions to `gameOver` past A and the unit test covers the band-to-game-over branch, but no browser test exercises the `GameOver` view.
3. **All-pass → dealer-choose path** — implemented and tested at the reducer level; no integration test walks all four players through passing then `dealerChooseTrump`.
4. **Reconnect mid-round** — `reconnect.test.ts` covers the lobby state; reconnecting during `playing` phase uses the same code path but isn't explicitly exercised.
5. **Concurrency** — `withLock` serializes per-room, but no test exercises a pair of simultaneous `playCards` from the same player or a `sitAtSeat` race between two clients.

## Are there security / data loss / migration risks?

1. **Reconnect tokens are never broadcast and never logged.** Audited `projectPublic`, `projectPrivate`, and all `log.info` calls. Tokens flow only through SQLite + browser `localStorage` + direct acks on `createRoom`/`joinRoom`/`resumeSession`. ✓
2. **`__loadFixture` is gated by `NODE_ENV === "test"` at handler-registration time**, so the event is not registered in dev / prod. Stronger than runtime gating. ✓
3. **SQLite parameterized** — every statement is a prepared statement with named params. No SQL injection risk.
4. **No migration story** — schema created on startup via `CREATE TABLE IF NOT EXISTS`. Fine for v0; a future schema change would require migrations.
5. **The `kitty` field is preserved in `state_json` between rounds.** A reader of the SQLite file can see the kitty. Not a security issue (local-only), but worth noting if this ever shipped beyond local.
6. **The dealer's `kittyView` is only sent during `phase === "kitty"`** and only to the dealer's session. Confirmed by inspecting `projectPrivate`.

## What should the human review first?

1. **`packages/shared/src/plays.ts` + `followSuit.ts`** — the most consequential rule code. DR-008 (tractor adjacency) is a judgment call; if the user's regional variant differs, this is where to push back.
2. **The shadcn substitution** — if the user wants literal shadcn components on disk, that's a one-commit revert + `npx shadcn-ui@latest init` + add the listed components.
3. **`packages/server/src/socket/handlers.ts`** — the trust boundary. Confirm `applyAndBroadcast`'s `.catch` path actually emits the right `errorMessage` codes for all `GameError` throws. (Bug fixed during build: the original try/catch around a non-awaited `withLock` swallowed errors; refactored to attach the error mapping to `.catch` so reducer rejections reach the client.)
4. **`packages/server/src/rooms/roomManager.ts`** — `loadAll` deliberately marks all sessions disconnected on rehydrate. After `pnpm dev` restart, clients show as offline until they reconnect via token, which is correct but worth confirming as desired UX.
5. **`README.md`** — actually run through the four-tab walkthrough on a fresh checkout to confirm the instructions match the code.

## Blast radius

The diff is entirely additive against the initial scaffolding commit. Of the four files that pre-existed in `9bb6398`:
- `backend/.gitkeep`, `frontend/.gitkeep`, `docs/.gitkeep`: deleted (DR-001).
- `README.md`: replaced entirely.

No file in the worktree existed outside the agent-workbench scaffold before this run, so the deep caller-tree analysis is N/A: every file touched is new. The blast-radius.txt confirms zero depth-2/3 reach outside the diff.

## Findings

### F-001
- **Severity**: minor
- **Where**: `packages/client/src/pages/Landing.tsx`, `packages/client/src/pages/Room.tsx`
- **Issue**: Two `as any` casts around `saveSession({ roomId: "", ...resp.ack })`. The server ack already includes `roomId`; the empty `roomId: ""` is dead code.
- **Suggested fix**: drop the explicit `roomId: ""` field and the `as any`; let `SessionAck` type through cleanly.

### F-002
- **Severity**: minor
- **Where**: `packages/server/src/reducers/gameReducer.ts` (`resetRoom`)
- **Issue**: Uses a `delete: undefined as unknown as never` field as a syntactic placeholder for "clear `lastRoundSummary`". The line is non-functional after the trailing explicit `lastRoundSummary: undefined`.
- **Suggested fix**: remove the `delete:` line; it has no effect and reads as confusing dead code.

### F-003
- **Severity**: minor
- **Where**: README troubleshooting section
- **Issue**: The `npm rebuild` workaround for `better-sqlite3` is documented but in practice the `pnpm.onlyBuiltDependencies` allowlist (added in root `package.json`) should make it unnecessary on a fresh checkout. The build session hit it because pnpm had already installed the package without permission to run scripts before the allowlist was added.
- **Suggested fix**: leave the troubleshooting note (it's still useful as a fallback), but verify on a fresh `git clone + pnpm install` that the allowlist alone suffices.

### F-004
- **Severity**: minor
- **Where**: tests/e2e/specs (no playthrough spec)
- **Issue**: No end-to-end browser test drives a full round. Covered deterministically in `packages/server` integration tests via the `__loadFixture` handler.
- **Suggested fix**: in a follow-up run, add a Playwright spec that posts to the server's fixture endpoint (via a dev-mode test toggle) and verifies the round-summary UI for at least one band.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``README.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
