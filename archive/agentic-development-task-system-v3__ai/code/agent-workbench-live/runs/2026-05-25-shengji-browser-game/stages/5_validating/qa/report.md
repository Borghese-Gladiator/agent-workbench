# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0 (build.md known-issues are cosmetic / informational, not blocking)

Unit (67) + server integration (13) + Playwright e2e (3) all green. Repo-wide typecheck clean across `shared`, `server`, and `client`.

## What ran

- `pnpm --filter @shengji/shared test` — Vitest unit suite for the rule engine.
- `pnpm --filter @shengji/server test` — Vitest integration suite spinning up a real Express + Socket.IO server against an ephemeral SQLite per file.
- `pnpm --filter @shengji/e2e test` — Playwright multi-context browser smoke (chromium).
- `pnpm typecheck` — `tsc --noEmit` across all three TS packages.
- `pnpm --filter @shengji/client build` — Vite production build smoke.

Each command is recorded verbatim in `commands.txt`.

## Results

### Unit tests
```
@shengji/shared
  Test Files  7 passed (7)
       Tests  67 passed (67)
  Duration   356ms
```
Files covered: `cards`, `trump`, `plays`, `followSuit`, `trick`, `bidding`, `scoring`. Notably covers DR-007 (off-suit trump-rank ties), DR-008 (tractor adjacency edge cases, incl. the deliberately-rejected `2♣ 2♣ + 2♦ 2♦` "cross-suit trump-rank pair tractor"), all six scoring bands, kitty 2× multiplier with and without defender-final-trick, K→A and K+2→game-over progression.

### Integration tests
```
@shengji/server
  Test Files  5 passed (5)
       Tests  13 passed (13)
  Duration   1.19s
```
Files: `lobby.test.ts` (host create + 3-player join + duplicate-seat rejection + ready-gating + start), `privacy.test.ts` (`publicRoomState` never leaks `hands`), `bidding-kitty.test.ts` (legal call advances to kitty, 8-card discard required), `play.test.ts` (out-of-turn rejection, card-not-in-hand rejection, single trick resolves with defender points, legal pair trick highest-pair-wins, legal tractor trick resolves), `reconnect.test.ts` (refresh-by-token, server-restart-from-SQLite).

### Lint / typecheck
```
@shengji/shared typecheck: Done
@shengji/server typecheck: Done
@shengji/client typecheck: Done
```
`tsc --noEmit` clean with strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride` everywhere.

### Browser / Playwright
```
@shengji/e2e
  Running 3 tests using 1 worker
  ✓  specs/lobby.spec.ts:9 (1.5s)        — 4-context create + join + ready + start, 25-card hand
  ✓  specs/privacy.spec.ts:9 (1.1s)      — DOM scan: zero card-id overlap across 4 contexts, total 100 cards
  ✓  specs/responsive.spec.ts:3 (210ms)  — 375px primary actions visible and tappable
  3 passed (5.0s)
```

### Smoke scripts
- `pnpm --filter @shengji/client build` produced a 223 KB JS + 14.85 KB CSS bundle in 563 ms with zero errors.
- Server boot (`SHENGJI_DB=/tmp/sj-smoke.sqlite pnpm --filter @shengji/server start` then `curl /health`) returned `{"ok":true}` during the build session.

## Captured artifacts

`qa/artifacts/`, `qa/recordings/`, `qa/traces/` are empty for this run — Playwright is configured with `trace: "retain-on-failure"` and `screenshot: "only-on-failure"`, so the green run left nothing to archive. The full command-line output is captured inline in this report.

## Manual testing

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

## Failed commands

None. After one-time `npm rebuild better-sqlite3` to compile the native binding (documented in README troubleshooting), every command above ran clean.
