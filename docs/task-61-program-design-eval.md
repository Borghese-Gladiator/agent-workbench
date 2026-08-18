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

## Metrics (fill after runs)

| metric | with program-design | without | delta |
| --- | --- | --- | --- |
| rework / loop-back count per run | | | |
| reviewed slices / total slices | | | |
| challenge findings per run | | | |
| comment + maintainability density | | | |
| total tokens per run | | | |

## Recommendation

_Keep / collapse-into-plan / drop — decide from the table above. Program-design
is worth keeping only if the treatment arm shows materially more rework or
lower reviewed-ratio at comparable token cost._
