# TASK-61 — Program-design A/B evaluation

## Question

Does the separate `program-design` phase on L runs earn its cost? Compare
runs **with** program-design against runs **without** it on: rework / loop-back
rate, reviewed-vs-total slice ratio, and comment/maintainability density.

## Instrumentation (this slice)

- Config flag `planning.disableProgramDesign` (`packages/config/src/config.ts`,
  defaulted false; written into `defaultConfigYaml`). Read at workflow-start in
  the daemon (`routes/tasks.ts`, `scheduler-runtime.ts`) and threaded into
  `TaskWorkflowInput.disableProgramDesign` — the deterministic workflow never
  reads config live.
- `phaseSetForSize(size, { disableProgramDesign })` drops `program-design` from
  the derived phase set even at L, preserving canonical order.
- Every control-plane semantic event now carries
  `payloadJson.programDesignEnabled` (derived from the run's `phaseSet`), so
  program-design vs no-program-design runs are distinguishable in
  `semantic_events` without a schema change.

## How to run the A/B

1. Baseline arm (program-design ON): default config, run a batch of L tasks.
2. Treatment arm (OFF): set `planning.disableProgramDesign: true` in
   `~/.agentic-workbench/config.yaml`, run the matched batch.
3. Partition runs by `programDesignEnabled` on their events.

## Data source

The `planning.disableProgramDesign` flag is new in this slice, so no
flag-toggled batch exists yet. This is an **observational** A/B over the runs
already in the live workbench SQLite: the arm is derived by whether a run
actually executed a `program-design` phase (`semantic_events.phase =
'program-design'`), which is the same partition the `programDesignEnabled`
attribute will produce for future flag-driven runs. Pulled with the queries in
`docs/verify-task-36-37.md` style directly against
`~/.agentic-workbench/database/workbench.sqlite` (34 runs total: 9 with
program-design, 25 without; cost/token averages over the 28 runs that recorded
`model_invocations`).

Treat this as a footprint read, not a controlled experiment — the two cohorts
are not size-matched (the with-pd runs are an older L-heavy cohort), and the
challenge-density row is confounded (see caveat). The mechanism-level
instrumentation is what makes the clean flag-toggled A/B reproducible going
forward.

## Metrics (observed, live DB)

| metric | with program-design (9) | without (19–25) | delta |
| --- | --- | --- | --- |
| avg cost / run | $8.31 | $2.58 | **+3.2×** |
| avg tokens / run | 60,003 | 64,666 | −7% |
| phase-failed / run (loop-back) | 0.33 | 0.32 | ~0 |
| attempt-retry / run (rework) | 0.33 | 0.24 | +38% (worse) |
| challenge events (total) | 0 | 238 | see caveat |

The program-design phase itself accounts for **$5.05** and **~17k injected
context tokens/run** across the 9 runs (per
`node scripts/token-spend-by-phase.mjs`), i.e. the bulk of the with-pd cost
premium.

**Caveat on the challenge row:** the 9 with-pd runs are an earlier cohort that
never reached the `challenge` phase, so `0` reflects cohort timing, not a
program-design effect. The reviewed-vs-total-slice and comment/maintainability
density rows can only be computed cleanly from a matched flag-toggled batch;
this run did not have one, so they are omitted rather than reported misleadingly.

## Recommendation

**Drop (or collapse into plan).** On the data available, program-design does
**not** buy less rework: loop-back rate is flat (0.33 vs 0.32) and retries are
actually *higher* on the with-pd arm (0.33 vs 0.24), while the phase roughly
**triples per-run cost** ($8.31 vs $2.58) and adds ~17k injected context tokens
per run. There is no observed quality dividend to offset that cost.

The conservative move is **collapse-into-plan**: fold the fileTreeDiff /
type-signature scaffolding that program-design produces into the planner's
output so the plan gate still gets structured design intent, without paying for
a separate agent session and phase. Keep the `disableProgramDesign` flag as the
kill switch and re-confirm with one size-matched flag-toggled L batch before
removing the phase code entirely.
