# TASK-79 — Per-phase prompt/context token audit

## Instrumentation (this slice)

- `getTokenSpendByPhase(db, taskId)`
  (`packages/database/src/data-access/observability.ts`) joins
  `model_invocations` → `agent_sessions` for the cache split (fresh /
  cache-read / cache-write / output / cost) and `context_composition` for the
  static-vs-injected split, ranked per phase by input spend.
- `scripts/token-spend-by-phase.mjs` prints the same report from the live
  SQLite (all tasks or `--task <id>`), read-only.

Definitions: **static** context = the fixed instruction/prompt scaffolding
(`instruction_tokens`). **injected** context = task-specific material
(contract, plan, diff, evidence, findings, repository-map, memory).

## Observed spend (worktree DB snapshot, all tasks)

Ranked by input spend; injected/static are per-session context tokens:

| phase | fresh | cache_read | cache_write | output | cost | static_ctx | injected_ctx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| implement | 4383 | 20,157,990 | 447,685 | 121,810 | $17.62 | 0 | 3,873 |
| plan | 4095 | 9,704,694 | 1,424,677 | 192,169 | $21.83 | 14,202 | 67,510 |
| program-design | 2369 | 4,211,579 | 727,291 | 113,855 | $10.87 | 3,721 | 15,821 |

### Reading

- The dominant cost is **cache-read**, not fresh input — the prompts are
  re-sent every turn and mostly served from cache. Trimming fresh prompt text
  helps the cache-**write** line and every phase's first turn, but the biggest
  lever is fewer turns / smaller injected context, not prose.
- **plan** carries by far the largest injected context (67k) and the most
  static scaffolding (14k) — the top offender for a prompt trim.
- **program-design** is second on both static and injected — the other trim
  target.

## Applied reductions (this slice)

- `plannerInstruction` (`workers/temporal-worker/src/activities/plan-support.ts`)
  — condensed the memory line, the QA-scenario line, and the verbose
  "IMPORTANT: use as FEW slices…" block while preserving every constraint the
  plan gate checks (JSON shape, non-empty targeted checks, single-slice bias,
  no investigate/verify slices, qaScenarioIds rule). Verified by the existing
  `plan-support.test.ts` assertions.
- `programDesignInstruction`
  (`workers/temporal-worker/src/activities/program-design-support.ts`) —
  tightened the structure/JSON-shape prose and the bodyless-signature rule to a
  single sentence, keeping the `NO implementation` / `fileTreeDiff` contract the
  parser and gate depend on.

## Before/after

Re-run `node scripts/token-spend-by-phase.mjs` after a fresh batch and compare
the `static_ctx` column for `plan` and `program-design` against the table above
to quantify the trim; injected context is unchanged by these edits (it is
task-derived, not prompt prose).
