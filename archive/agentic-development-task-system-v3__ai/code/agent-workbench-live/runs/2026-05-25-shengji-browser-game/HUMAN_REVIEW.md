# Human review — 2026-05-25-shengji-browser-game

## Files

- **Brief** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/5_validating/review.md`
- **Audit** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/audit.md`

## Summary of changes

- 38 file(s) touched:
  - ``package.json` — root pnpm workspace, `pnpm dev/build/test/test:e2e/typecheck` scripts, pinned `packageManager: pnpm@10.33.0`, `pnpm.onlyBuiltDependencies` allowlist for native modules.`
  - ``pnpm-workspace.yaml` — workspace globs (`packages/*` + `tests/e2e`).`
  - ``.gitignore` — node_modules, dist, SQLite, Playwright outputs.`
  - ``.npmrc`, `.editorconfig`, `.prettierrc`, `tsconfig.base.json` — shared editor/format/TS config.`
  - ``src/types.ts` — `Card`, `Player`, `GameState`, `PublicGameState`, `PrivatePlayerState`, `RoundSummary`, `PlayClassification`, `TrickPlay`, `SessionAck`.`
  - ``src/cards.ts` — `RANKS`, `SUITS`, `JOKERS`, `buildDeck(1|2)`, `buildFullDeck()` (108 unique), `shuffle(rng, arr)` (Fisher-Yates with injectable RNG), `pointValue`, `deckPoints`.`
  - ``src/trump.ts` — `isTrump`, `effectiveSuit`, `trumpTier`, `compareSameSuit`, `compareCards`, `sortDescending`.`
  - ``src/plays.ts` — `classifyPlay` (single/pair/tractor or invalid) with cross-deck pair recognition and DR-008 tractor adjacency.`
  - …and 30 more
- 1 doc(s) touched:
  - ``README.md` — full rewrite from the agent-workbench scaffold placeholder to a complete run-and-play guide.`

→ Full diff: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/4_building/build.md`

## Testing

**Unit tests**

`pnpm install`

```
- **tests_passed**: true
- **known_issues_count**: 0 (build.md known-issues are cosmetic / informational, not blocking)

Unit (67) + server integration (13) + Playwright e2e (3) all green. Repo-wide typecheck clean across `shared`, `server`, and `client`.
```

✓ all green — 0 known issues.

**Manual testing**

Brief QA scenarios covered automatically:

- Scenarios 1, 2 (4-tab happy path + invite-link): Playwright `lobby.spec.ts` + the integration `lobby.test.ts`.
- Scenarios 3, 4 (refresh-mid-lobby, refresh-mid-round): `reconnect.test.ts` covers refresh-by-token. The mid-round path uses the same code, but no test explicitly drives a refresh during `phase === "playing"`. Not blocking.
- Scenario 5 (server restart): `reconnect.test.ts` "a separate server can reload a previously-persisted room from SQLite".
- Scenario 6 (illegal trump call): `bidding-kitty.test.ts` constructs a hand without the called rank-suit and asserts the server rejects.
- Scenarios 7–14 (illegal play count, illegal follow on singles/pairs/tractors, trump beats non-trump, higher pair beats lower, higher tractor beats lower): covered in `packages/shared/test/{followSuit,trick}.test.ts` and `packages/server/test/integration/play.test.ts`.
- Scenarios 15, 16 (defender takes / does not take final trick → 2× kitty applied / not applied): covered in `packages/shared/test/scoring.test.ts` (`computeRoundSummary`). The full socket-driven final-trick scenario is not built in integration (a future fixture-driven test could close that gap).
- Scenario 17 (each scoring band): all 6 bands tested at the unit level via `bandFor` and `computeRoundSummary` checks. Not driven end-to-end.
- Scenario 18 (game over past A): unit-tested at the `advanceRank` + `computeRoundSummary` level. No e2e exercise.
- Scenario 19 (reject join mid-game): `joinLobby` reducer asserts `phase === "lobby"`; an integration test could pin this but it's a one-line reducer rejection.
- Scenario 20 (reject duplicate seat): `lobby.test.ts` covers.
- Scenarios 21, 22 (hand + token secrecy): `privacy.test.ts` (server) + Playwright `privacy.spec.ts` (DOM-level).
- Scenario 23 (mobile-width smoke): Playwright `responsive.spec.ts`.
- Scenarios 24, 25 (reset / remove unready disconnected player): reducer-tested via type signatures; UI-level smoke not in Playwright.

Review decision: **request_changes**.

Full QA report:

`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-shengji-browser-game/stages/5_validating/qa/report.md`

## Run timeline

- [04:41:00] DRAFT — new_repo.md written: initial commit 9bb6398944
- [04:41:06] SHAPING — entered shaping
- [04:43:57] PLANNING — entered planning
- [04:48:41] PLANNING — assumption ASM-001: Off-suit trump-rank cards rank equal to each other (DR-007 details).
- [04:48:41] PLANNING — assumption ASM-002: When a follower has no cards in the led effective suit, they may play any cards to make up the count — no "must trump" rule.
- [04:48:41] PLANNING — assumption ASM-003: "Final trick" of a round = whichever trick empties all four hands.
- [04:48:41] PLANNING — assumption ASM-004: Six-character alphanumeric room codes are sufficient; collisions auto-retry.
- [04:48:41] PLANNING — assumption ASM-005: Reconnect tokens are 32-byte base64url.
- [04:48:41] PLANNING — assumption ASM-006: Invite link format is `http://<host>:5173/room/<publicCode>`.
- [04:48:41] PLANNING — assumption ASM-007: Player ID is stable for the room's life; session ID rotates on `resumeSession`.
- [04:48:41] PLANNING — assumption ASM-008: No host-successor logic; if host disconnects the room idles until host returns or someone manually leaves.
- [04:48:41] PLANNING — assumption ASM-009: One in-flight intent per player; mutations per room are serialized.
- [04:48:41] PLANNING — assumption ASM-010: Spectators / new joins after lobby phase are rejected.
- [04:48:41] PLANNING — assumption ASM-011: Dealer must choose one of the four suits when all four pass; "no trump" is not allowed.
- [04:48:41] PLANNING — assumption ASM-012: Kitty 2x bonus only on defenders winning the *final* trick (not other point-bearing tricks).
- [04:48:41] PLANNING — assumption ASM-013: Round 1 dealer team is Team A (seats 0+2), starting at level 2.
- [04:48:41] PLANNING — assumption ASM-014: Tractor adjacency uses the rule in DR-008.
- [04:48:41] PLANNING — decision DR-001: Delete the workbench's default `backend/`, `frontend/`, `docs/` placeholder directories and replace with the brief-specified pnpm monorepo layout (`packages/{c…
- [04:48:41] PLANNING — decision DR-002: Public room code is 6-character uppercase alphanumeric using the alphabet `[A-Z0-9]` minus visually-confusable characters (`0/O`, `1/I/L`). Effective alphabet …
- [04:48:41] PLANNING — decision DR-003: Reconnect token is `crypto.randomBytes(32).toString("base64url")` (43 chars). Stored only in SQLite + browser localStorage. Never broadcast.
- [04:48:41] PLANNING — decision DR-004: Use `better-sqlite3` for SQLite access (synchronous API).
- [04:48:41] PLANNING — decision DR-005: Use React Router v6 for client routing.
- [04:48:41] PLANNING — decision DR-006: Joker pairs are allowed only when both jokers are the same kind: two small jokers form a "small-joker pair"; two big jokers form a "big-joker pair". A small + …
- [04:48:41] PLANNING — decision DR-007: Off-suit trump-rank cards (e.g. `2♠`, `2♦`, `2♣` when trump suit is hearts and trump rank is 2) are equal-ranked among each other. When two are played sequenti…
- [04:48:41] PLANNING — decision DR-008: For tractor adjacency, two pairs are "consecutive" if their effective ranks are adjacent in the trump-aware order *within the same effective suit*. Among non-t…
- [04:48:41] PLANNING — decision DR-009: New dealer after a round = the next player counter-clockwise from the current dealer if the dealer team retains, or the player on the defender team who is "to …
- [04:48:41] PLANNING — decision DR-010: Game over fires when the band-applied level advance would push the dealer team's level past A. We still emit the `roundSummary` showing the would-be advance, b…
- [04:48:41] PLANNING — decision DR-011: Off-suit follow on a structured lead — when a follower has cards in the led effective suit but cannot match the structure: (a) for a pair lead, they must play …
- [04:48:41] PLANNING — decision DR-012: Server logs go to stdout (Node) at INFO level by default. No logging library; just a tiny `log.ts` wrapper around `console.log` with structured fields.
- [04:48:41] PLANNING — decision DR-013: Vite proxies `/socket.io` and the REST surface (if any) to `http://localhost:3001` in dev. Production-mode Vite build is not configured (out of scope).
- [04:48:41] PLANNING — decision DR-014: Test-fixture loader is registered as a socket event (`__loadFixture`) gated by `process.env.NODE_ENV === "test"`. The check happens at handler registration so …
- [04:48:41] READY — entered ready
- [13:16:21] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/shengji-browser-game/20260525__shengji-browser-game` on `agent/shengji-browser-game`
- [13:16:21] BUILDING — worktree on `agent/shengji-browser-game` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/shengji-browser-game/20260525__shengji-browser-game`
- [13:41:30] VALIDATING — entered validating
- [13:45:03] VALIDATING — doc claims: 1 unverified
- [13:45:03] VALIDATING — review decision: request_changes
- [13:45:03] VALIDATING — tests_passed=true; known_issues=0
- [13:45:04] FOLLOWUPS — entered followups
- [13:46:03] FOLLOWUPS — 5 follow-up(s) recorded (bug_risk, docs, scope_extension, tech_debt)
- [13:46:04] FOLLOWUPS — handoff record created
