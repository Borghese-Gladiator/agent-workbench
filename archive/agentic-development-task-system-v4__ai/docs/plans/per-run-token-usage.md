# Plan: Capture per-run token usage, not just cost

## Brief

Today an `AgentRun` records only `totalCostUsd` + `numTurns`. The Claude CLI's
terminal `result` message also carries a `usage` object
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`) that the adapter parses past and drops. Capture it so
each run shows a real token breakdown — and especially **cache-read tokens**,
which on long resumed plan/impl sessions are likely where most of the spend sits
and the main lever for reducing it.

Scope = TODO option 1 (per-RUN totals). Per-turn attribution (option 2) is out
of scope.

### Data path (every layer must carry the new fields)

```
claude CLI `result` line.usage
  → consumeStreamLine() emits `cost` event           packages/agents/src/claude.ts:640
  → executor `cost` holder                            apps/daemon/src/agent-run-executor.ts:206
  → store.updateAgentRun()                            apps/daemon/src/agent-run-executor.ts:263
  → agent_runs columns                                packages/store/src/migrations.ts + schema-types.ts
  → AgentRun domain type                              packages/core/src/agent-runs.ts:29
  → /api/tasks/:id bundle (serialized as-is)          apps/daemon/src/app.ts:218
  → RunTerminal cost line                             apps/web/src/components/RunTerminal.tsx:162
