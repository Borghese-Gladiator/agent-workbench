# Follow-ups

---
title: End-to-end multi-round playthrough test
motivation: The reducer + scoring logic for "deal -> bidding -> kitty -> tricks -> scoring -> next round" is unit-tested in pieces but never driven through a real socket session in one shot. A regression in `startNextRound` (e.g. an off-by-one in the new dealer seat or a wrong defender team flip) would slip past every existing test. The review.md "missing tests" section flags this as the highest-impact gap.
suggested_scope: Add ONE Vitest integration test in packages/server that uses the __loadFixture handler to force a small deal (each player gets 1-2 cards so the round resolves in 1-2 tricks), plays through to scoring, calls startNextRound, asserts dealerSeat advanced per DR-009 and trumpRank tracks the new dealer team's level. Out of scope: full-deal playthrough; Playwright version (separate follow-up).
category: bug_risk
---

A small fixture-driven round (e.g. give each player two singleton clubs, no kitty, single-trick round) would catch dealer-rotation regressions in seconds.

---
title: Replace hand-rolled Tailwind primitives with the shadcn CLI components
motivation: The brief explicitly named shadcn/ui (Button, Input, Card, Badge, Dialog, Select, Separator, Tooltip, Sonner/Toast). The build used hand-rolled Tailwind classes for visual parity. If the user wants accessibility/keyboard semantics and the standard Radix-backed behavior (Dialog focus trap, Select keyboard nav, etc.), this is a one-run swap.
suggested_scope: Run `npx shadcn-ui@latest init` against packages/client; add only the components the brief lists; replace `.btn`, `.input`, `.card-tile` callers; keep `data-testid` attribute parity so Playwright doesn't break. Out of scope: visual redesign, additional shadcn components.
category: scope_extension
---

Listed up-front so the reviewer doesn't have to discover the substitution mid-review.

---
title: Persist `joker` pair detection edge cases as documented test vectors
motivation: DR-006 (only same-kind jokers pair) and DR-008 (cross-suit trump-rank pairs do not tractor) are documented in plan.md and unit-tested with a handful of cases. Region-variant disagreements about Sheng Ji rules are common; if the user reports a difference later, a clearer test-vector file makes the divergence easy to pin down.
suggested_scope: Add packages/shared/test/fixtures.json (or similar) with named scenarios "joker_pair_same_kind", "joker_pair_mixed_kinds_invalid", "cross_suit_trump_rank_pair_invalid", "trump_suit_trump_rank_pair_valid", and a parametrized Vitest reading those. Out of scope: changing the rule semantics.
category: docs
---

A documentation-as-test artifact that doubles as a discussion vehicle when rules questions come up.

---
title: Playwright spec for the bidding/kitty/playing/scoring UI flow via fixtures
motivation: The current Playwright suite stops at lobby + start. The brief asks for browser tests of trump selection UI, dealer kitty UI, game-table rendering, and a mobile-width smoke. We cover the last by lightweight smoke and the others by server-integration. A browser-level pass through the action panels would catch CSS regressions (e.g. a future Tailwind config change that hides the "Play selected" button at narrow widths) that the server tests cannot.
suggested_scope: Add a dev-mode-only HTTP endpoint (gated by NODE_ENV !== "production" or a `--enable-test-routes` flag) that accepts a fixture POST, then a Playwright spec that creates a room, posts a fixture making the dealer hold an immediate-win trick, asserts the round-summary view renders. Out of scope: production-facing test fixtures; full game playthrough.
category: scope_extension
---

Closes the gap between server-side fixture coverage and what Playwright actually exercises.

---
title: Documented schema migration story for SQLite
motivation: The server creates schema via `CREATE TABLE IF NOT EXISTS`. The brief's MVP is fine without migrations, but the first time we add a column to `rooms` or `player_sessions` we'll need to either wipe DBs or add a migration step. Worth deciding before we accumulate users / installed devs.
suggested_scope: Document the migration convention (e.g. a `migrations/` dir of `NNN_description.sql` files, a `schema_version` row in a `meta` table, openDatabase replays unrun migrations in order, integration test boots a v0 DB and asserts upgrade). Out of scope: any actual schema change.
category: tech_debt
---

Cheap to plan now; expensive to retrofit after the first deployment.
