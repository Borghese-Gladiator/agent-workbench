# Backlog
Prioritized List of Things to Fix

Every task should have what is wrong / what to do, where, and how we'll know when it's done


## Group AD — Observability & monitoring integrity (BLOCKS multi-task builds, 2026-09-04)

Found during a readiness audit before a large multi-task build. Build and the full test
suite are green (1217 tests), the stack boots, draft-PR delivery and interactive QA are
real. The gap is **read-back**: the workbench does the work but cannot honestly report
what phase a task is in, how long a phase took, or whether a task is still alive.

Two independent seams, deliberately split so they can be built in parallel:
- **Monitoring** (TASK-123, 126, 127) — *is this task alive and where is it right now?*
  Owns `tasks` / `task_summary` / `awb fleet` / `awb status`.
- **Observability** (TASK-124, 125, 128) — *after the fact, what took the time and what
  happened?* Owns `phase_attempts` / `agent_sessions` / the read-back CLI.

They touch different tables and different commands. Do not let one branch edit the other's
surface.

### [ ] TASK-123: `tasks.phase` and `tasks.condition` are write-once — the entire fleet monitoring surface is frozen at task creation

**What's wrong.** Nothing in production ever writes a task's phase or condition after the
row is inserted. Every one of the 40 tasks in the local database reads `specify | running`,
including tasks that actually reached `challenge` and parked at `awaiting-human`. `awb
fleet` therefore prints a dead PHASE column and a dead COND column for every row. `awb task
show` is correct only because it queries the live Temporal Workflow, not the database.

The daemon already exposes the write route — `PUT /internal/tasks/:taskId`, which accepts
`phase`, `condition` and `deliveryState`
(`apps/daemon/src/routes/internal.ts:35-53`) — and the worker already defines the client
method that calls it (`workers/temporal-worker/src/daemon-client.ts:46,76`). **No
production code path calls either.** The only callers are tests. `refreshTaskSummary`
(`packages/database/src/data-access/tasks.ts:275`) then faithfully projects the stale row
into `task_summary`, which is what `getFleetStatus` reads.

**What to do.** Call `daemonClient.upsertTask` with the current `phase`, `condition` and
`deliveryState` on every lifecycle transition, so the database tracks the Workflow. The
Workflow itself must stay I/O-free, so the write belongs in an Activity — either fold it
into the existing `runPhase` entry/exit path (which already reaches the daemon for
run-state snapshots) or add a small dedicated `syncTaskState` Activity the Workflow invokes
on each transition. Prefer folding it into the existing seam over adding a new Activity.
Cover the phase transitions, the loop-backs (repair / replan), the human-gate parks, and
the terminal states.

**Where.** `workers/temporal-worker/src/activities/run-phase.ts` (transition points),
`workers/temporal-worker/src/daemon-client.ts:46,76`,
`apps/daemon/src/routes/internal.ts:35`, `packages/database/src/data-access/tasks.ts:86,275`,
`packages/workflow/src/task-workflow.ts` (if a dedicated Activity is chosen). Relates to
TASK-127 (a correct phase is useless if a dead task still claims `running`) and to Group O's
`task_summary` projection.

**How we'll know it's done.** *Unit:* driving a task through specify → plan → implement
writes each transition to `tasks` and `task_summary`; a loop-back to `implement` and a park
at `awaiting-human` both land in the row. *Manual:* run one task and poll `awb fleet --md`
— the PHASE and COND columns advance in step with `awb task show`, with no disagreement
between the two commands at any point.

### [x] TASK-124: `phase_attempts.ended_at` and `.outcome` are never written — per-phase duration and outcome are unreadable

