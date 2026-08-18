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

## Observed spend (live DB snapshot, all tasks)

From `node scripts/token-spend-by-phase.mjs
~/.agentic-workbench/database/workbench.sqlite`, ranked by input spend;
injected/static are per-session context tokens:

| phase | fresh | cache_read | cache_write | output | cost | static_ctx | injected_ctx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| implement | 445,267 | 99,100,875 | 1,908,734 | 543,717 | $82.98 | 0 | 14,148 |
| plan | 293,003 | 8,791,325 | 1,458,485 | 197,982 | $24.77 | 33,150 | 142,697 |
| challenge | 177,631 | 3,047,580 | 0 | 29,159 | $3.31 | 438 | 3,226 |
| program-design | 1,825 | 1,222,043 | 243,245 | 80,093 | $5.05 | 3,893 | 17,124 |
| **TOTAL** | **917,726** | **112,161,823** | **3,610,464** | **850,951** | **$116.11** | **37,481** | **177,195** |

### Reading

- The dominant cost is **cache-read**, not fresh input — cache_read (112M
  tokens) dwarfs fresh input (918k) by ~120×. Prompts are re-sent every turn
  and mostly served from cache, so trimming fresh prompt text helps the
  cache-**write** line and every phase's first turn, but the biggest lever is
  fewer turns / smaller injected context, not prose length.
- **implement** is the single largest spender ($82.98, 71% of all cost) — driven
  by turn count and cache-read volume, not prompt scaffolding (its static_ctx is
  0). The lever here is fewer/shorter builder turns, not the prompt.
- **plan** is the top offender for a *prompt* trim: by far the largest injected
  context (143k) and the most static scaffolding (33k).
- **program-design** is next on the static/injected split (3.9k / 17k) — the
  other trim target, and the one whose whole-phase value TASK-61 questions.

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

## Before/after (measured)

Measured on the emitted instruction string (the base path: no memory line, no
behavioral-QA claim), before = the branch point `6734a20`, after = this slice.
Token estimate is chars/4, the same estimator `context_composition` uses.

| prompt | before | after | delta |
| --- | --- | --- | --- |
| `plannerInstruction` | 801 chars / ~201 tok | 540 chars / ~135 tok | **−261 chars / ~−66 tok (−33%)** |
| `programDesignInstruction` | 663 chars / ~139 tok* | 556 chars / ~139 tok | **−107 chars / ~−27 tok (−16%)** |

\* program-design before was ~166 tok; the trim removed the redundant "Decide
the structure…/JSON object" framing and folded the two-sentence bodyless-signature
rule into one.

This is the *static scaffolding* trim only. Because prompts are re-sent every
turn (the cache-read observation above), the saving compounds per turn on the
first (cache-write) turn of every `plan` / `program-design` session, and the
first-turn fresh cost of each. Injected context is unchanged by these edits (it
is task-derived — contract/plan/diff/evidence — not prompt prose), so the
`injected_ctx` column is expected to hold flat.

To re-confirm against live spend after a fresh batch, re-run
`node scripts/token-spend-by-phase.mjs
~/.agentic-workbench/database/workbench.sqlite` and compare the `static_ctx`
column for `plan` and `program-design` against the table above.
