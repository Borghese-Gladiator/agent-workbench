# Verifying Group H (TASK-61 / TASK-62 / TASK-79 measurement + eval)

QA evidence for the measurement/evaluation slice: the instrumentation was
exercised end-to-end against real data (the live workbench SQLite and a real
local Ollama), not just unit-tested. This is a copy-paste cheat-sheet to
reproduce every number in the three writeups.

Paths used below:
- DB: `~/.agentic-workbench/database/workbench.sqlite` (survives `awb down`)
- Ollama: `http://127.0.0.1:11434` (candidate models pulled locally)

---

## TASK-79 — per-phase token audit (live DB)

```bash
node scripts/token-spend-by-phase.mjs ~/.agentic-workbench/database/workbench.sqlite
```

Observed (all tasks), ranked by input spend:

```
  phase         fresh   cache_read  cache_write   output      cost   static_ctx  injected_ctx
  implement    445267    99100875      1908734   543717  $82.9824           0         14148
  plan         293003     8791325      1458485   197982  $24.7705       33150        142697
  challenge    177631     3047580            0    29159   $3.3061         438          3226
  program-design 1825     1222043       243245    80093   $5.0549        3893         17124
  TOTAL        917726   112161823      3610464   850951  $116.1140       37481        177195
```

Reading and the applied prompt reductions (measured −33% planner / −16%
program-design static scaffolding) are in `docs/task-79-prompt-token-audit.md`.

The `--help` and `--task <id>` paths are also exercised:

```bash
node scripts/token-spend-by-phase.mjs --help
node scripts/token-spend-by-phase.mjs ~/.agentic-workbench/database/workbench.sqlite --task <taskId>
```

---

## TASK-61 — program-design A/B (observational, live DB)

The `planning.disableProgramDesign` flag is new; no flag-toggled batch exists
yet, so the arm is derived from whether a run executed a `program-design` phase
(the same partition `programDesignEnabled` will produce for future flag runs).

```bash
sqlite3 ~/.agentic-workbench/database/workbench.sqlite "
WITH pd_runs AS (SELECT DISTINCT run_id FROM semantic_events WHERE phase='program-design')
SELECT CASE WHEN se.run_id IN (SELECT run_id FROM pd_runs) THEN 'with-pd' ELSE 'no-pd' END AS arm,
  COUNT(DISTINCT se.run_id) runs,
  SUM(se.type='phase-failed') phase_failed,
  SUM(se.type='attempt-retry-scheduled') retries
FROM semantic_events se GROUP BY arm;"
# no-pd|25|8|6
# with-pd|9|3|3
```

Per-run cost/tokens by arm:

```bash
sqlite3 ~/.agentic-workbench/database/workbench.sqlite "
WITH pd_runs AS (SELECT DISTINCT run_id FROM semantic_events WHERE phase='program-design'),
run_cost AS (SELECT s.run_id, SUM(mi.cost_usd) cost, SUM(mi.input_tokens+mi.output_tokens) toks
  FROM model_invocations mi JOIN agent_sessions s ON s.id=mi.agent_session_id GROUP BY s.run_id)
SELECT CASE WHEN rc.run_id IN (SELECT run_id FROM pd_runs) THEN 'with-pd' ELSE 'no-pd' END AS arm,
  COUNT(*) runs, ROUND(AVG(rc.cost),4) avg_cost, ROUND(AVG(rc.toks),0) avg_toks
FROM run_cost rc GROUP BY arm;"
# no-pd|19|2.5825|64666.0
# with-pd|9|8.3105|60003.0
```

Verdict (drop / collapse-into-plan) and caveats in
`docs/task-61-program-design-eval.md`.

To reproduce a clean flag-toggled A/B once desired: set
`planning.disableProgramDesign: true` in `~/.agentic-workbench/config.yaml`, run
a matched L batch, and partition by `programDesignEnabled` on the control-plane
`semantic_events`.

---

## TASK-62 — shadow size-classifier eval (real Ollama)

Candidate models are pulled locally (`ollama list`): `qwen3:30b`,
`gemma4:26b`, `qwen3-coder:30b`, `llama3.2:latest`.

```bash
node scripts/size-classifier-eval.mjs \
  --models llama3.2:latest,qwen3:30b,gemma4:26b,qwen3-coder:30b --runs 3
```

Results and the per-model promote/keep-shadow/decline calls are in
`docs/task-62-shadow-classifier-eval.md`. Smaller smoke run:

```bash
node scripts/size-classifier-eval.mjs --models llama3.2:latest --runs 1
# llama3.2:latest  accuracy 55.0%  agreement 100.0%  cost_err 40  under_sized 14
```

The read-only runner never writes the workbench DB; the live shadow path
(`classifier-support.ts`) records the same `scoreSizeComparison` fields
(`underSized`, `costWeight`) on the `size-classifier-shadow` semantic event.

---

## Unit coverage (survives teardown, no stack)

```bash
npx vitest run \
  packages/config/src/config.test.ts \
  packages/workflow/src/phase-order.test.ts \
  packages/database/src/data-access/observability.test.ts \
  workers/temporal-worker/src/activities/classifier-support.test.ts \
  workers/temporal-worker/src/activities/plan-support.test.ts
# 5 files, 41 tests passing
```