**What's wrong.** All 190 `phase_attempts` rows in the local database have `ended_at =
NULL` and `outcome = NULL`. The row is inserted when a phase attempt starts and never
closed. `/api/tasks/:repositoryId/:taskId/execution-tree` therefore returns a tree in which
no phase has a duration and no phase has a result, which is the single most obvious thing to
ask of it after a run. The timing data does exist, but in a different table
(`runtime_attribution`, 121 rows, broken out by category: `modelGenerationMs`,
`testExecutionMs`, `qaExecutionMs`, `dependencyInstallMs`, `githubOperationMs`), so a reader
must know to join a table the execution tree does not mention.

**What to do.** Close the `phase_attempts` row when the attempt finishes: write `ended_at`
and the `outcome` the completion evaluation produced (complete / repair / replan /
await-human / failed). Write it on the failure and throw paths too, not only the happy path
— a phase that dies is exactly the one a reader wants a timestamp for. Then join
`runtime_attribution` into the execution-tree response for each attempt, so one call answers
"which phase took the time, and inside that phase was it the model, the tests, or the QA".

**Where.** `packages/database/src/data-access/observability.ts:33,118`
(`persistPhaseObservability`, `listPhaseAttempts`),
`workers/temporal-worker/src/activities/run-phase.ts` (the attempt exit paths, including the
catch), `apps/daemon/src/routes/tasks.ts` (execution-tree assembly). Relates to TASK-125
(same defect one level down) and TASK-128 (the CLI that prints this).

**How we'll know it's done.** *Unit:* a completed phase attempt has a non-null `ended_at`
after the phase; a phase attempt that throws also has a non-null `ended_at` and a failure
`outcome`. *Manual:* run one task, call the execution-tree endpoint, and every phase attempt
shows a real duration, a real outcome, and its runtime-attribution breakdown.

**What was done.** `drivePhase` (`phase-driver.ts`) now records the attempt start, wraps the
handler, and closes the attempt from a `finally` block, so both the normal and the throw path
write `ended_at`. The throw path writes `outcome: 'failed'` and re-throws. A new
`PhaseAttemptOutcomeSchema` (the six `PhaseAttemptResult` outcomes plus `failed`) and three
optional close fields on `PhaseObservabilitySchema` carry it; `persistPhaseObservability` writes
them onto the row and never pushes `started_at` forward on a re-persist. The execution tree joins
`runtime_attribution` and a computed `durationMs` per attempt. The attempt seam is
`phase-driver.ts`, so `run-phase.ts` needed no edit for this task.

**How we know it's done.** 5 driver tests prove the normal path posts the result outcome, the
throw path posts `failed` and re-throws, and a failed persist masks neither the result nor the
error. A live claude run closed `specify #1 await-human`, `specify #2 candidate`, `prepare #1
candidate` with real timestamps, and the execution-tree endpoint returned a `durationMs`, an
`outcome` and a `runtimeAttribution` block for every attempt.

### [x] TASK-125: `agent_sessions.ended_at` equals `started_at` — every agent session reports zero duration

**What's wrong.** All 92 `agent_sessions` rows have `ended_at` exactly equal to
`started_at`, so every session in the execution tree reports a zero-millisecond duration.
The same collapse shows on the `model_invocations` rows beneath them (`startedAt` equals
`endedAt`). The session end timestamp is being stamped at persist time rather than captured
when the session actually ended, so a 4-minute model session and a 2-second one are
indistinguishable. This makes the session layer of the execution tree decorative.

**What to do.** Capture the real session start and end from the adapter, and the real
per-invocation start and end from the usage stream, then persist those instead of a single
write-time timestamp. Where the underlying runtime genuinely does not report a per-invocation
end (some CLI adapters), persist `NULL` rather than a fabricated equal timestamp — an honest
gap beats a plausible-looking zero.

**Where.** `packages/database/src/data-access/observability.ts:33,128,138`,
`packages/agent-gateway` (the adapter/usage seam that reports session and invocation
boundaries), `workers/temporal-worker/src/activities/run-phase.ts` (where the session record
is assembled). Relates to TASK-124.

**How we'll know it's done.** *Unit:* a session whose adapter ran for a known interval
persists an `ended_at` that reflects that interval, not `started_at`; a runtime that reports
no end persists `NULL`. *Manual:* after a real run, session durations in the execution tree
differ from each other and sum to roughly their parent phase attempt's duration.

**What was done.** `recordSession` stamped one `new Date()` into `startedAt` AND `endedAt`, for
the session and its invocation — the whole defect. It now takes `startedAtMs` and derives the real
interval; the five call sites in `run-phase.ts` each pass the start constant they already measure
`runtimeMs` from (six added lines, no refactor, so the sibling branch rebases cleanly). The
synthesized `model_invocations` row now leaves `ended_at` **NULL**: no in-tree adapter reports a
per-invocation boundary (`AgentExecutionResult.usage` is documented as aggregate, and the Claude
adapter emits one `usage` event at the terminal `result` message), so an honest gap replaces the
fabricated equal timestamp.

**How we know it's done.** Persisted sessions of 8s / 54s / 72s / 5s read back with four distinct
durations, and the two implement sessions (54s + 72s = 126s) sum to roughly their parent attempt's
130s. Every `model_invocations.ended_at` reads NULL rather than equal to `started_at`.

### [ ] TASK-126: Phantom `running` tasks — nothing reconciles the database against whether the Workflow still exists

**What's wrong.** The local database holds 40 tasks that all claim `running`, with last
activity 17 to 36 days old. Their Temporal Workflows are long gone. Nothing ever reconciles
"the row says running" against "a Workflow is actually executing", so a crashed, terminated,
or history-purged task claims to be running forever. On a fleet view this is worse than a
wrong phase: it makes the monitoring surface unusable, because the reader cannot tell a live
task from a corpse. TASK-105's phase heartbeat proves liveness *inside* a running Activity;
it says nothing about a task whose Workflow no longer exists at all.

**What to do.** Add a reconciliation pass that compares each non-terminal task row against
the Workflow's real state, and marks the row terminal (`abandoned` / `lost`, distinct from
`failed`) when no Workflow backs it. Run it on daemon start and on a slow poll — the daemon
already runs a `reconcile()` tick for DAG scheduling, so extend that rather than adding a
second loop. Surface the result in `awb fleet` so an abandoned task reads as abandoned, not
as running. Provide a way to purge the existing 40 stale rows.

**Where.** `apps/daemon/src/scheduler.ts:135,153` (the existing reconcile tick),
`packages/database/src/data-access/fleet.ts`, `packages/database/src/data-access/tasks.ts:275`,
`packages/domain/src/task-status.ts:14` (the new terminal status),
`apps/cli/src/commands/fleet.ts`. Depends on TASK-123 landing first — reconciling a phase
that never advances is meaningless. Relates to TASK-111 (network partition wedges the stack).

**How we'll know it's done.** *Unit:* a task row whose Workflow is absent is marked
abandoned by the reconcile pass; a task whose Workflow is running is left untouched.
*Manual:* `awb fleet` on this machine shows zero tasks claiming `running` that have not moved
in weeks, and a task killed mid-run flips to abandoned within one reconcile interval.

### [ ] TASK-127: `awb up` exits nonzero on a worker/Temporal boot race

**What's wrong.** `awb up --quiet` returned exit 1 with the worker `unhealthy`, twice in a
row, on a machine where the stack was otherwise fine. Two distinct races: the worker
connects to Temporal before Temporal listens on 7233 and dies with `ConnectionRefused`
(observed in `awb logs worker`), and `up` gives up waiting before the worker finishes its
roughly 30-second webpack Workflow-bundle build. A `status` call a moment later reports
`ready`. Because `awb status --json` is documented as the health check that agents and CI
gate on, a boot that is merely slow is indistinguishable from a boot that failed.

**What to do.** Make `up` wait for Temporal to accept connections before it starts the
worker, and give the worker's readiness wait a budget that accommodates the bundle build.
Retry the worker's initial Temporal connection with backoff instead of dying on the first
`ConnectionRefused`. Keep `status` exiting nonzero when the runtime genuinely is not ready —
the contract is right, the boot sequencing is not. Also clear the stale-pid warning `doctor`
reports after a crashed worker.

**Where.** `apps/cli/src/commands/lifecycle.ts:175`, `apps/cli/src/services.ts:29`
(`RUNTIME_SERVICES` order), `apps/cli/src/health.ts:174`,
`workers/temporal-worker/src/index.ts` (the connect path). Relates to TASK-111.

**How we'll know it's done.** *Unit:* the worker retries a refused Temporal connection
rather than exiting. *Manual:* `awb down` then `awb up --quiet` exits 0 and the immediately
following `awb status --json` reports `ok: true`, repeated five times without a single
`unhealthy`.

### [x] TASK-128: No CLI surface for post-hoc observability — timing and token data are reachable only by hand-written HTTP calls

**What's wrong.** The durable observability is genuinely rich — per-phase runtime
attribution by category, token and USD cost by model, the phase-attempt → session →
invocation → context-composition tree — but the only way to read any of it is `curl` against
`/api/tasks/:repositoryId/:taskId` and `/execution-tree`. `awb task show` prints three lines
(phase, condition, gate). `awb task logs` printed `No recorded events for this task yet.` for
a task that has rows in `semantic_events`. With no frontend, the CLI is the only review
surface, and it does not expose the data.

**What to do.** Add a read-back command — `awb task timeline` (or a flag on `task show`) —
that prints, for one task: each phase attempt with its duration and outcome, the runtime
attribution split inside it, which QA ran and how long it took, the evidence and artifacts
produced, and the token/cost total. Honor the global output contract: `--json` for a stable
machine shape, plain text otherwise. Separately fix `awb task logs`, which fails to find
`semantic_events` rows that exist.

**Where.** `apps/cli/src/commands/task.ts` (`show`, `logs`, the new command),
`apps/daemon/src/routes/tasks.ts:291` (the payload already assembled there),
`packages/database/src/data-access/observability.ts:118,163,217,311`. Depends on TASK-124
and TASK-125 — the command is only worth writing once the durations are real. Relates to
TASK-121 (cross-task rollup, which sits above this).

**How we'll know it's done.** *Unit:* the command renders a task with phases, durations,
QA, evidence and tokens, and its `--json` output parses against a stable named-field shape.
*Manual:* after a real run, one command answers "which phase took longest, what QA ran, and
what did it cost" with no `curl` and no database query.

**What was done.** `awb task timeline` renders a new `GET /api/tasks/:repositoryId/:taskId/timeline`
route backed by `buildTaskTimeline`. The route is a pure SQLite read with no Temporal handle, so it
still answers for a task whose Workflow is closed or purged — which is the normal case for a
post-hoc question. It lives in its own `routes/timeline.ts`, so the shared `routes/tasks.ts` was not
touched. `--json` emits the stable named-field shape; plain text prints the phase table, the runtime
split, the QA rows, the evidence and artifact counts, and the token and cost total.

`awb task logs` had **two** defects, not one. It queried `/api/events?runId=<taskId>`, but
`semantic_events.run_id` is `<taskId>-run` (`runIdForTask`), so the query never matched — verified
directly: the bare id returns `{"events":[]}` where the suffixed id returns the rows. It also passed
`afterSequence=0`, and since `afterSequence` is EXCLUSIVE while sequences start at 0, it silently
dropped the first event of every run. Both are fixed and covered by tests.

**How we know it's done.** One command prints "Longest phase: implement #1 (2m10s)", the QA rows
that ran, and "Cost: $0.6513", with no `curl` and no SQL. `--json` parses to a stable shape
(`taskId`, `phases`, `totals`, `longestPhase`). `task logs` returns all four persisted events,
sequence 0 included.

## Group AA — Autonomy pivot: remove human approvals, loop to a draft PR (TOP PRIORITY)

The direction: the workbench stops being a human-in-the-loop system with an approval
queue and becomes a **true autonomous loop against falsifiable success criteria** whose
**terminal state is always a draft PR**. Merging is a human action taken **out-of-band on
GitHub**, not a phase the workbench parks on. "Is the work correct" is the workbench's job
(deterministic, looped); "do we want to merge it" is the human's job (on the PR). This
removes every human gate, deletes the `/approvals` surface, and makes non-convergence
open a draft PR with an honest unmet-criteria report rather than parking a queue.

**Decisions locked (do not re-litigate):**
- Remove **all** human gates — repo-trust becomes a one-time config flag, not a per-run
  gate; task-contract-approval and pr-readiness are removed. Fully autonomous prompt → draft PR.
- Non-convergence (budget exhausted, repeated-failure-no-progress, qa-inconclusive,
  planner-critic-non-convergence) → **open a draft PR anyway**, clearly marking the unmet
  success criteria in the PR body/checklist. Every task terminates at a draft PR.
- Success criteria = **falsifiable acceptance claims proven by real evidence**: tests pass
  AND interactive QA (click + assert) exercises each behavioral claim AND adversarial
  review has no blocking findings. Interactive QA was the hard dependency here. It
  **shipped** (TASK-90, PR #34): `buildInteractiveScenarioSteps` in `packages/qa` drives
  click + assert steps from the plan's `expectedAssertions`, and
  `buildExerciseScenarioSteps` (`run-phase.ts:343`) scores an all-liveness scenario `weak`
  so it cannot cover a behavior claim. This dependency is met — do not rebuild it.

### [ ] TASK-104: Remove all human gates — repo-trust becomes one-time config, contract-approval and pr-readiness deleted

**What's wrong.** The lifecycle has three mandatory human gates
(`MANDATORY_GATE_REASONS`, `packages/policy/src/human-gates.ts:73-77`:
`first-time-repository-trust`, `task-contract-approval`, `pr-readiness`) plus a long list
of conditional/blocking gate reasons (`HumanGateReasonSchema`,
`packages/domain/src/lifecycle.ts:65-84`). The workflow escalates to `awaiting-human` and
parks (`packages/workflow/src/task-workflow.ts:196,256-274`); the release handler returns a
`pr-readiness` gate as its terminal step (`run-phase.ts:1598,1747`). This makes every task
depend on a human sitting in an approval queue — the exact model we are removing.

**What to do.** Strip human approval from the critical path end to end:
- **Repo-trust → one-time config flag.** Move `first-time-repository-trust` out of the
  per-run gate machinery into a persisted `repository.trusted` boolean set once at
  registration (`awb repo add --trust` / `awb repo trust`); no runtime gate, no per-task
  prompt. A non-trusted repo is simply refused up front, not parked mid-run.
- **Delete `task-contract-approval` as a gate.** The specify phase still produces the
  contract (it is the source of the success criteria), but the workflow no longer waits for
  a human to approve it — it advances straight to plan once the contract is well-formed.
- **Delete `pr-readiness` as a gate.** The release phase opens the draft PR as its terminal
  action (see TASK-106) instead of parking for human PR approval.
- Remove `pending_gate_reason`/`awaiting-human` from the *happy path*. Keep the
  `HumanGateReason` enum values only insofar as TASK-105 repurposes them as
  unmet-criteria labels in the PR report; nothing should route to `awaiting-human` as a
  wait state.

**Where.** `packages/policy/src/human-gates.ts` (drop `MANDATORY_GATE_REASONS`, the
escalation predicates), `packages/domain/src/lifecycle.ts:65-84` (prune the enum to what
TASK-105 still uses), `packages/workflow/src/task-workflow.ts:105,196,256-274`
(remove `awaiting-human` escalation + `pr-readiness` on release),
`packages/workflow/src/loop-routing.ts:68` (`shouldEscalateToHuman`),
`workers/temporal-worker/src/activities/run-phase.ts:1598,1747` (release no longer returns
a `pr-readiness` gate), plus repo-trust plumbing in `packages/repository` +
`apps/cli`. Depends on TASK-106 (draft-PR terminal) landing together so release has
somewhere to go. Relates to `docs/security.md` (repo-trust is still the security boundary —
it becomes config, not un-enforced).

**How we'll know it's done.** *Unit:* a routine task advances specify→plan→…→release with
**zero** `awaiting-human` transitions; a non-trusted repo is refused at registration, not
mid-run. *Manual:* drive a task on a trusted local repo with `--no-input` and it reaches a
draft PR without a single approval prompt.

### [ ] TASK-105: Bounded autonomous loop against falsifiable success criteria (replaces human parking on non-convergence)

**What's wrong.** Today, when the loop can't satisfy criteria it escalates to a human gate:
`repeated-failure-no-progress` at `NO_PROGRESS_THRESHOLD = 3`
(`task-workflow.ts:256-259`), `qa-inconclusive`, `budget-exceeded`,
`planner-critic-non-convergence`. That is a *park-and-wait-for-human* model. In the new
model the loop is bounded and **terminal without a human**: it runs until the success
criteria are met OR a budget (attempts / tokens / wall-clock) is exhausted, then hands off
to the draft-PR terminal (TASK-106) — it never waits in an approval queue.

**What to do.** Define an explicit loop budget and a structured terminal outcome:
- A `LoopBudget` (max phase attempts per phase, max total tokens, max wall-clock) checked in
  the workflow; when a repair/replan cycle would exceed it, stop looping.
- Replace each `awaiting-human` escalation with a **terminal** `UnmetCriteria` outcome
  carrying: which acceptance claims are unproven, the last candidate SHA, the blocking
  findings, and *why* the loop stopped (converged-unmet vs. budget-exhausted vs.
  genuinely-stuck fingerprint). This structured object is what TASK-106 renders into the PR
  body.
- Wire the richer `failure-fingerprint.ts` machinery (currently unwired per TASK-75's note)
  into the stop decision so "genuinely stuck" is distinguished from "made partial progress."
- Success = all falsifiable acceptance claims proven by real evidence (tests pass +
  interactive QA exercises each behavioral claim + no blocking review findings). This is the
  exit condition. Interactive QA already shipped (TASK-90), so it is available to use.

**Where.** `packages/workflow/src/task-workflow.ts:70,251-274` (budget check + terminal
outcome instead of `awaiting-human`), `packages/workflow/src/loop-routing.ts`,
`packages/workflow/src/failure-fingerprint.ts:44-60` (wire it in),
`packages/workflow/src/evaluate-completion.ts` (the success predicate stays the arbiter),
new `LoopBudget`/`UnmetCriteria` types in `packages/domain`. Pairs with TASK-104/106.
Interactive QA (the real success signal) already shipped. Relates to the
`qa-static-checks-miss-runtime-bugs` learning.

**How we'll know it's done.** *Unit:* a task that cannot satisfy a claim within budget
terminates with a populated `UnmetCriteria` (claims + SHA + findings + stop-reason) and
**never** enters `awaiting-human`; a task that satisfies all claims terminates `succeeded`.
*Manual:* drive an intentionally-unsatisfiable task and confirm it stops at the budget and
produces the unmet-criteria object, not a parked gate.

### [ ] TASK-106: Draft PR is the terminal state for EVERY task — with an honest met/unmet success-criteria report in the body

**What's wrong.** Release today parks on a `pr-readiness` human gate
(`run-phase.ts:1598,1747`) rather than treating the draft PR as the finish line. There is
no PR-body report of which success criteria were met vs. unmet. In the new model, **every**
task — converged or not — ends by opening (or updating) a draft PR whose body honestly
states the acceptance-claim outcomes, so a human reviews and merges on GitHub out-of-band.

**What to do.**
- Make the release phase open a **draft** PR as its terminal action, unconditionally (no
  `pr-readiness` gate). On success, all claims are marked proven; on non-convergence
  (TASK-105 `UnmetCriteria`), open the draft PR anyway with the unmet claims called out.
- Render a **success-criteria checklist** into the PR body: each acceptance claim → met /
  unmet, the evidence link (recording/trace/test result) for met claims, and the reason +
  last candidate SHA for unmet ones. Reuse the existing PR evidence-matrix machinery
  (`packages/github`) rather than inventing a second renderer.
- The draft stays a draft — the workbench **never** marks it ready or merges it. (That is
  the human's out-of-band action; note the existing `close-pr` skill already does
  ready+merge as a *separate* human-invoked step, which is exactly the intended boundary.)

**Where.** `workers/temporal-worker/src/activities/run-phase.ts:1541-1598,1743-1747` (release
terminal → draft PR, drop the `pr-readiness` return), `packages/github` (PR body =
evidence matrix + met/unmet checklist; the draft-PR + evidence-matrix code already exists),
consumes TASK-105's `UnmetCriteria`. Depends on TASK-104 (gate removal) and TASK-105
(terminal outcome). Relates to the `github-pr-video-upload` and `close-pr` learnings and
TASK-71 (no-origin → local delivery still applies when there is no remote to PR against).

**How we'll know it's done.** *Unit:* release always produces a draft PR (never a
`pr-readiness` gate); the PR body contains a per-claim met/unmet checklist sourced from
evidence. *Manual:* drive one converged and one intentionally-unsatisfiable task; both end
as draft PRs, the first with all claims met + evidence links, the second with the unmet
claims and reasons clearly listed — neither is auto-merged.

### [ ] TASK-107: Delete the `/approvals` control-plane surface and its supporting queue concept

**What's wrong.** The current UI has an `/approvals` surface (a stub cross-task gate lookup)
that the autonomy pivot makes obsolete — there is no human approval queue any more.
`/approvals`, `GatePanel`, the sidebar approvals badge, and any pending-gate projection are
now dead concepts. (A prior backlog item, TASK-82, planned to *expand* this into a real
approval inbox; that item has been **deleted** from this backlog as a direct consequence of
the pivot — do not resurrect it.)

**What to do.** Remove the `/approvals` route and page, `GatePanel`, and the approvals
sidebar entry + badge. If any "needs attention" surface remains useful, it becomes a
**read-only** list of tasks that ended `UnmetCriteria` (linking to their draft PRs), not an
actionable approval queue. This is primarily a deletion; it is listed here (not just in
Group O) because it is a direct consequence of TASK-104.

**Where.** `apps/web/src/pages/ApprovalsPage.tsx`, `GatePanel.tsx`,
`apps/web/src/components/layout/AppSidebar.tsx` (drop Approvals), `apps/web/src/App.tsx`
(drop `/approvals`). Depends on TASK-104. Note: this is a frontend deletion — the backend
gate removal is TASK-104.

**How we'll know it's done.** *Manual:* there is no `/approvals` route, no approvals sidebar
entry, and no code path that lists "pending human gates."


## Group AB — Runtime resilience (backend, high priority)

The three original observability gaps in this group shipped. One task remains, and it is a
resilience defect rather than an observability one.

> **Reference — where observability actually lives.** The workbench has a real three-channel
> design (semantic_events + per-session token/runtime tables + OTel), per ADR-008. No package
> is named `packages/observability/`. The code lives in `packages/telemetry`,
> `packages/database` (`schema/observability.ts` + `data-access/observability.ts` +
> `schema/sessions.ts`), and
> `workers/temporal-worker/src/activities/observability-accumulator.ts`. Use those paths.

### [ ] TASK-111: A network partition wedges the whole stack and corrupts the daemon write path — no clean recovery

**What's wrong (observed live 2026-08-17→18).** A WiFi/router outage mid-run left the stack
in a degraded state from which neither the stack nor the in-flight tasks recovered cleanly,
surfacing several distinct defects:

1. **Worker stops polling after a network partition and never resumes on its own.** The
   Claude agent SDK activities failed with `API Error: Connection closed mid-response`
   (durationMs ~14.8 min — they hung on the dead socket until the activity neared timeout).
   After the failures the temporal-worker went **idle for ~3 h** — Temporal task-queue
   backlog was 0 and pollers looked alive, but no workflow tasks were being executed. Only an
   explicit `awb restart worker` got it polling again.
2. **`awb restart worker` is not sufficient.** After the worker restart, the workflow layer
   accepted human-gate updates (Temporal recorded `WorkflowExecutionUpdateAccepted` +
   `...UpdateCompleted` for `approve-contract`) but tasks **did not advance past `specify`**,
   and the daemon `POST /api/tasks/:r/:t/approve-contract` returned `{"ok":true}` while having
   no effect — the approval was a no-op from the operator's point of view.
3. **A stale daemon from a DIFFERENT worktree crash-looped on port 4417.** `daemon.log` showed
   ~70 repeated `daemon listening on http://127.0.0.1:4417` lines interleaved with
   `EADDRINUSE` from `.../LOCAL_worktrees/agent-workbench/timothyshee-group-b-planning/apps/daemon`
   running `tsx watch` — i.e. an old worktree's dev-mode daemon was fighting the MAIN daemon
   for the port. Nothing detects or refuses a second daemon binding the same port.
