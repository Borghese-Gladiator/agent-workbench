# Plan — observability latency: backend

## Brief
Build the backend latency observability identified in
`docs/observability-latency-investigation.md`. UI is out of scope (separate
effort). Three deliverables:

1. **Inter-event gaps** — a new pure `eventGaps()` profiling function that
   separates model/transit gap (between consecutive `receivedAt`s) from
   daemon persist gap (`createdAt - receivedAt`), with aggregates + top-N stalls.
2. **Persist latency on the run row** — `durationApiMs` (true model-API latency
   from the CLI `result` line) and a run-level `ttftMs` (first turn's TTFT) onto
   `AgentRun`, so they survive without replaying the event stream and are
   queryable/sortable.
3. Wire both into `profileStage()` + the `wb task profile` CLI report.

## Changes
- `packages/core/src/profiling.ts`
  - Add `receivedAt: Timestamp | null` to `ProfileEvent` (it already exists on
    `AgentRunEvent`, so the structural-subset guard still holds).
  - New `eventGaps(events)` → `{ gaps: EventGap[], modelGap: LatencyStats,
    persistGap: LatencyStats, slowest: EventGap[] }`.
  - Add `gaps` to `StageProfile` + compute it in `profileStage()`.
- `packages/core/src/agent-runs.ts`
  - Add `durationApiMs: number | null` and `ttftMs: number | null` to `AgentRun`.
- `packages/store/src/schema-types.ts` — add the two columns to `AgentRunsTable`.
- `packages/store/src/migrations.ts` — migration `0012_agent_run_latency`
  (guarded ALTERs for `duration_api_ms`, `ttft_ms`).
- `packages/store/src/store.ts`
  - `createAgentRun`: seed both columns null.
  - `updateAgentRun`: accept `durationApiMs` + `ttftMs` in the patch type.
- `apps/daemon/src/agent-run-executor.ts`
  - Stop stripping `durationApiMs` from the cost patch; persist it on finish.
  - Track the first turn's `ttftMs` and persist as the run-level `ttftMs`.
- `packages/client/src/cli.ts`
  - Read run-level `durationApiMs`/`ttftMs` from the row (fallback to event
    replay for legacy rows); add an inter-event gap section to the report.

## Tests (unit)
- `eventGaps`: empty stream; single event; two events with known gaps; a
  null-`receivedAt` (legacy) pair handled without crashing; top-N ordering;
  persist-gap computed from `createdAt - receivedAt`.
- Store round-trip: `createAgentRun` then `updateAgentRun({durationApiMs, ttftMs})`
  then `getAgentRun` returns them; migration is idempotent.

## Tests (manual)
- Run the existing store + core vitest suites.
- `pnpm -w build` / typecheck clean across touched packages.
