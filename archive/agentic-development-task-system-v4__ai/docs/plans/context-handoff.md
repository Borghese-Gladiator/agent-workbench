# Stage Context Handoff — Plan

## Brief
The lifecycle hands each stage only artifact **IDs**
(`claudeStagePrompt`, `packages/agents/src/index.ts:501-503`:
`Context artifacts available to you (ids): art_X, art_Y`). The bodies live on
disk in the daemon data dir, OUTSIDE the agent's worktree sandbox, so the agent
**cannot read them** — every stage starts blind to prior stages' written output
and re-derives it (measured: discovery 45 tool calls, planning then 52 more,
mostly re-grepping/re-reading what discovery already found).

Goal of THIS pass (step 1): capture the EXACT prompts the daemon assembles for
each stage on a real run, prove they carry only IDs, then decide what context is
worth threading.

## Changes

### Step 1 — capture (this commit)
- Add an env-gated prompt capture to `claudeStagePrompt` (and the resume turn):
  when `WORKBENCH_CAPTURE_PROMPTS=<dir>` is set, append every assembled stage
  prompt to `<dir>/<NN>-<stage>.txt`. Zero behavior change when unset.
- Drive a full real run with `scripts/live-e2e.mjs` (tic-tac-toe default) with the
  capture dir set, and save the prompts under `docs/evidence/context-handoff/`.

### Step 2 — thread bodies (DECIDED)

Selection: **explicit per-stage allowlist** of upstream artifact KINDS.
Size guard: **no truncation** — pass full bodies (truncating planning context would
re-create the exact rediscovery bug). Soft warn-log only if a body is enormous.

Per-stage context kinds (latest body per kind):
| stage | context kinds |
|-------|---------------|
| task_brief | (none) |
| discovery | task_brief |
| options_plan_test | task_brief, discovery |
| implementation | execution_plan, task_brief |
| validation_demo | execution_plan, task_brief |
| agent_self_review | task_brief, execution_plan |
| delivery_prep | execution_plan, validation_report, self_review |
| delivery_conflict | (none) |

- `packages/agents/src/index.ts`:
  - Add `STAGE_CONTEXT_KINDS: Record<string, ArtifactKind[]>` + exported
    `contextKindsForStage(stage)`.
  - Add `AgentRunInput.contextArtifacts?: { kind; title; body }[]` (resolved bodies).
  - `claudeStagePrompt` renders a `## Prior context` section from `contextArtifacts`
    (full bodies, labelled by kind/title). Keep the ids line as a short footnote.
  - Skip on resume (session already holds context).
- `apps/daemon/src/service.ts`:
  - One helper `resolveStageContext(taskId, stage)` -> reads the latest artifact of
    each `contextKindsForStage(stage)` and `store.readArtifactBody`s it.
  - Replace the 5 `contextArtifactIds: listArtifacts().map(id)` sites to ALSO pass
    `contextArtifacts: this.resolveStageContext(...)`. Keep ids for the footnote.
- Tests: agents (render bodies, allowlist, resume-skip) + daemon (resolver picks the
  latest per kind, threads bodies into the run input).

## Tests
### unit
- `claudeStagePrompt` still renders ids when capture env unset (existing tests green).
- New: capture writes a file with the prompt when env set (temp dir).
### manual
- `WORKBENCH_CAPTURE_PROMPTS=... node scripts/live-e2e.mjs` -> inspect captured
  per-stage prompts; confirm only ids appear in the context section.