4. **The worker→daemon→SQLite persistence path silently drops writes when degraded.** After the
   partition, the Temporal workflow history advanced (activities completing post-approval) but
   SQLite stayed frozen at the pre-approval snapshot: `phase_attempts` still `specify|1|open`,
   `semantic_events` maxseq still 0, `task_contracts.status` stuck at `awaiting_approval`. So
   **SQLite could not be trusted as ground truth** and the CLI/`task show` reported stale or
   empty state — while Temporal was the only accurate source.
5. **Temporal retries cold-restart the agent turn (no resume).** The interrupted implement/verify
   turns re-explored from scratch on retry and, combined with the 3-strike counter, several tasks
   parked at `repeated-failure-no-progress` purely because of the outage, not bad code — even
   though real work sat committed/uncommitted in their worktrees. (Re-confirms the standing
   `observability-live-proof` / TASK-32 cold-restart gap.)

**What to do.** Make a network partition survivable and recovery legible:
- The worker should **detect a dropped/again-available connection and resume polling** without a
  manual `restart` (health-check + backoff reconnect), and a transport-drop failure (`Connection
  closed mid-response`) should **fail fast** instead of hanging ~15 min on the dead socket.
- **Refuse to boot / warn when the configured port is already held by another daemon** (esp. a
  stale `tsx watch` daemon from a different worktree) rather than crash-looping on `EADDRINUSE`.