```

The one-shot path (`runStageAgent`, `claude.ts:330`) parses the same `result`
object; it currently builds no AgentRun row at all (only the streaming executor
does), so it's out of scope for persistence — but I'll add `usage` to
`CliJsonResult` so the type is honest and the transcript can show it.

## Changes

### 1. Type the `usage` object — `packages/agents/src/claude.ts`
- Add `usage?: CliUsage` to `CliJsonResult` (interface ~`:91`), where
  `CliUsage = { input_tokens?, output_tokens?, cache_creation_input_tokens?,
  cache_read_input_tokens? }` (all `number | undefined`).
- Add the same four fields (camelCase) to `StreamAccumulator` (`:556`).

### 2. Thread usage through the stream `cost` event — `packages/agents/src/claude.ts`
- In `consumeStreamLine`'s `result` branch (`:640`), read `msg.usage` and store
  the four counts on `acc`.
- Widen the `cost` event payload (`:648`) from `{ totalCostUsd, numTurns }` to
  also include `inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens` (all `number | null`).
- The synthetic `cost` event in the mock adapter (`index.ts:614`) gets the new
  fields as `null` (or small fake values) so the payload shape is uniform.

### 3. Persist on the AgentRun — `packages/store` + `packages/core`
- **Migration** `0009_agent_run_token_usage` (`migrations.ts`, after `0008`):
  guarded `ALTER TABLE agent_runs ADD COLUMN` ×4 — `input_tokens INTEGER`,
  `output_tokens INTEGER`, `cache_creation_input_tokens INTEGER`,
  `cache_read_input_tokens INTEGER`. Follow the `hasColumn` guard pattern at
  `:276`. Add `'0009_agent_run_token_usage'` to `migrator.test.ts:34` list.
- **schema-types.ts** `AgentRunsTable` (`:113`): add the four camelCase fields
  `number | null`.
- **core agent-runs.ts** `AgentRun` (`:29`): add the same four fields + doc
  comment (null for mock/legacy runs).
- **store.ts**: `createAgentRun` (`:617`) inserts the four as `null`;
  `updateAgentRun`'s `Pick<>` (`:675`) gains the four field names so they're
  patchable.

### 4. Persist from the executor — `apps/daemon/src/agent-run-executor.ts`
- Widen the `cost` holder (`:206`) to carry the four token fields.
- In the `onEvent` `cost` branch (`:216`), copy them off the payload.
- In the success `updateAgentRun` call (`:263`), pass the four through.
  - Also pass them on the **failure** branch's `updateAgentRun` if one exists —
    a mid-stream `result` can carry usage even on a non-success subtype; check
    the failure branch (just below `:284`) and capture there too if it updates
    the row. (Confirm during impl; don't fabricate a write that isn't there.)

### 5. Surface in the UI — `apps/web/src/components/RunTerminal.tsx`
- Widen the local `cost` state + `onCost` payload type (`:42`, `:45`) and the
  `case 'cost'` cast (`:92`) to include the four fields.
- Extend the header cost line (`:162`) to append cache read/write, e.g.
  `42 turns · $0.91 · 18.2k in · 3.1k out · 240k cached`. Keep it compact;
  only render token counts when present. Humanize large counts (k/M).
- The finished-run view reads `AgentRun` from the task bundle (already wired) —
  confirm it renders the persisted counts on reload, not just live.

### 6. Per-stage cost bar + task total — `apps/web/src/pages/TaskDetail.tsx`
The transparency ask: clicking a stage shows what THAT stage cost, at the top of
the center panel; plus a whole-task roll-up in the header.

- **Shared humanizer + cost-sum helper.** Add a `humanTokens(n)` (k/M) and a
  `sumRunCost(runs)` that totals `totalCostUsd`, `numTurns`, and the four token
  fields across a list of `AgentRun`s, returning nulls when no run has data.
  Lives near `latestRunCost` (`:193`); reused by both surfaces below.
- **Per-stage bar.** A stage can run multiple times (rejection / review bounce
  each create a fresh `AgentRun`), so sum ALL runs for the selected stage:
  `detail.agentRuns.filter(r => r.stage === selectedStage)`. Add a
  `costForStage` memo. Render a compact `StageCostBar` at the TOP of the center
  panel (above the live terminal / artifact area, ~`:585`), shown only when the
  selected stage has ≥1 run with cost data:
  `Task Brief · 2 runs · $0.33 · 14 turns · 22k in · 4k out · 310k cached`
  ("N runs" only when >1; "cached" = cache_read, called out deliberately).
- **Task total.** Sum every run (`sumRunCost(detail.agentRuns)`) and show it in
  the header next to the existing `InlineCost` (`:427`) — e.g. a
  `TaskTotalCost` chip: `task · $1.41 · 320k cached`. One glance = whole-task
  spend. Distinct from `InlineCost` (live/latest single run) — keep both.
- **Extend `InlineCost`** (`:850`) with the token breakdown too, so the
  live/latest run is as transparent as the per-stage bar.

## Open question — CLOSED (verified against a live run, CLI 2.1.179)
The `usage` field names on the CLI's `result` line were assumed to match the
Anthropic API. **Confirmed with a real `claude -p --output-format stream-json`
run** — the terminal `result` line carries exactly:

```json
"usage": {
  "input_tokens": 8531,
  "cache_creation_input_tokens": 14499,
  "cache_read_input_tokens": 0,
  "output_tokens": 4,
  ...also: server_tool_use, service_tier, cache_creation (1h/5m split),
           iterations[] (per-message), speed
}
```

All four keys `tokenUsageFrom()` reads are present and correctly named. The
extra fields (TTL split, `iterations[]`) are unused by option-1 totals;
`iterations[]` is the natural source for option-2 per-turn attribution later.
There is also a sibling top-level `modelUsage` keyed by model id with the same
four counts in camelCase + `costUSD` — we correctly use canonical `usage`, not
that. No code change needed; the assumption held.

## Tests

### Unit
- **agents** (`packages/agents/src/*.test.ts`): feed a scripted `result` NDJSON
  line carrying a `usage` object to the stream consumer; assert the emitted
  `cost` event payload includes the four token fields. Add a case with `usage`
  absent → fields are `null`. Reuse the existing `cliJson`/stream-line test
  helpers.
- **store** (`store.test.ts`): `updateAgentRun` with the four token fields →
  `getAgentRun` returns them; default is `null` on a fresh `createAgentRun`.
- **migrator** (`migrator.test.ts`): `0009` present in the ordered list; full
  migrate run is green (existing test covers apply-all).
- **web** (`RunTerminal.test.tsx`): a `cost` event with token fields renders the
  humanized breakdown in the header; absent fields render the old
  `turns · $cost` line unchanged.
- **web** (`TaskDetail.test.tsx`): with a task bundle whose `agentRuns` carry
  token usage — (a) selecting a stage with 2 runs renders the `StageCostBar`
  summing both runs (incl. cached); (b) a stage with no run shows no bar;
  (c) the header `TaskTotalCost` sums across all stages' runs.

### Manual
Frontend (browser actions):
1. Start a real claude-runtime task (implementation stage) in the workbench UI.
2. Watch the live `RunTerminal` header — confirm the token breakdown appears and
   updates on the terminal `cost` event, alongside turns + $cost.
3. Reload the task page after the run finishes — confirm the persisted token
   counts still render on the finished run (proves the DB round-trip, not just
   the live SSE payload).
4. Click an older finished stage in the left rail — confirm the per-stage cost
   bar appears at the top of the center panel with that stage's $ / turns /
   token breakdown, and the header task-total reflects the sum of all stages.
5. Run a **resumed** stage (reject the brief) — confirm the stage now shows
   "2 runs" and `cacheReadInputTokens` is large relative to `inputTokens` (the
   whole point: resumed sessions are cache-heavy).

Backend (verification):
- `pnpm -C ... test` for `store`, `agents`, `daemon`, `web` packages all green.
- typecheck + biome clean across changed packages.
- Inspect one real `agent_runs` row after a live run
  (`sqlite3 data/*.sqlite 'select * from agent_runs order by started_at desc limit 1'`)
  to confirm the four columns are populated, non-null, and sane.

## Out of scope
- Per-turn token attribution (option 2) — would accumulate `usage` off every
  `message_delta`; do later only if per-run isn't enough.
- Computing dollar cost from tokens × published rates — `total_cost_usd` from the
  CLI is already authoritative; the token breakdown is for visibility + cache
  insight, not re-deriving cost.
- One-shot (`runStageAgent`) persistence — that path builds no AgentRun row.
