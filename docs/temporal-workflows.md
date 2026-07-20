# Temporal workflows

## Workflow ID

```
awb/task/{repositoryId}/{taskId}
```

One `TaskWorkflow` execution per task, for the task's entire lifetime
(through PR feedback, up to merge/close). `RepositoryDiscoveryWorkflow` runs
once per repository onboarding/refresh cycle and is short-lived.

## Determinism boundary

Workflow code (`packages/workflow`) must be deterministic: no direct
filesystem, network, git, process, clock (beyond Temporal's own
`workflow.now()`), or randomness (beyond Temporal's deterministic RNG).
Everything else — git operations, repository inspection, agent invocation,
command execution, process supervision, verification, QA recording,
adversarial review, artifact storage, GitHub delivery — is an **Activity**,
implemented as a thin wrapper in `workers/temporal-worker/src/activities/`
that delegates to the relevant package (`packages/repository`,
`packages/agent-gateway`, `packages/verification`, `packages/qa`,
`packages/review`, `packages/github`, `packages/workspace`,
`packages/execution`).

The Workflow stores only compact coordination data in its own state: current
phase, current attempt number, latest `CompletionCandidate` IDs, open
`HumanGate` if any. Large logs, videos, plans, and raw agent streams live in
SQLite (via Activities) and the artifact store — never in Workflow history.

## Phase loop shape

Each phase in `TaskPhase` runs through the same shape inside the Workflow:

```
1. Invoke the phase's activity (which may itself invoke an agent session,
   run commands, etc.) → returns PhaseAttemptResult.
2. Switch on `outcome`:
   - "candidate": call evaluatePhaseCompletion(candidate, context).
       - complete → advance to next phase.
       - not complete → increment attempt, loop within the same phase
         (bounded by policy; see budget exhaustion below).
   - "repair" | "replan": route to `target` phase per the loop-routing
     table (spec §12), carrying `findings` into that phase's next attempt.
   - "await-human": persist a HumanGate row, block on the corresponding
     Update (approveX/rejectX) via a Temporal signal/update wait.
   - "blocked": surface reason, condition = "blocked", await human/signal.
   - "cancelled": condition = "cancelled", workflow proceeds to a cleanup
     path (worktree preservation per policy) and completes.
3. Repeated identical failure fingerprint or budget exhaustion escalates to
   an `await-human` HumanGate rather than looping indefinitely.
```

Agents never call anything that changes `phase` directly. The Workflow
decides `phase` transitions purely from `PhaseAttemptResult` +
`evaluatePhaseCompletion`.

## Updates (synchronous)

`approveContract`, `rejectContract`, `approvePlan`, `rejectPlan`,
`approveWaiver`, `approvePermission`, `extendBudget`, `approveScopeChange`.
Each Update validates against current Workflow state (e.g.
`approveContract` is only valid while `condition == "awaiting-human"` and
the pending gate reason is `task-contract-approval`) and returns a result
synchronously to the caller (daemon), rather than firing and forgetting.

## Signals (async)

`cancel`, `pause`, `resume`, `pullRequestFeedbackReceived`,
`pullRequestMerged`, `pullRequestClosed`, `externalBranchChanged`. Signals
are used where the caller does not need to block on a reply — e.g. the
daemon's GitHub polling activity signals `pullRequestFeedbackReceived` and
moves on.

## Queries

`getCurrentState`, `getCurrentAction`, `getCompletionStatus`,
`getOpenFindings`, `getEvidenceStatus`, `getRuntimeBreakdown`,
`getTokenBreakdown`, `getPendingHumanGate`. All queries read only in-memory
Workflow state — they never reach into SQLite or the filesystem, since
Queries must be side-effect-free and fast.

## Invalidation cascade

Implemented as an explicit dependency check inside the relevant phase
activities before trusting existing evidence (spec §11):

```
contract change   → invalidate plan, implementation mapping, verification, QA, review, release
plan change        → invalidate implementation mapping, verification, QA, review, release
candidate SHA change → invalidate verification, QA, review, release
QA scenario change  → invalidate QA, review, release
release rebase changes candidate SHA → route to Verify
```

This is why `Evidence` records the exact `contractVersion`, `planVersion`,
`candidateSha`, and `environmentDigest` they were produced under — the
invalidation check is a straightforward comparison against the task's
current values for each, not a heuristic.

## Testing

`@temporalio/testing`'s `TestWorkflowEnvironment` runs `TaskWorkflow` against
the fake/mock agent adapter. Use `createLocal()` (real-time), not
`createTimeSkipping()` — these tests drive the workflow with wall-clock
polling from outside (queries/signals/updates issued by the test driver),
and time-skipping's "advance the clock whenever the workflow is idle"
behavior races against that polling and produces spurious client-side
execution timeouts. A full lifecycle test (including phase repair loops and
human-approval waits) still runs in real time on the order of seconds. See
`docs/testing.md` and `packages/workflow/README.md`.