- Make the **persistence path resilient**: either buffer+retry the worker→daemon→SQLite writes
  across a daemon restart, or on daemon recovery **reconcile SQLite from Temporal history** so the
  DB is not left permanently behind the workflow. A `{"ok":true}` from `approve-contract` must mean
  the workflow actually consumed it (verify the update landed, don't ack optimistically).
- Provide a **recovery command** (`awb reconcile` / `awb doctor --repair`) that, after a partition,
  re-syncs durable state from Temporal and surfaces which tasks are genuinely stuck vs. merely
  behind — instead of leaving the operator to read Temporal history by hand.
- Ties to the autonomy pivot (Group AA): a partition should degrade toward the bounded loop /
  draft-PR terminal, not a silent wedge.

**Where.** `workers/temporal-worker/src/` (worker lifecycle + activity transport-drop handling +
heartbeat/reconnect), `apps/cli/src/commands/lifecycle.ts` (port-in-use detection on `up`;
`restart` semantics), the worker→daemon write path (`apps/daemon/src/routes/internal.ts` +
`observability-accumulator.ts` + run-lifecycle persistence), a new reconcile-from-Temporal path.
Relates to `observability-live-proof` (cold-restart-on-retry), `boot-stale-dist-symlink`,
`awb-worktree-multistack-blockers` (port collisions across worktrees), and TASK-104/105 (verify
timeout/heartbeat).

**How we'll know it's done.** *Manual:* kill the network mid-run, restore it, and the stack
resumes executing tasks with no manual `restart` and no permanently-behind SQLite; a second daemon
on the same port is refused with a clear message, not a crash-loop; and after a forced partition
`awb reconcile` (or equivalent) brings SQLite back in line with Temporal and correctly labels each
task's real state.


## Group J — QA without a start command

### [ ] TASK-73: `exercise` hard-fails (`exit 1`) when nothing resolves to a serving command — no non-browser / serve-as-is QA fallback

**What's wrong.** When `AWB_QA_MODE=browser` and no resolved command has
`serves: true` — a truly static frontend with no recognized app server, or nothing
resolvable — the `exercise` handler falls through every branch to a deliberate
hard-fail (`sh -c 'echo …; exit 1'`), so the run dead-ends despite the code being
complete and verified. Two structural gaps: (1) QA mode is chosen **purely** by the
`AWB_QA_MODE` env var and is never inferred from repo shape or from a `serves:false`
result — nothing routes a `serves:false`/static-frontend repo into the existing
`http-api` or `library` QA branches, or into a "serve the app and drive it" path;
(2) `serves:false` commands are captured but their non-browser QA consumer was never
wired (`run-command.ts:26-28`, `command-support.ts:143-145` explicitly say "for a
future consumer"). A missing dev server therefore means "can't QA."

> **Note — half of the original ticket is already done.** The "re-resolve the start
> command post-implement instead of only from the initial empty snapshot" fix
> exists on main: `resolveStartCommandForWorktree`
> (`command-support.ts:166-185`, tiered persisted-row → `discoverCommands` →
> `resolveRunCommand`) is called against the live worktree at
> `run-phase.ts:1060-1067`. A repo that *gains* a start script after implement is
> already found, and a detected FastAPI/Django/Flask entry resolves to a
> `serves:true` command (`run-command.ts:153-171`) that already drives browser QA
> against the app-served frontend. The remaining dead-end is narrow: only when
> **nothing** resolves to `serves:true`.

**What to do.** Wire the non-browser / serve-as-is fallback. When browser QA is
requested but no `serves:true` command resolves: either (a) auto-select a suitable
non-browser QA mode (`http-api`/`library`) from repo shape / the `serves:false`
result instead of requiring the operator to set `AWB_QA_MODE`, or (b) launch the
app's own server and drive it, or (c) degrade to a defined non-browser QA — anything
other than the `exit 1` hard-fail. Route `serves:false` results to the captured-but-
unconsumed consumer the code comments already anticipate.

**Where.** `workers/temporal-worker/src/activities/run-phase.ts` — the QA-mode
selection at `:1056`, the browser branch gated on `serves===true` at `:1069-1072`,
the `http-api`/`library` branches at `:1090`/`:1102`, and the hard-fail at
`:1113-1132`; the captured-`serves:false` note at
`packages/repository/src/run-command.ts:26-28` and
`workers/temporal-worker/src/activities/command-support.ts:143-145`. Relates to
TASK-65/66 (done) and the `qa-cold-reentry-nonconvergence` learning.

**How we'll know it's done.** *Unit:* the QA-mode selector, given a `serves:false`
resolution (or no serving command) under `AWB_QA_MODE=browser`, selects a
non-browser fallback instead of the `exit 1` path. *Manual:* re-drive a truly static
frontend (no recognized app server) and confirm `exercise` QAs it some way and
reaches pr-readiness instead of dead-ending.


## Group M — Local-model driving & dogfooding

### [~] TASK-77: Dogfood the workbench on *this* repo (agent-workbench itself)

**What's wrong.** We dogfood on `browser-games` / `fender` / `app` but have never
driven a task against *this* repo — the most honest test of whether the tool is
pleasant to use on a real TS monorepo.

**What to do.** Register `agent-workbench` as a repo and drive one small, real,
self-contained task (e.g. one of the smaller fixes above) end to end,
interactively, stopping at the pr-readiness gate. Capture friction as new TODO
items here.

**Where.** Operational — uses the `run-workbench-task` skill; no code target.
Relates to the `run-workbench-task` skill, whose `target=this-repo` route covers
changing this repo with this repo.

**How we'll know it's done.** A branch + draft PR on this repo produced by the
workbench, with a short writeup of what was awkward.

> **Partial dogfood run (2026-08-15).** Registered `agent-workbench` and drove a
> task (re-tighten TASK-78's worktree-dir tests). Discovery, contract, plan,
> prepare, and **implement all succeeded on the real repo** — the agent correctly
> recognized TASK-78 was already implemented on `main` and produced a genuinely
> good test-only diff (+9 `branch.test.ts`, +24 `worktree.test.ts`, real
> `createWorktree` slug-path assertion). Then it **stalled at `verify`** (see
> TASK-104/105/106 below). Friction captured as new tickets. Not yet a delivered PR
> because verify never converged — reopen once TASK-104 lands.

## Group R — Investigate / research (external references)

The external-reference review (TASK-100) shipped. Its writeup is at
`docs/research/external-references-2026-08.md`. The review declined most references and
spun out the build tasks below. Everything else was `decline` or `reference-only`, because
an existing invariant, task or learning already covered it, or because it conflicted with
no-vector-DB / SQLite-single-writer / no-subagent / read-only-board.

### [ ] TASK-116: Define a promotion/eviction policy for project memory (markdown files grow unboundedly, no lifecycle)

**What's wrong today.** Project memory (`project-memory-design`) is one append-only
markdown file per project, written at closeout. There is no rule for when a fact
graduates from session-scoped context into persisted project memory, and no eviction rule
— the file only ever grows, so stale/superseded facts accumulate forever.

**What the external technology does.** **Memory-OS** — 6-layer memory (short-term →
mid-term → long-term) built on Hermes, with explicit promotion/eviction between layers:
`https://www.marktechpost.com/2026/06/01/meet-memory-os-a-memory-operating-system-for-ai-agents-that-cuts-gpt-4o-mini-cost-and-boosts-accuracy/`.
**autoagent** (`https://github.com/hkuds/autoagent`) maintains a fine-grained, typed
memory graph automatically rather than only at explicit save points.

**What to do.** Define (in `docs/decisions/` or alongside `project-memory-design`)
explicit promotion criteria (what makes a fact worth writing to project memory) and an
eviction rule (when an entry is stale enough to remove or supersede — e.g. superseded by a
later entry on the same topic, or contradicted by current repo state). This **extends**
ADR-009, it does not reopen it: still markdown, still repo-is-truth, no `AgentMemory`
store, no memory graph/vector store (decline the graph-store and vector parts of both
references — steal only the lifecycle idea).

**Where.** `docs/decisions/ADR-009*.md` and wherever `project-memory-design` is
documented; the closeout skill that writes project memory. Relates to TASK-117 (may fold
together).

**How we'll know it's done.** A documented promotion/eviction rule exists, and the
closeout skill applies it (an old, superseded memory entry gets marked/removed rather than
accumulating forever).

### [ ] TASK-117: Auto-capture high-signal repo facts on first touch, not only at closeout

**What's wrong today.** Project memory is only written at session closeout. If a session
ends without an explicit closeout (crash, park, cold re-entry), high-signal facts learned
mid-run are lost — contributing to the cold-re-entry non-convergence already noted in
`qa-cold-reentry-nonconvergence`.

**What the external technology does.** The **auto-memory** writeup
(`https://share.google/oXjo34ahE29NMPYaE`, "I wasted 68 min/day re-explaining my code")
auto-captures repo facts as they're discovered, not only at an explicit save point —
directly addressing the same "re-explain everything every session" pain this task fixes.

**What to do.** Identify a bounded set of high-signal moments (e.g. discovering a repo
convention, hitting a non-obvious blocker) where memory should be written immediately
rather than deferred to closeout. Likely folds into TASK-116's promotion policy rather
than being separate — triage together.

**Where.** Same surface as TASK-116 (project-memory write path). Relates to
`qa-cold-reentry-nonconvergence`.

**How we'll know it's done.** A mid-run fact survives a session that ends without a clean
closeout (verified by killing a session mid-task and checking memory was still written).

### [ ] TASK-118: Evaluate markitdown as the context-ingestion converter (PDF/docx/pptx → md), replacing ad-hoc pdfminer

**What's wrong today.** Context ingestion for non-markdown documents is ad hoc — the
Karpathy PDF was converted via pdfminer as a one-off (`group-e-token-memory-graph`), not
through a reusable converter. Every new document format would need its own bespoke script.

**What the external technology does.** **markitdown**
(`https://github.com/microsoft/markitdown`) is a general-purpose PDF/docx/pptx/office/asset
→ Markdown converter maintained by Microsoft, covering exactly this class of conversion
with one dependency instead of per-format scripts.

**What to do.** Evaluate `markitdown` as the standard context-ingestion converter in place
of one-off scripts. Bounded evaluation: does it handle the formats we've actually needed,
and is it worth the dependency. No invariant conflict — it's a converter, not a store.

**Where.** Wherever ad-hoc document-to-context conversion currently happens (context
ingestion / memory tooling).

**How we'll know it's done.** *Manual:* re-run the Karpathy-PDF-style conversion through
markitdown and confirm output quality is equal or better than the pdfminer one-off; decide
adopt or decline.

### [ ] TASK-119: Test whether a `design.md`-style structured design spec improves from-scratch UI output (flag on TASK-99)

**What's wrong today.** TASK-99's `build-ui` skill has no structured design-spec input —
it relies on prompt guidance alone, with no tokens/layout/light-dark spec file feeding
generation.

**What the external technology does.** The **design.md** pattern
(`https://github.com/google-labs-code/design.md` and
`https://getdesign.md/linear.app/design-md`) is a structured spec file (design tokens,
layout rules, light/dark rules) that conditions UI generation, used to reproduce
recognizable design systems (e.g. the linked Linear-app example) from a spec rather than
prose alone.

**What to do.** As part of (or immediately following) TASK-99, run a bounded experiment:
build the same from-scratch UI once with the current skill prompt and once with a
`design.md`-style spec feeding it, and compare coherence (tokens, light/dark, responsive)
without hand-holding. Adopt the pattern into `build-ui` only if the experiment shows a real
difference.

**Where.** `.claude/skills/build-ui/` (TASK-99). Not a standalone deliverable — a flagged
experiment on that task.

**How we'll know it's done.** A short before/after comparison exists and TASK-99's skill
either adopts or explicitly declines the `design.md` input based on it.

### [ ] TASK-120: Persisted per-run agent scratchpad/TODO to reduce cold re-entry

**What's wrong today.** Long runs have no persisted scratchpad — only plan artifacts. On
cold re-entry (park/resume), the agent has to reconstruct working state from the plan
artifact rather than a running TODO/scratchpad, contributing to the non-convergence pattern
in `qa-cold-reentry-nonconvergence`.

**What the external technology does.** **deep-agents-from-scratch**
(`https://github.com/langchain-ai/deep-agents-from-scratch`) teaches planning + sub-task
decomposition backed by an explicit agent-maintained scratchpad / virtual filesystem for
in-progress state, separate from the plan itself. (Decline its subagent framing — we
already have the stacked-PR DAG for decomposition (`run-workbench-task` →
`references/decompose.md`)/TASK-51; the
bounded steal is just the scratchpad idea.)

**What to do.** Add a persisted per-run scratchpad file (plain markdown/text, not a new
store) that the agent updates as it works and that is loaded back in on resume, distinct
from the plan artifact. Bounded: no subagent framing, no new database table.

**Where.** Wherever plan artifacts are currently produced/loaded on resume
(`produceStageArtifactResuming` per `artifact-dedup-per-stage-run`). Relates to
`qa-cold-reentry-nonconvergence`.

**How we'll know it's done.** *Manual:* park a long-running task mid-phase, resume it, and
confirm the resumed session picks up the scratchpad instead of cold-re-deriving state.

### [ ] TASK-121: Batch/factory rollup view over `task_summary` (cross-task, not per-task)

**What's wrong today.** `task_summary` (per `ui-roadmap-phase0-progress`) gives per-task
rollups, but there's no cross-task view summarizing what a batch of tasks (e.g. one
dogfooding run across N tickets) produced — an operator has to open each task individually.

**What the external technology does.** The **"Build a software factory with Claude
Code"** writeup
(`https://www.freecodecamp.org/news/how-to-build-software-factory-with-claude-code/`)
frames its pipeline around an explicit factory run-report: one rollup summarizing what a
whole batch of tasks produced.

**What to do.** Add a low-priority rollup view (CLI output or a UI page) that aggregates
`task_summary` across a set of tasks run together — counts by terminal state, PRs opened,
unmet-criteria tasks — rather than requiring per-task drill-in.

**Where.** Builds on the `task_summary` projection (Group O UI work / `apps/web`, or `awb`
CLI). Low priority.

**How we'll know it's done.** *Manual:* after driving several tasks, one command/page shows
the batch rollup (opened PRs, unmet-criteria count) without opening each task individually.

### [ ] TASK-122: OS-level sandbox for untrusted repos (deferred — only if the `native-trusted` model changes)

**What's wrong today.** Execution is confined by the capability broker + worktree
isolation, which is explicitly `native-trusted` — **not** a hostile-code sandbox
(documented gap in `AGENTS.md`, `monitor-tool-escapes-readonly-deny`). There is currently
no OS-level isolation boundary if the workbench ever needed to run an untrusted repo.

**What the external technology does.** **Sandcastle** provides OS-level sandboxing /
isolation for running untrusted code, which is the mitigation this gap would need if the
trust model changes.

**What to do.** Nothing now. If/when the workbench needs to run untrusted repos, use
Sandcastle's isolation-boundary model as the design reference for OS-level sandboxing.
Deferred — not needed under the current `native-trusted` model.

**Where.** N/A until triggered. Relates to `AGENTS.md` known-gaps and
`monitor-tool-escapes-readonly-deny`.

**How we'll know it's done.** N/A — this stays deferred until the trust model changes;
re-triage at that point rather than building speculatively.
