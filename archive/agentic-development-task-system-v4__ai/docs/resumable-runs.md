# Architecture — Resumable Agent Runs & Orphan Prevention

## The problem, stated as an invariant

An agent run is a **long-lived side effect** — a spawned `claude` OS process
plus a Claude *conversation* (session id) — but today its only owner is the
daemon's **in-memory state**: the `aborters`, `subscribers`, and gate `pending`
maps (`agent-run-executor.ts:102-108`, `question-gate.ts:36`). The OS process is
spawned non-`detached` (`claude.ts:998`) and killed only through an in-memory
`AbortController`.

When the daemon dies, that ownership evaporates but the side effect does not:
- the `claude` process is reparented to init and keeps burning tokens/CPU (orphan);
- so does its child MCP `workbench-ask` server (a *second*, separate orphan);
- the `awaiting_input` resolver promise is gone, so even a human answer can't
  wake the conversation;
- the `agent_runs` row is stuck `running`, and the task behind it is parked.

**Invariant we want:** *every spawned process and every in-flight conversation is
either owned by a live daemon, or deterministically reconciled by the next
daemon boot — never silently abandoned.* "Resumable runs" is how we satisfy the
conversation half of that invariant; "process-group ownership" is how we satisfy
the process half. Killing orphans is the fallback, not the strategy.

## What we already have (the foundation is 80% built)

- `AgentRun` is a **durable, first-class record** with `sessionId`, `status`, and
  a monotonic, replayable event log (`agent-runs.ts:63`, `AgentRunEvent.seq`).
- The Claude CLI session id is captured from the stream's `system`/`init` line
  and persisted (`claude.ts:845`, `agent-runs.ts:80`).
- `--resume <sessionId>` already works in-process for brief/plan/impl redos
  (`claude.ts:452`), **and the service already treats resume as fallible** — if a
  session "aged out of the CLI's store" it falls back to regenerate-from-scratch
  (`service.ts:504,1024`). So cross-restart resume is an *extension of an existing,
  already-guarded pattern*, not a brand-new guarantee.
- `advanceUntilGate` is **idempotent** and self-guarding (`service.ts:1907-1933`):
  the natural re-entry point for re-driving a task.

The gaps are narrow: (1) a status that says "interrupted, try to resume" vs
"failed, don't"; (2) a kill handle that survives restart (process group); (3)
boot logic that reconciles each non-terminal run.

## The model: an AgentRun is a durable state machine

Add one non-terminal status and make every status transition a checkpoint on
the row (the row already exists and is written on each lifecycle event).

```
                 spawn (pid+pgid persisted)
        ┌──────────────────────────────────────┐
        ▼                                        │
   ┌─────────┐   ask()    ┌────────────────┐    │ answer()
   │ running │──────────▶│ awaiting_input │────┘
   └─────────┘◀──────────└────────────────┘
     │      │                    │
     │ ok   │ err/abort          │ (daemon dies in any of these)
     ▼      ▼                    ▼
 ┌─────────┐ ┌────────┐    ┌───────────────┐
 │succeeded│ │ failed │    │  interrupted  │  ← NEW: set on boot for any
 └─────────┘ └────────┘    └───────────────┘    row left running/awaiting_input
                                  │
                       boot reconciliation decides:
                       ┌──────────┴───────────┐
              resumable session?         not resumable
            (sessionId + repo ok)        (mock / no session / repo gone)
                       │                       │
                       ▼                       ▼
              re-spawn --resume          re-run stage fresh
              (continue conversation)    (advanceUntilGate; stage is idempotent)
```

`interrupted` is deliberately distinct from `failed`:
- `failed` = the run itself produced an error result; do not silently retry.
- `interrupted` = the daemon vanished mid-run; the conversation may be intact and
  is a *candidate* for resume. Keeping them separate means boot reconciliation
  only ever auto-resumes things that were actually interrupted, never things that
  legitimately failed.

(`isTerminalAgentRunStatus` stays `succeeded|failed`; `interrupted` is
transient — boot moves it to a terminal state or to a fresh run.)

## Spawn ownership: process groups, session id at spawn

Two changes to how a run is spawned so the kill side is clean and the durable
record is complete the instant the process exists:

1. **Detached process group.** Spawn the CLI with `detached: true` (POSIX
   `setsid`) so the `claude` process AND its child MCP `workbench-ask` server
   share a new process group. Persist the **PGID** (= the child's pid, since it
   leads the group). A single `process.kill(-pgid, 'SIGKILL')` reaps the whole
   tree — fixing the *second-orphan* problem (the ask server) for free. The
   daemon does NOT `unref()` the child during normal operation (it still wants
   close/stream events); detached is purely for group-kill semantics.

2. **PID/PGID persisted at spawn, session id as soon as known.** `child.pid`
   exists synchronously at `spawn()` — persist it immediately (before any stream
   line). The session id arrives on the first `init` line; persist it then (as
   today). This ordering matters: a process that hangs before emitting `init`
   still has a recorded pgid to kill, even though it has no session to resume.

## Boot reconciliation (the one place all of this comes together)

Runs AFTER migrations, in `main.ts`, in this order:

```
1. markInterruptedRuns()        // running/awaiting_input -> interrupted (was failOrphanedRuns)
2. reapOrphanProcessGroups()    // for each interrupted run with a pgid: verify + SIGKILL group
3. app.listen(127.0.0.1, …)     // HTTP edge up BEFORE slow resume work
4. void reconcileInterruptedRuns()  // detached: resume conversation or re-run stage, per run
```

- **markInterruptedRuns** replaces the current `failOrphanedRuns` semantics: same
  query (`status in running|awaiting_input`), but the new status is `interrupted`
  and we still append a terminal event so any reconnecting SSE client stops
  replaying. (A run we then successfully resume gets a NEW run id — the SSE
  client refetches and re-attaches; we never mutate a closed event log.)
- **reapOrphanProcessGroups** is fail-safe: `process.kill(pgid, 0)` for liveness,
  then an identity check (the group leader's argv contains our `claude` bin and
  the run's worktree path, via `ps`) before `SIGKILL`. Unverifiable → log + skip.
  Never signals a pid/pgid it can't confirm is ours (guards PID reuse + a human's
  hand-launched claude in the same worktree).
- **reconcileInterruptedRuns** is the resume engine. Per interrupted run,
  sequentially (no thundering herd), inside try/catch:
  - **Resumable** (has `sessionId`, project repo + worktree still exist): start a
    fresh AgentRun that the adapter invokes with `--resume <sessionId>` and a
    short "continue" turn, re-attaching the stream pipeline. The existing
    resume-failure fallback (`service.ts:504`) catches an aged-out session and
    downgrades to a fresh stage run — we reuse it verbatim.
  - **Not resumable** (mock runtime, no session id, or repo gone): drop to
    `advanceUntilGate(taskId)`, which re-runs the idempotent stage from its
    persisted context. A task whose repo is gone is logged + skipped, never
    allowed to wedge boot.

## Why not the alternatives (recorded so we don't relitigate)

- **PID instead of session id:** a PID kills a process; it cannot *continue a
  conversation*. We need both — pgid for the kill, sessionId for the resume.
  They're orthogonal, not substitutes.
- **Worktree-path pgrep instead of a recorded pgid:** fuzzy; would match a
  human's hand-launched `claude` in the same dir. The recorded pgid + identity
  check is precise.
- **Re-attach to the still-alive process on boot:** rejected for now. Re-adopting
  a live child's stdout across a process restart is fragile (the pipe died with
  the parent). Killing + resuming the *conversation* gets the same user outcome
  (no lost model work) with far less machinery.

## Risk & safety

- **No new auto-mutation surface.** Reconciliation only re-enters stages the
  auto-advance driver already runs unattended; `isAutoAdvanceable` still excludes
  all four human gates, so boot can never cross a gate (same guarantee traced in
  TODO.md's gate analysis).
- **Resume is best-effort with an existing fallback.** An un-resumable session
  degrades to a fresh idempotent stage run — never a park.
- **Group-kill is fail-safe.** Unverifiable group → skip.
- **Idempotent across repeated restarts.** A resumed run that re-interrupts is
  handled identically next boot; a stage that re-parks at the same point stops
  (the no-progress guard in `advanceUntilGate`).

## Implementation slices (land in order; each independently green)

1. **Durable spawn handle.** Migration `0013_agent_run_pgid` (`pgid INTEGER`);
   `AgentRunsTable` + `AgentRun` gain `pgid`; spawn with `detached:true`; thread
   `child.pid` up via an `onSpawn(pgid)` hook; executor persists it. (No behavior
   change yet — just records the handle.)
2. **`interrupted` status + markInterruptedRuns.** Add the status to
   `AGENT_RUN_STATUSES`; rename/retarget `failOrphanedRuns` →
   `markInterruptedRuns`; keep terminal-event emission. Update callers/tests.
3. **reapOrphanProcessGroups.** New `boot-reconcile.ts`; verify + group-SIGKILL;
   wire into `main.ts` after step 2's sweep, before `listen`.
4. **reconcileInterruptedRuns (resume engine).** `listInterruptedRuns` in store;
   service method that resumes-or-restarts per run; reuse the existing
   resume-failure fallback; fire detached after `listen`.

## Tests

### Unit
- `0013` migration (extend `migrator.test.ts` ALL_MIGRATIONS + partial-seed test,
  as `0012` was handled).
- `markInterruptedRuns`: running/awaiting_input → `interrupted` + terminal event;
  terminal runs untouched.
- `boot-reconcile`: group-kill kills a verified live child group (spawn a real
  `sleep` leader + child, assert both die); skips an unverifiable pgid; no-op when
  no pgid recorded.
- `reconcileInterruptedRuns`: a resumable interrupted run starts a `--resume` run
  (assert adapter got `resume.sessionId`); a mock/no-session run drops to
  `advanceUntilGate`; an aged-out session falls back to fresh; a per-run throw
  doesn't abort the batch; a task at a human gate is untouched.

### Manual (backend script)
1. claude-runtime task; advance to `implementation`; `kill -9` the daemon mid-run.
2. In SQLite: run is `running` with a `pgid`; `ps -p <pgid>` shows the live
   orphan group (claude + ask server).
3. Restart. Assert from logs + DB: run → `interrupted`; the orphan group is
   killed (logged, `ps` confirms gone); a NEW run starts with `--resume` against
   the captured session id; the task advances to its next gate.
4. Restart with nothing interrupted → clean no-op (all counts 0).
```
