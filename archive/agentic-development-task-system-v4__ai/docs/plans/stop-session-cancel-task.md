# Plan: Stop agent session + Abandon task

> **Final state (as shipped).** Two iterations changed the original plan below:
> 1. The separate `cancelled` status was dropped — it duplicated `abandoned`. There is
>    ONE terminal-by-operator status (`abandoned`) and ONE transition (`abandonTask`),
>    reachable from any non-terminal stage. The gate-only "Abandon" button was removed.
> 2. The UI copy AND the API verb were aligned to the status: button/dialog/summary say
>    **Abandon** / **Task abandoned**, and the route is **`POST /api/tasks/:id/abandon`**
>    → `svc.abandonTask` → core `abandonTask(state)`. No `cancel`/`cancelled` anywhere.
>
> The "Changes" section below is the original first-pass plan, kept for history; read it
> through the two revisions above.

## Brief
Two related operator controls, currently missing:
1. **Stop the running agent session** — kill the live claude CLI subprocess for a task's
   in-flight run (`running` | `awaiting_input`) and mark that run `failed`.
2. **Cancel the task** — terminate the task from ANY stage, not just `human_review`.
   Cancelling also stops any active session first.

Today the only terminal user-driven exit is the gate-only "Abandon" button at
`human_review`. There is no way to stop a wedged/long-running agent or to kill a task
parked at, say, `human_plan_approval` or mid-`implementation`.

## Design decisions
- **Stop = abort the subprocess.** The executor never threaded an AbortController into the
  adapter; the adapter creates its own internal stall `watchdog`. Add a per-run
  `AbortController` map in `AgentRunExecutor`, pass `signal` through `streamStageAgent` →
  `runCliStreaming`, and combine it with the internal watchdog so EITHER aborts the spawn.
- **Stopping resolves nothing it shouldn't.** A run paused on a question (`awaiting_input`)
  has an unresolved gate promise. SIGKILL tears down the MCP relay's held HTTP response, so
  the gate promise never resolves — fine, the run is being killed. The executor's `execute`
  catch/finally records the run `failed`. We do NOT auto-answer the question.
- **Cancel == abandon (REVISED).** A first pass added a distinct `cancelled` status, but
  `abandoned` and `cancelled` are the same outcome ("operator ended this task, terminal,
  stage frozen") — the only difference was reachability. So there is ONE terminal-by-operator
  status (`abandoned`) and ONE action (`cancelTask`), surfaced from every stage. The old
  gate-only "Abandon" button is removed; the header "Cancel task" button replaces it
  everywhere (including at `human_review`). The UI labels the resulting state "Task
  cancelled" since cancel is now the only path to `abandoned`.
- **Cancel from any stage.** `cancelTask(state)` permits any non-terminal (`active` |
  `ready_to_publish`) state; sets `status: 'abandoned'`, stage unchanged. `humanReviewAbandon`
  + the `review/abandon` route are deleted. `HUMAN_REVIEW_DECISIONS` drops `abandon`.
- **No DB migration.** `tasks.status` is a free TEXT column; no status was added.
- **`advanceUntilGate` already halts on `done`/`abandoned`** — no change needed.

## Changes
### Stop the agent session
- `packages/agents/src/index.ts` — add optional `signal?: AbortSignal` to `AgentRunInput`.
- `packages/agents/src/claude.ts` — in `streamStageAgent`, if `input.signal` is set, forward
  an external abort into the existing `watchdog` controller (listen on `input.signal`,
  call `watchdog.abort()`); distinguish a stopped run from a stalled run in the failure
  message (`stopped by operator` vs `stalled`).
- `apps/daemon/src/agent-run-executor.ts` —
  - add `private readonly aborters = new Map<string, AbortController>()`;
  - in `execute`, create a controller, register it under `runId`, pass `signal` into
    `runStreaming`, and clean it up in a `finally`;
  - add `stop(runId): boolean` — abort the controller if present, return whether it existed.
- `apps/daemon/src/service.ts` — add `stopAgentRun(runId): AgentRun`:
  - 404 if run unknown; 409 if already terminal (`succeeded`/`failed`);
  - call `runExecutor.stop(runId)`; the abort makes `execute` record the run `failed` with
    `error: 'stopped by operator'`. If the abort raced (no live controller — e.g. orphaned),
    fall back to marking it `failed` directly so the UI doesn't hang on a zombie `running`.
  - return the refreshed run.
- `apps/daemon/src/app.ts` — `POST /api/tasks/:id/agent/runs/:runId/stop` →
  `svc.stopAgentRun(runId)`.

### Cancel the task
- `packages/core/src/lifecycle.ts` — add `'cancelled'` to `TASK_STATUSES`.
- `packages/core/src/transitions.ts` — add `cancelTask(state)`: throws if already terminal
  (`done`/`abandoned`/`cancelled`), else `{ stage: state.stage, status: 'cancelled' }`.
- `apps/daemon/src/service.ts` — add `cancelTask(taskId, comment?): Task`:
  - stop the active run first (best-effort, via `activeAgentRun` + `stopAgentRun`);
  - `recordApproval` is approval-gate-shaped and not appropriate here — instead just
    `transition` to `cancelled` with the comment as the StageRun note.
- `apps/daemon/src/app.ts` — `action('cancel', (id, b) => svc.cancelTask(id, b.comment))`.
- `apps/daemon/src/service.ts advanceUntilGate` — add `cancelled` to the terminal halt check.

### UI
- `packages/client/src/types.ts` — extend `TaskStatus`/`AgentRunStatus` if duplicated
  (verify shared vs local).
- `apps/web/src/stage-actions.ts` — block all actions when `status === 'cancelled'`.
- `apps/web/src/components/ui/badge.tsx` — add a `cancelled` variant (muted/danger tone).
- `apps/web/src/pages/Board.tsx` — `statusVariant` + status dot handle `cancelled`.
- `apps/web/src/pages/TaskDetail.tsx` —
  - `statusDotClass` handles `cancelled`;
  - add a **Stop agent session** button in/near the live `RunTerminal` header area, shown
    only while an active run exists, calling `POST .../runs/:runId/stop`;
  - add a **Cancel task** action (header, danger tone) shown for any non-terminal task,
    calling `POST /api/tasks/:id/cancel`, with a confirm.
- `packages/client/src/client.ts` — add a `stopRun(taskId, runId)` helper (or reuse the
  generic action path for cancel).

## Tests
### unit
- `packages/core` transitions: `cancelTask` from `active`, `ready_to_publish` → `cancelled`;
  throws from `done`/`abandoned`/`cancelled`.
- `packages/agents` claude adapter: external `signal` abort → failed result with
  `stopped by operator`; internal stall still works.
- `apps/daemon` executor: `start` then `stop(runId)` → run ends `failed`; `stop` on unknown
  run returns false.
- `apps/daemon` app/service: `POST /stop` on active run → 200 + run failed; on terminal →
  409. `POST /cancel` → task `cancelled`; cancel halts `advanceUntilGate`; cancel on a
  terminal task → 409.
- `apps/web` stage-actions: no actions when `cancelled`.

### manual (backend python script not applicable — TS monorepo)
- `pnpm -w test` (or per-package vitest), `pnpm -w typecheck`, biome.
- Optional live: start daemon + web, drive a real claude run, click **Stop agent session**,
  confirm the subprocess dies and the run flips to failed; click **Cancel task**, confirm
  the task shows `cancelled` and no further stages run.
