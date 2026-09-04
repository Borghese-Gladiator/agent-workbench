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

### [ ] TASK-124: `phase_attempts.ended_at` and `.outcome` are never written — per-phase duration and outcome are unreadable

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

### [ ] TASK-125: `agent_sessions.ended_at` equals `started_at` — every agent session reports zero duration

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

### [ ] TASK-128: No CLI surface for post-hoc observability — timing and token data are reachable only by hand-written HTTP calls

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
  review has no blocking findings. TASK-90 (interactive QA) is therefore a **hard
  dependency** — without it the loop "succeeds" on shallow navigate+screenshot evidence.

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
  interactive QA per TASK-90 exercises each behavioral claim + no blocking review findings).
  This is the exit condition; TASK-90 is a hard dependency.

**Where.** `packages/workflow/src/task-workflow.ts:70,251-274` (budget check + terminal
outcome instead of `awaiting-human`), `packages/workflow/src/loop-routing.ts`,
`packages/workflow/src/failure-fingerprint.ts:44-60` (wire it in),
`packages/workflow/src/evaluate-completion.ts` (the success predicate stays the arbiter),
new `LoopBudget`/`UnmetCriteria` types in `packages/domain`. Depends on TASK-90 (interactive
QA as the real success signal) and pairs with TASK-104/106. Relates to TASK-75 and the
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


## Group AB — Observability gaps (backend, high priority)

Three real, verified backend gaps in the observability layer. (Two other findings — the web
client dropping `runtimeAttribution`, and telemetry being off-by-default — are deliberately
**out of scope here**: the first is frontend, the second is intentional and documented.)

> **Correction to an earlier audit claim:** the workbench **does** have observability — a
> real three-channel design (semantic_events + per-session token/runtime tables + OTel),
> per ADR-008. What does **not** exist is a package literally named `packages/observability/`
> (verified: no such directory, no such workspace package among the 23). The functionality
> lives in `packages/telemetry`, `packages/database` (`schema/observability.ts` +
> `data-access/observability.ts` + `schema/sessions.ts`), and
> `workers/temporal-worker/src/activities/observability-accumulator.ts`. Several backlog
> items (TASK-61/79/89/98) once cited `packages/observability/`; that path was wrong and has
> been corrected — see TASK-108 (done).

### [x] TASK-108: Backlog + docs cited a nonexistent `packages/observability/` — path drift fixed

**What was wrong.** TASK-61, TASK-79, TASK-89, and TASK-98 pointed their "Where" at a package
literally named `packages/observability/`, which does not exist (verified: no directory of that
name outside `archive/`, not among the workspace packages). Anyone picking up those tasks started
in the wrong place. The real homes are `packages/telemetry` (OTel) and `packages/database`
(`data-access/observability.ts`, `schema/observability.ts`, `schema/sessions.ts`) plus
`workers/temporal-worker/src/activities/observability-accumulator.ts`.

**What was done.** Repointed the four tasks' "Where" fields at the real packages and rewrote the
`@awb/observability` removed-package note in `docs/dependencies.md` to name those homes. The only
surviving `packages/observability` string in `docs/` is this note itself, which exists to explain
the historical drift.

**How we know it's done.** `rg 'packages/observability' docs/` returns only this task's own note,
and each corrected task names the real package.

### [x] TASK-109: `context_composition` is a chars/4 ESTIMATE, not measured tokens — the token-attribution surface is synthetic

**What's wrong.** The "8 token-source buckets" (`context_composition`) that the token-audit
work (TASK-79) and any future Usage view read from are **not measured** — they are computed
by `estimateContextComposition` as `Math.ceil(JSON.stringify(payload).length / 4)` per
bucket (`workers/temporal-worker/src/activities/observability-accumulator.ts:138-150`). This
is a character-count heuristic that (a) never reconciles against the model's actually
reported `inputTokens` in `model_invocations`, (b) is badly wrong for code/JSON/non-English,
and (c) **cannot see the thing the token-cost finding says dominates cost** — accumulated
in-session context and replayed tool output — because it only measures the payloads the
workbench hands in, not what the transcript actually grew to. So ranking prompts/phases by
this number (the whole point of TASK-79) would rank a synthetic quantity.

**What to do.** Make context attribution real, or clearly demote it:
- Reconcile the buckets against the provider-reported input tokens (`model_invocations`):
  the buckets should **sum to** the measured input tokens for that invocation (scale/attribute
  the measured total across sources), not be an independent chars/4 guess.
- Where the provider exposes cache-read vs. fresh-input (already read back as
  `cachedInputTokens`), attribute those separately so "context we paid to re-send" is visible
  — that is the cost lever `group-e-token-memory-graph` names.
- If a source genuinely can't be measured, label the field `*_estimated` so downstream
  (TASK-79, any Usage view) never presents it as measured. Do **not** let an estimate masquerade
  as attribution.

**Where.** `workers/temporal-worker/src/activities/observability-accumulator.ts:138-150`
(`estimateContextComposition`), the `context_composition` schema
(`packages/database/src/schema/observability.ts`) and read path
(`data-access/observability.ts:getTokenBreakdown`), reconciled against `model_invocations`
usage. Hard input to TASK-79 (measure before cutting). Relates to
`group-e-token-memory-graph` and `docs/token-cost-measurement.md`.

**How we'll know it's done.** *Unit:* for a real invocation, the `context_composition`
buckets sum to (within a small rounding tolerance) the provider-reported input tokens in
`model_invocations`, not to a chars/4 count; any unmeasurable field is suffixed `_estimated`.
*Manual:* TASK-79's per-phase ranking is driven by reconciled tokens, and cache-read vs.
fresh-input is distinguishable.

### [x] TASK-110: The structured logger (`createLogger`) is defined but has ZERO consumers — wired it

**What's wrong.** `docs/observability.md` presents a third OTel sub-channel — *"a leveled,
structured logger (`createLogger`) stamped with run_id/task_id, replacing raw stdout
diagnostics."* In reality `createLogger` is imported **nowhere** outside its own package
(verified: zero non-test consumers across `apps/`, `workers/`, `packages/`). Diagnostics
still come from raw process stdout (`awb logs <service>`), exactly as the doc's own "kept
honest" box admits at the bottom — but the taxonomy section sells the logger as an active
channel. The code and the doc disagree.

**What to do.** Decide and make it true:
- **Wire it** — replace the raw `console.*`/stdout diagnostics in the worker and daemon hot
  paths with `createLogger` stamped with `run_id`/`task_id`, so app logs are structured and
  correlatable (the stated design), **or**
- **Delete it** — remove `createLogger` and correct `docs/observability.md` to stop claiming
  a structured-log channel that doesn't run.
- Prefer wiring (it is genuinely useful for the transport-drop debugging case the doc
  describes), but either outcome ends the code/doc mismatch.

**Where.** `packages/telemetry/src/logger.ts` (`createLogger`), the worker/daemon
diagnostic call sites (`workers/temporal-worker/src/`, `apps/daemon/src/`),
`docs/observability.md:56-57` (the App-logs claim). Relates to the transport-drop debugging
runbook in that doc.

**How we'll know it's done.** *Manual:* either `rg 'createLogger' -g '!*.test.ts'` shows
real consumers in worker/daemon and app logs carry `run_id`/`task_id`, **or** `createLogger`
is gone and the doc no longer claims a structured-log channel. No third "defined but unused"
state.

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


## Group AC — Dogfooding-at-scale resilience (found driving 10 groups at once, 2026-08-18)

Filed after driving all 10 remaining backlog groups through the workbench on `agent-workbench`
itself in one batch. The features worked; the *operating envelope* did not. Each item below is a
concrete failure observed in that run (companion to the network-partition ticket, TASK-111).

### [ ] TASK-112: No concurrency cap — N parallel tasks each spawn a `vitest` worker pool and thrash the box to load ~377

**What's wrong.** Running ~10 tasks concurrently on one machine drove the load average to **377**
(normal ~8) and made the box unusable — `ps`, and even `awb task cancel`, timed out (>3 min) because
the OS couldn't fork. Root cause: every task runs `npx vitest run` in its worktree during
`implement`/`verify`, and vitest spawns a **tinypool worker pool per run**; ~10 concurrent runs →
~150+ node processes → "Worker exited unexpectedly (resource exhaustion — too many processes)", after
which every task that reached `verify` **hung at `verify/phase-started` with no further events**. The
only recovery was `pkill -9 -f tinypool; pkill -9 -f vitest` (load 377→8 instantly). There is **no
workbench-level cap** on how many tasks run heavy phases at once, and **no bound on vitest's own worker
pool** during verify.

**What to do.** Bound concurrency at two levels: (1) a **task-scheduler concurrency limit** (max N
tasks in a resource-heavy phase — implement/verify — at once; queue the rest), defaulting to a safe
small N (≈4–5 on a laptop) and configurable; (2) cap the **per-verify vitest pool** (e.g. run vitest
with `--pool=threads`/`--poolOptions.*.maxThreads` or a `--maxWorkers` bound) so a single verify can't
fan out unboundedly, and so N concurrent verifies don't multiply into hundreds of processes. Consider a
global process/OS-load guard that defers dispatching a new heavy phase when load is already high.

**Where.** `apps/daemon/src/scheduler.ts` (dispatch concurrency limit), the verify command assembly in
`packages/verification/src/verification-runner.ts` + the discovered `unit-test` command (bound the
vitest pool), and `packages/config` for the configurable cap. Relates to TASK-104/105 (verify
timing/heartbeat — a bounded verify is also a faster verify) and TASK-74 (blast-radius scoping reduces
per-task cost).

**How we'll know it's done.** *Manual:* dispatch 10 tasks against one machine and confirm no more than
N run a heavy phase at once, load stays bounded, and no task hangs at `verify` from resource
exhaustion. *Unit:* the scheduler admits at most N concurrent heavy-phase tasks and queues the rest.

### [ ] TASK-113: A run can commit a catastrophic over-reach (726 files, `archive/` + `packages/` swept) with no guard

**What's wrong.** One dogfood run (the TASK-88 dogfood-skill task, whose intended change was a **single
182-line** `.claude/skills/dogfood/SKILL.md`) produced a commit touching **726 files, +27190/−10165** —
it swept all of `archive/` (467 files) plus `packages/`/`workers/`, and **embedded the entire task
prompt as the commit message**. Nothing in the pipeline flagged that the diff was three orders of
magnitude larger than the contract implied, or that it touched `archive/` (a retired, off-limits tree),
or that the commit message was a pasted prompt. The change only did not land because a human inspected
`git diff --stat` and salvaged the one intended file by hand. On the autonomy path (Group AA:
draft-PR-terminal, no human gate) this would have opened a PR proposing to rewrite the repo.

**What to do.** Add a **blast-radius / over-reach guard** between implement and delivery: compare the
actual diff against the contract's expected scope (files/paths/size) and **block or flag** a diff that
is wildly larger than the contract implies (e.g. N× the planned file count, or touching paths the
contract never mentioned). Treat writes to protected/off-limits trees (`archive/`, generated `dist/`,
lockfiles, `node_modules`) as a hard stop unless the contract explicitly names them. Sanity-check the
**commit message** (reject a message that is verbatim the prompt / absurdly long). This is the
implement-phase sibling of the existing `slice-diff-exceeds-cap` velocity guard, but keyed to
*contract scope and protected paths*, not just raw line count. On the autonomy path it should mark the
task `UnmetCriteria` (scope violation) rather than deliver.

**Where.** The implement→verify/delivery boundary in
`workers/temporal-worker/src/activities/run-phase.ts` (diff assembly + a new scope/over-reach check),
the contract's expected-scope fields in `packages/domain` (specify contract already carries
objective/constraints — extend with touched-path expectations), the protected-path policy in
`packages/policy`, and the commit path in `packages/github`/`packages/workspace`. Relates to
`slice-diff-exceeds-cap` (TASK-68), TASK-74 (blast radius), and the Group-AA `UnmetCriteria` terminal.

**How we'll know it's done.** *Unit:* an implement diff that touches `archive/` or is N× the contract's
expected file count is flagged/blocked (not silently committed), and a commit message equal to the raw
prompt is rejected. *Manual:* re-run the TASK-88 dogfood task and confirm it produces the ~1-file change
its contract implies — or is stopped with a clear scope-violation reason — never a 726-file sweep.

### [ ] TASK-114: "Recover-and-land past a broken verify" is a hand-run rescue — make it a first-class command

**What's wrong.** When `verify`/`exercise` can't complete (resource exhaustion per TASK-112, a hung
self-booting e2e test per TASK-104, or the stack being torn down), the **implementation is already
complete and committed in the worktree** — but the task never reaches `release`, so there is no
delivery. Recovering it today is a manual sequence a human runs by hand: find the isolated worktree
(`$AWB_DATA_DIR/worktrees/<repoId>/<slug>-<short>`), `git push -u origin <branch>`, `gh pr create
--draft`, and hand-write a body noting verification did not run. That rescue was needed for **8 of 10**
tasks in this batch, so it is not an edge case — it is the common outcome when verify is fragile.

**What to do.** Make it a first-class action: `awb task deliver-worktree <task>` (or a `--force-draft`
option on the existing delivery path) that opens the draft PR **from the committed worktree branch as-is**,
with an auto-generated body that honestly states which phases completed and that verification did **not**
run (met/unmet, per the Group-AA report format). This is squarely the autonomy-pivot terminal (TASK-106:
every task ends at a draft PR, even on non-convergence) — wire the "verify could not complete" path to the
same draft-PR terminal with an unmet-criteria note, instead of leaving delivery stranded and the operator
pushing by hand.

**Where.** `workers/temporal-worker/src/activities/run-phase.ts` (release/delivery — allow a
verify-incomplete → draft-PR-with-unmet-report path), `apps/cli/src/commands/task.ts` (a
`deliver-worktree`/`--force-draft` command), reusing the PR-body evidence-matrix + met/unmet checklist
from TASK-106. Depends on / merges with Group AA (TASK-105 `UnmetCriteria`, TASK-106 draft-PR terminal).

**How we'll know it's done.** *Manual:* a task whose verify cannot complete still ends at a draft PR whose
body says implement done / verify not run, produced by one command — no hand-run `git push` + `gh pr
create`. *Unit:* the delivery path, given a completed implement + an incomplete verify, produces a draft PR
with an unmet-criteria (verification-incomplete) report.

### [ ] TASK-115: Driving a fleet via context-inheriting forks bleeds context and self-stalls — the driver needs isolation + a real poll loop

**What's wrong.** To drive many tasks' gates in parallel, one-fork-per-task was tried (a `fork` subagent
per task). Two failures: (1) **context bleed** — each fork inherited the coordinator's full conversation,
so it believed it was the coordinator, re-narrated the entire fleet's status, and claimed to be driving
*other* groups' tasks (risking double-driving); (2) **self-stall** — each fork queued a single timed poll
and then ended its turn instead of looping, so with no external scheduler to wake it, it went idle and
its watchdog reported it "stalled: no progress for 600s". The reliable approach turned out to be driving
**directly from one session** with a small background poll script that surfaces only tasks at a gate.

**What to do.** If fleet-driving is worth supporting as a feature (vs. the current one-session +
poll-script pattern, which works), the driver unit must: run a **bounded poll loop inside its own turn**
(not a fire-once-then-idle), receive **only its own task id + the minimal gate-decision table** (not the
whole conversation), and never touch another task. Simplest: a small `awb task drive <task>` /
`awb fleet drive <ids...>` helper that mechanically answers the known gates (contract→approve,
plan→approve, slice-cap→known override, pr-readiness→record) on an interval — the `run-workbench-task-simple`
decision table as an executable, not a subagent that inherits an entire session. Model-agnostic per the
`external-tools-model-agnostic` learning.

**Where.** A new `apps/cli` driver command (or a documented poll-script pattern under
`.claude/skills/run-workbench-task-simple/`), reusing the gate-decision table already written there. Do
**not** rely on context-inheriting subagents for per-task driving. Relates to `run-workbench-task-simple`,
`flex-dash-run-autonomy`, and the Group-AA autonomy work (with all gates removed, "driving" collapses to
watching for the draft-PR terminal, which makes this much smaller).

**How we'll know it's done.** *Manual:* drive ≥5 tasks to their terminal state with no context-inheriting
subagent, no cross-task interference, and no "stalled 600s" idle — either via one session + poll script or
a dedicated `drive` command that loops internally.


## Group H — Measure before expanding (evaluation & token spend)

Three "prove it earns its cost" tasks: does the extra planning phase help, is the
Haiku classifier replaceable by a local model, and where are the actual runs
wasting tokens. All three are answered by querying real runs, not by intuition.

### [ ] TASK-61: Evaluate whether L + program-design actually helps (measure, don't assume)

**What's wrong.** We shipped the program-design phase (TASK-52) for L tasks on the
WSFF thesis that cheap structural review before code catches expensive mistakes —
but we have **not** shown it catches anything on real runs, only that it runs. The
open question (raised in review): does the extra phase earn its cost, or would "plan
less, implement in one session" do as well? This must be answered by measurement,
not intuition.

**What to do.** Instrument program-design runs and compare against a counterfactual:
rework/loop-back rate (repair/replan iterations), reviewed-vs-total diff ratio, and
review-comment / maintainability-annotation density (TASK-53) for L-with-program-design
runs vs. L-classified runs with the phase disabled (a flag). Fold into the decay
metrics (TASK-55) and cost instrumentation (TASK-46) rather than a bespoke pipeline.
Output a short writeup: keep program-design as-is, collapse it into a richer `plan`
artifact, or drop it. Do NOT expand the phase further until this call is made.

**Where.** `packages/telemetry` (OTel run attributes/spans) + `packages/database`
(`data-access/observability.ts`, run/attempt/session tables), a config flag to
disable program-design for A/B, the evaluation writeup in `docs/`. Depends on
TASK-55/TASK-46 for the metric plumbing; evaluates TASK-51/TASK-52.

**How we'll know it's done.** A writeup over several real L runs (with/without
program-design) with a keep/collapse/drop recommendation backed by the rework +
reviewed-ratio numbers.

### [ ] TASK-62: Evaluate a local shadow classifier as a Haiku replacement — bigger corpus, bigger models

**What's wrong / the finding.** The size classifier (TASK-51) runs Haiku as the
authoritative model with an opt-in local (Ollama) shadow. A first live shadow run
(`AWB_CLASSIFIER_SHADOW=1`, model `llama3.2:latest` ≈ 3B) over a 6-prompt corpus
scored **Haiku 6/6 vs. expected, local 4/6, agree 4/6**. The two local misses were
informative: it over-sized a trivial README change (S→M, the *safe* error) AND
under-sized a new-repo task (L→M, the *dangerous* under-planning error the sizing
router exists to prevent). Conclusion so far: **`llama3.2:3b` is not promotable** to
authoritative — keep it shadow-only, Haiku decides. But that call rests on n=6, a
single run, non-deterministic models, and only ONE local model — directional, not a
benchmark.

**What to do.** Turn the one-off run into a real evaluation before making any
promote/decline decision:
- Build a curated prompt corpus (~30–50) spanning clear-S / clear-L / borderline
  S-M and M-L, each with an expected label + rationale (extend the 6 seed cases).
- Run each prompt N times (models are non-deterministic) and report per-model
  accuracy, agreement, and — weighted heavier — the **cost-weighted error rate**
  (under-sizing L→S/M penalized far more than over-sizing), per TASK-61's rubric.
- Test the LARGER local models already pulled (`qwen3:30b`, `gemma4:26b`,
  `qwen3-coder:30b`), not just the 3B, to see whether size closes the gap enough to
  justify a local authoritative path (offline / zero-API-cost classification).
- Fold results into TASK-61's shadow-mode trace collection rather than a bespoke
  harness; the live harness used here lives in scratch only (not committed).

**Where.** `workers/temporal-worker/src/activities/size-classifiers.ts` (the shadow
path already exists), the eval corpus + runner (new, likely `docs/` + a scratch or
`scripts/` harness), TASK-61's `PlanningEvaluationTrace`. Depends on nothing; informs
whether the Haiku dependency can be dropped for classification.

**How we'll know it's done.** A short writeup: per-model accuracy + cost-weighted
error over the corpus, and a clear promote / keep-shadow / decline call for each
candidate local model (with `llama3.2:3b` already declined on the seed evidence).

### [ ] TASK-79: Audit every prompt for token waste — driven by querying the ACTUAL runs

**What's wrong.** We have never systematically looked at *where the tokens actually
go*. Each phase (specify, plan, program-design, implement, verify, exercise, review,
delivery) ships a prompt, and the real agent sessions those prompts drive are the
dominant cost — but we assemble prompts by intuition and have no per-phase, per-run
token accounting that says which prompt (or which injected context) is expensive and
whether that spend buys anything. The standing `group-e-token-memory-graph` finding
is that cost lives in **in-session context**, not the static preamble — so a prompt
audit that only re-reads the prompt templates would miss the real waste. This must be
grounded in querying real runs, not eyeballing the templates.

**What to do.** Query the actual runs to find the token sinks, then cut them:
- Pull real per-phase token spend from the existing instrumentation
  (`packages/telemetry` + the SQLite run tables in `packages/database`
  (`data-access/observability.ts`) — `tokenBreakdown` /
  `runtimeAttribution` are already on the wire, see the `ui-roadmap` learning) so we
  can rank phases and prompts by **actual** tokens consumed across real tasks, not
  estimates. Include cache-read vs. cache-write vs. fresh-input split.
- For the top offenders, separate the static prompt/preamble cost from the
  injected-context cost (skill text, discovered-code context, prior-artifact
  re-inclusion, tool-output that gets replayed into later turns) — the latter is
  where `group-e` says the real spend is.
- Audit each phase's prompt + injected context for waste: redundant re-statement of
  the same context across phases, whole-file/whole-package reads that the change
  doesn't need (ties to TASK-74's blast-radius concern), un-compressed tool output
  replayed into context, and skills/recipe cards inlined where they aren't needed.
- Land concrete reductions (tool-output compression, scope-to-blast-radius context,
  drop redundant preamble) and re-measure against the same real runs to show the
  delta. Prefer the highest-tokens-per-phase wins first.

**Where.** The prompt-assembly path per phase
(`workers/temporal-worker/src/activities/` phase prompts + any injected skill/context
support), `packages/telemetry` + the run/attempt/session token tables in
`packages/database` (`data-access/observability.ts`) for the
query side, a short ranked writeup + the applied reductions in `docs/`. Depends on
the TASK-46/TASK-55 token plumbing for the query surface; relates to
`group-e-token-memory-graph` (in-session context is the real cost, not caching) and
TASK-74 (don't read code the change doesn't need).

**How we'll know it's done.** A ranked writeup — per-phase / per-prompt **actual**
token spend across several real runs, the top waste sources named, and the applied
reductions with a before/after token delta on the same runs. Not "we reviewed the
prompts," but "we queried the runs, found X phase burns N tokens on Y, cut it, and
re-measured."


### [ ] TASK-102: Task DAG supports fan-out but NOT fan-in — a scheduling-only edge for "wait for A AND B"

**What's wrong.** The shipped stacked-PR DAG (`schedule_state` + `parent_task_id` +
`TaskScheduler`, merged in #23) is a **forest of stacking chains**, not a general DAG.
The single edge means *two things at once*: (1) scheduling — "don't start until the
parent releases its draft PR", and (2) stacking — "base your git branch on the parent's
delivered branch". Because a git branch can be based on exactly ONE ref, a node can have
at most one parent (`parent_task_id` is a scalar column, and `validateTaskDag`
deliberately rejects fan-in). So **fan-out works** (many children share one
`parent_task_id`; `onParentReleased` starts them all in parallel), but **fan-in is
impossible** (a task cannot wait on — or stack on — two parents). Today the
`decompose-into-dag` skill works around this by *linearizing*: pick a primary parent to
stack on and order the other predecessor before it.

**What to do.** Add a **scheduling-only** dependency edge, distinct from the stacking
edge, so a task can wait for *multiple* predecessors to complete without stacking its
branch on any of them (each such node's PR base stays the repo default branch — this is
the archived "V4 DAG" model: edges = run-order only, independent branches). Concretely:
a `task_dependencies` edge table (edges-as-rows → arbitrary DAG: chains, fan-out,
fan-in, diamonds), a scheduler eligibility rule of "start when EVERY predecessor has
released" (vs. the current single-parent check), and a way to declare per-edge whether
it is `stack` (base on parent, ≤1) or `after` (wait only, N). Keep the stacking edge as
the special case it is. Reuse the existing `TaskScheduler.reconcile` / `listBlockedTasks`
loop and the topo-sort/validation in `validateTaskDag` (extend it to allow multiple
`after` parents while still forbidding multiple `stack` parents).

**Where.** `packages/domain/src/task-dag.ts` (`validateTaskDag`, `TaskDagNode.dependsOn`
is currently a single key), `packages/database` (new `task_dependencies` edge table +
migration; `parent_task_id` stays as the stacking edge), `apps/daemon/src/scheduler.ts`
(`isEligible` → "all predecessors released", `onParentReleased` → fan-in reconcile),
`apps/daemon/src/routes/tasks.ts` (`POST /api/task-dags` accepts per-edge mode), and the
`decompose-into-dag` skill (stop force-linearizing genuine fan-in). Relates to the
archived `agentic-development-task-system-v4__ai` QueueService (scheduling-DAG prior art)
and TASK-72.

**How we'll know it's done.** *Unit:* `validateTaskDag` accepts a diamond (D depends on
B and C, both depend on A) with `after` edges and rejects two `stack` parents; the
scheduler starts D only after BOTH B and C release. *Manual:* declare a fan-in DAG and
confirm the join node starts exactly once, after all its predecessors delivered, with its
PR base = the default branch (not stacked).


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


## Group K — Scaling on large monorepos

### [x] TASK-74: Repo discovery can't complete on large monorepos (fender, ~620 packages) — scan times out / retry-loops

**What's wrong.** Repo-discovery cannot complete on fender (~620 workspace
packages): the scan times out and retry-loops, blocking *all* tasks before any code
runs. Root cause (verified on current main): `discoverUnits`
(`packages/repository/src/units.ts:75`) does O(n²) dependency-linking — the nested
loop at `units.ts:134-143` re-reads every other package's `package.json` inside the
innermost loop (`const otherPkg = await readPackageJson(...)` at `units.ts:143`),
i.e. O(candidates × deps × candidates) awaited disk reads (~380k on ~620 packages).
The daemon fetch in `workers/temporal-worker/src/daemon-client.ts:20` also carries
no `AbortSignal`, so a wedged discovery drops opaquely instead of timing out.
Beyond discovery hanging, the broader concern is that a task reads far more code
than the change needs — we should not be scanning/reading every package unrelated
to the target change and burning tokens on them.

**What to do.** Land a discovery-scaling fix: read each `package.json` **once**
(into a `pkgByDir` map via `Promise.all`), build an `idByPackageName` map so a
dependency edge is one map lookup instead of a nested scan-and-read, pass the
already-read pkg into `classifyUnit` instead of re-reading, and replace the linear
`units.find(...)` with a `unitByDir` map lookup; add `signal:
AbortSignal.timeout(...)` on the daemon fetch. A prototype of exactly this exists
on branch `timothyshee/fix-discovery-scaling` (commit `89a4202`, +38/−18 across
`units.ts` + `daemon-client.ts`) — **verified NOT on main** (`git merge-base
--is-ancestor 89a4202 main` → 1); real fender discovered 622 units in ~225ms after
it. Merge it (or reimplement on current main) and, separately, ensure the *task*
scopes what it reads to the change's blast radius rather than the whole workspace.

**Where.** The discovery worker's `discoverUnits` (dependency-linking loop + worker
fetch), and the task-scoping / context-retrieval path that decides how much code a
task ingests. See branch `timothyshee/fix-discovery-scaling` @ `89a4202`. Relates to
the `fender-discovery-scaling-block` learning.

**How we'll know it's done.** *Unit:* `discoverUnits` on a synthetic ~600-package
workspace reads each `package.json` once (assert read count ≈ package count, not
n²) and completes within a bounded time. *Manual:* register real fender and confirm
discovery completes (~620 units, sub-second) so tasks can run — with no per-package
full-source read for unrelated packages.


## Group L — QA gate false-positives

### [x] TASK-75: `exercise` QA-evidence gate parks a finished, verified change at `repeated-failure-no-progress` (repairs `implement`, which can't fix an evidence deficiency)

**Done.** The exercise handler's `onBlocked` no longer maps every blocked decision to
`repair → implement`. It now calls `classifyExerciseBlock` (new pure export in
`packages/workflow/src/evaluate-completion.ts`) to split the block: a *real observed
failure* — `policyBlockingErrorsPresent`, or `structuredAssertionsPass === false` (an
assertion that ran and failed) — is `code-fixable` and keeps routing `repair → implement`;
every other blocked signal (missing recording/trace, a claim with no *authored* strong
assertion, a scenario with no result, evidence not tied to the candidate SHA) is an
`evidence-deficiency` that re-coding cannot satisfy, so the handler now returns
`await-human` with reason `qa-inconclusive` (already in the `HumanGateReason` enum) instead
of grinding to the 3-strike `repeated-failure-no-progress` gate. A candidate that genuinely
satisfies its claim and passes tests/e2e still clears the gate unchanged. *Tests:*
`classifyExerciseBlock` unit table (code-fixable vs evidence-deficiency, precedence) +
routing assertion added to the real-chromium `qa-gate-proof.test.ts`; full workflow + worker
suites green (241 tests).


**What's wrong.** A task whose code compiles and whose unit + e2e commands pass
clears `verify` (`evaluate-completion.ts:110-123`) and then hits the `exercise`
gate, `evaluateExercise` (`evaluate-completion.ts:125-147`). That gate checks
QA-*evidence* signals that are independent of the code being correct —
`everyBehavioralClaimCovered`, `behavioralClaimsMissingStrongAssertion`,
`structuredAssertionsPass`, `requiredRecordingExists`, `browserScenariosHaveTraces`,
`evidenceTiedToCandidateSha`, `policyBlockingErrorsPresent` (`:130-141`). When any
fails, the exercise handler maps the result to `outcome: 'repair', target:
'implement'` (`run-phase.ts:1197`), so the workflow loops
`exercise→implement→verify→exercise`. Re-running `implement`/`verify` **cannot**
satisfy an evidence deficiency (a missing recording/trace, a claim with no strong
assertion), so the loop makes no real progress — a complete, passing change never
reaches pr-readiness on its own.

**Correction to the original report:** the loop is **not** unbounded. A per-phase
`failureStreak` hits `NO_PROGRESS_THRESHOLD = 3` (`task-workflow.ts:70,251-259`) and
parks the task `awaiting-human` behind a `repeated-failure-no-progress` gate
(`task-workflow.ts:104,258`; halts at `:194-197`). So the trap is real ("can't reach
pr-readiness without a human") but it is a bounded 3-strike human gate, not an
infinite re-raise. Note also the streak counter is a plain per-phase count — the
richer `isNoProgress` fingerprint machinery in
`packages/workflow/src/failure-fingerprint.ts:44-60` is **not** wired into the
exercise repair path at all.

**What to do.** Two independent problems to separate: (1) an evidence deficiency
should not `repair`-target `implement` — re-coding can't produce a missing
recording/trace; route it to the QA/evidence-capture step (or block with a
QA-specific reason) instead. (2) A candidate that genuinely satisfies its claim and
passes tests/e2e must be able to exit the gate; tie the exit to actual evidence
rather than looping into `implement`. Confirm against TASK-63 first: that gap
(exercise gate ignores whether the diff touches the claim's target files) is
**adjacent but distinct** — the TASK-63 branch (`timothyshee/task63-exercise-diff-claim`,
commit `d9fcb01`) adds `behavioralClaimsWithUntouchedTarget` to `evaluateExercise`
but does **not** touch this no-progress/repair-routing guard (verified: that field
does not exist on main).

**Where.** `packages/workflow/src/evaluate-completion.ts:125-147` (`evaluateExercise`
signals), `workers/temporal-worker/src/activities/run-phase.ts:1179-1198` (exercise
completion context + `onBlocked → repair/implement`),
`packages/workflow/src/task-workflow.ts:70,251-265` (streak + human escalation),
`packages/workflow/src/loop-routing.ts:68-75` (`shouldEscalateToHuman`), and the
unwired `failure-fingerprint.ts`. Relates to TASK-63 and the
`qa-static-checks-miss-runtime-bugs` / `qa-cold-reentry-nonconvergence` learnings.

**How we'll know it's done.** *Unit:* a completion test where the candidate
satisfies its claim and tests/e2e pass reaches pr-readiness (does not accumulate
`repeated-failure-no-progress`); and an exercise result that fails only on an
evidence signal routes to QA/evidence capture, not `implement`. *Manual:* re-drive
the stuck task and confirm it reaches pr-readiness instead of parking at the
3-strike human gate.

> **Confirmed already fixed on main — original overlaps were stale, do NOT re-file:**
> - **Program-design bodyless-check (was flagged as TASK-67):** genuinely fixed.
>   `signatureIsBodyless()` at
>   `workers/temporal-worker/src/activities/program-design-support.ts:56-64` no
>   longer flags `;` inside `{ }` — it detects statement markers only
>   (`return|if(|for(|while(|switch(|await|const/let/var`), and the exact
>   `interface Provenance { …; …; … }` from the report is an asserted-`true` test
>   case (`program-design-support.test.ts:49-50`).
> - **Concurrent sessions / port 4417 (was flagged as TASK-59):** genuinely fixed.
>   Port is env-driven (`AWB_DAEMON_PORT`, `runtime-config.ts:26,34-42`) and `awb up
>   --isolated` (`apps/cli/src/commands/lifecycle.ts:104,117-123`) applies
>   `isolatedOverrides` (`runtime-config.ts:129-155`) — per-checkout port offsets +
>   a separate `AWB_DATA_DIR` DB (`paths.ts:4-5`), so a second stack no longer
>   collides on 4417 or shares `~/.agentic-workbench`.


## Group M — Local-model driving & dogfooding

### [x] TASK-76: A prompt/skill that lets even a weak local model *drive* a task (not code it)

> **Done.** New skill `.claude/skills/run-workbench-task-simple/SKILL.md` — a
> judgment-free driving loop sibling to `run-workbench-task`. It reduces driving to one poll
> (`task show`), two fields (`state.condition`, `pendingHumanGate.reason`), and a
> lookup table of `open gate → one copy-paste command`. Every command was verified
> against the real CLI surface (`apps/cli/src/commands/task.ts`): notably there is
> **no `reject-contract`** command, so the skill tells the driver to STOP on a
> wrong contract rather than invent one. The known auto-resolutions
> (`slice-diff-exceeds-cap` → `AWB_SLICE_DIFF_CAP=0` restart,
> `repeated-failure-no-progress` → diagnose/park) are written as operator recipes,
> not driver actions, because they require a stack restart that would otherwise
> block the task. Model-agnostic per `external-tools-model-agnostic`. Manual
> acceptance (a weak local model driving a real task end-to-end) remains to be run
> live under TASK-77.

**What's wrong.** Driving a task through the workbench (boot stack, register repo,
create task, approve the contract gate, answer gates, drive to pr-readiness,
triage) currently assumes a capable model. There is no artifact that makes it
*very easy* for even a small/weak local model to drive a task. Such a model may not
do the in-depth coding, but it should be able to at least steer the loop —
answering gates and advancing phases — while a stronger model (or the workbench's
own real path) does the implementation.

**What to do.** Author a tightly-scripted prompt or skill (a "driver" companion to
`run-workbench-task`) that reduces driving to a small, deterministic decision list:
which gate is open → the one correct action, with copy-paste-ready `awb` commands
and the known auto-resolutions (contract→approve, slice-cap→`AWB_SLICE_DIFF_CAP=0`,
no-progress→diagnose/park). Keep it model-agnostic per the standing
`external-tools-model-agnostic` learning. The goal is that the driving surface is
mechanical enough for a stupid model to follow without judgment.

**Where.** A new skill under `.claude/skills/` (or the plugin's skills), sibling to
`run-workbench-task`; recipe cards / seed env per the model-agnostic learning.
Relates to `flex-dash-run-autonomy` (the known auto-resolvable gates) and
`skill-delivery-prompt-injection`.

**How we'll know it's done.** *Manual:* a small local model, given only the driver
skill, drives a real task from registration to pr-readiness — answering each gate
correctly — without the operator hand-holding it. Captured as a short transcript.

### [~] TASK-77: Dogfood the workbench on *this* repo (agent-workbench itself)

**What's wrong.** We dogfood on `browser-games` / `fender` / `app` but have never
driven a task against *this* repo — the most honest test of whether the tool is
pleasant to use on a real TS monorepo.

**What to do.** Register `agent-workbench` as a repo and drive one small, real,
self-contained task (e.g. one of the smaller fixes above) end to end,
interactively, stopping at the pr-readiness gate. Capture friction as new TODO
items here.

**Where.** Operational — uses the `run-workbench-task` skill; no code target.
Relates to `implement-feature` (self-modification flow).

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

### [ ] TASK-88: A `dogfood` skill that ALWAYS boots an isolated stack — never prompts, never blocks an active task

**What's wrong.** Every time we kick off a dogfood run there is a decision the model
has to stop and ask about: a warm workbench stack is often already running from the
MAIN checkout with an **active task in Temporal**, and to run patched code from a
worktree you must boot from that worktree — but `down`/`up` on the shared stack
**permanently blocks the running task** (in-memory run state is wiped; see the
`drive-task-runtime-env` learning and `run-workbench-task` §"never `down`/`up`
mid-task"). The only safe answer is an **isolated** stack (separate port + separate
`AWB_DATA_DIR`), and in practice the operator picks "isolated" *every single time*.
The current `run-workbench-task` skill has **no isolation guidance at all** (verified:
`grep -i isolat .claude/skills/run-workbench-task/SKILL.md` → no match), so the model
either risks clobbering the warm stack or halts to ask a question whose answer is
always the same. The isolation mechanism already exists and is proven — `awb up
--isolated` applies `isolatedOverrides` (`packages/config/src/runtime-config.ts:129-155`:
`AWB_DAEMON_PORT = DEFAULT + base`, `AWB_DATA_DIR = <base>-<tag>`), wired at
`apps/cli/src/commands/lifecycle.ts:104,117-123,153-154` — it is simply never made the
default for dogfooding.

**What to do.** Author a dedicated **`dogfood`** skill (a companion to
`run-workbench-task`) whose non-negotiable first step is: **always `awb up
--isolated`** from the controller checkout, so the run gets its own port +
`AWB_DATA_DIR` and can never `down`/`up` or otherwise disturb a stack (or active task)
running from MAIN. The skill should:
- Boot isolated unconditionally — do **not** ask "isolated or shared?"; the answer is
  always isolated. Print the isolated stack's `daemonUrl`/`temporalAddress`/`taskQueue`
  (already emitted at `lifecycle.ts:153-154`) and target every subsequent `awb`
  command at that stack.
- Detect an already-running MAIN stack + active task up front and route around it via
  isolation rather than surfacing it as a question. (The transcript that motivated
  this: a TASK-78 run was live on the MAIN stack while we needed to dogfood a TASK-73
  fix from a worktree — isolated was the only correct move.)
- Tear down only the isolated stack at the end, never the shared one.
- **Automatic slot selection (the open sub-question):** `isolatedOverrides` derives the
  port/data-dir tag from the checkout's workspace root, so two isolated stacks from the
  *same* worktree would still collide. Decide the slot automatically (e.g. hash of
  worktree path already done, plus a free-port probe / next-free-tag fallback) so the
  skill never needs the operator to pick a port. Confirm the chosen slot is actually
  free before boot.
- Stay model-agnostic per the standing `external-tools-model-agnostic` learning; reuse
  `run-workbench-task`'s gate-answering body rather than duplicating it.

**Where.** A new skill under `.claude/skills/dogfood/` (sibling to
`run-workbench-task` / `implement-feature`); references `awb up --isolated`
(`apps/cli/src/commands/lifecycle.ts:104,117-123`) and `isolatedOverrides`
(`packages/config/src/runtime-config.ts:129-155`). Optionally teach
`run-workbench-task` to default to `--isolated` when a stack is already warm. Relates
to the `awb-worktree-multistack-blockers`, `drive-task-runtime-env`, and
`group-g-task59` learnings (TASK-59 shipped `--isolated`), and to `implement-feature`
(which already uses an isolated target worktree).

**How we'll know it's done.** *Manual:* invoking the `dogfood` skill while a task is
actively RUNNING on a MAIN-checkout stack boots a second isolated stack (distinct
port + `AWB_DATA_DIR`), drives a fresh task to pr-readiness, and tears down **only**
the isolated stack — with the MAIN stack's running task untouched, and **without the
skill ever asking whether to isolate**.

### [ ] TASK-104: `verify` records NOTHING per-command, so a stalled 30-min verify is completely opaque — write incremental command timing so it's debuggable

> **Re-investigated against `main` @ `320b2dd` (2026-08-17).** The premise
> ("commands are slow") was wrong: measured on this repo, the root `pnpm test`
> (`vitest run`, 132 files) finishes in **~21s** and `pnpm build` in **~13s**. The
> real problem is a *hang* with **zero per-command observability**.

**What's wrong.** The `verify` phase runs the repo's discovered `unit-test`+`build`
commands through `runVerificationMatrix`
(`packages/verification/src/verification-runner.ts:136-145`), **serially** (`for (const
command of commands)`, each `await`ed). Each command's result is turned into `Evidence`
**only after that command finishes**, and the whole batch is returned to the verify
handler **only after ALL commands complete** (`run-phase.ts:985-988`). The
`command_executions` table exists (`packages/database/src/schema/sessions.ts:57`) but
**is never written by the verification runner** (verified: the only references in
`src/` are the schema definition + a cascade-delete — no insert). So while verify is
running there is **no durable, incremental record of which command is executing or how
long it has taken**. When the first dogfood run's verify consumed its full 30-minute
Temporal `startToCloseTimeout` (`packages/workflow/src/task-workflow.ts:22`) and the
workflow failed, the DB held a single `verify-1` `phase_attempts` row with
`ended_at`/`outcome` = null and **zero** `command_executions` — leaving no way to tell
*which* of the ~49 serial commands (root suite + 24 per-package tests + ~24 builds)
hung. Since the individual commands are fast, the 30 min was a **hang** — the prime
suspect being a self-booting e2e test (`tasks-completion-e2e.test.ts` /
`run-phase-e2e.test.ts`) blocking on a port already held by the running workbench stack
— but we **cannot confirm it** precisely because nothing was recorded.

**What to do.** Make verify **debuggable first**: write an incremental
`command_executions` row per command (started_at on spawn, ended_at + exit_code on
finish) as the matrix runs, so a live/failed verify shows exactly which command is in
flight and how long it has taken. Then, with that visibility, **streamline** so a simple
change's verify never approaches 30 min — most likely by making the self-booting e2e
tests fail fast (or be excluded) rather than hang on a port conflict. Keep running every
command (no diff-scoping, no per-command timeouts — explicitly out of scope per the
owner); the goal is visibility + no-hang, not fewer commands.

**Where.** `packages/verification/src/verification-runner.ts:74-145`
(`runCommandAndRecordEvidence` / `runVerificationMatrix` — add incremental
`command_executions` writes), `command_executions` schema
(`packages/database/src/schema/sessions.ts:57`, currently write-only-in-tests), the
self-booting e2e tests (`workers/temporal-worker/src/run-phase-e2e.test.ts`,
`apps/daemon/src/routes/tasks-completion-e2e.test.ts` — make port-conflict fail fast).

**How we'll know it's done.** During a verify run, `command_executions` shows a row per
command with live timing; and a simple change's verify completes fast (no 30-min hang)
because the e2e tests no longer block on a busy port.

### [ ] TASK-105: `verify` can consume the whole 30-min activity budget in ONE `runPhase` invocation — revisit the timeout / heartbeat so a legitimately-long verify isn't a terminal failure

> **Re-investigated against `main` @ `320b2dd` (2026-08-17).** Companion to TASK-104
> (the timeout is only *reached* because verify hangs; this ticket is the ceiling
> itself). Correction to earlier drafts: a timed-out phase does **not** persist
> "nothing" — a `verify-1` `phase_attempts` row IS written at phase start (via the
> `phase-started` semantic event → `ensureRunAndPhaseAttempt`); it just never gets an
> `ended_at`/`outcome` because the phase never completes. (The `retry_of` lineage
> column is **not on `main`** — it lives on the open `ui-roadmap` PR #18; the copy in
> the live DB is a leftover from running that branch against the shared SQLite. Nothing
> to wire or delete here.)

**What's wrong.** The `runPhase` activity has a flat `startToCloseTimeout: '30 minutes'`
with `maximumAttempts: 3` (`packages/workflow/src/task-workflow.ts:21-31`). A single
verify pass that runs the full command matrix (TASK-104) can approach that ceiling; when
it does, Temporal kills and **retries the activity**, but the workflow-held
`attemptNumber` is fixed for that dispatch, so each retry re-emits `phase verify started
(attempt 1)` (observed three times, 30 min apart) and the workbench's own no-progress
accounting (`failureStreak` / `repeated-failure-no-progress`,
`task-workflow.ts:252-258`) — which only counts workflow-level `repair` outcomes —
**never sees the retries**. After 3 × 30 min the activity fails permanently and the whole
workflow goes terminal. The RetryPolicy comment (`task-workflow.ts:24-27`) says retries
are meant for *transient infrastructure* failures; a slow-but-progressing verify is
misclassified as one.

**What to do.** Make a long-but-live verify survivable and legible: **heartbeat** the
activity (so Temporal sees liveness and a `heartbeatTimeout` replaces the coarse
`startToClose`), and/or raise the verify budget for phases that legitimately run a full
matrix. This is deliberately separate from TASK-104: even after verify stops hanging, the
30-min-single-invocation ceiling is a latent cliff worth removing.

**Where.** `packages/workflow/src/task-workflow.ts:21-31` (proxyActivities
retry/timeout), `:215-217` (attempt bump vs. activity retry), `:252-258` (no-progress
accounting); `workers/temporal-worker/src/activities/run-phase.ts` (verify heartbeat).
Related to the cold-restart-on-retry gap (`observability-live-proof`, TASK-32).

**How we'll know it's done.** A verify that legitimately runs long heartbeats and
completes instead of being killed at 30 min, and a genuinely stuck phase is surfaced as
a counted, recorded failure rather than a silent "attempt 1" replay.

### [ ] TASK-106: Per-package `test` script (`vitest run --dir .`) finds zero tests when run from the package dir

> **Re-verified LIVE against `main` @ `320b2dd` (2026-08-17):**
> `pnpm --filter @awb/config test` → `No test files found, exiting with code 1`.
> Still an issue.

**What's wrong.** Each package's `test` script is `vitest run --dir .`
(`packages/*/package.json`), but the root `vitest.config.ts:5` `include` glob is
**repo-root-relative** (`['packages/**/*.test.ts', 'apps/**/*.test.ts',
'workers/**/*.test.ts']`) and packages have no local vitest config. Run from inside
e.g. `packages/config`, `--dir .` re-roots resolution there, so the glob becomes
`packages/config/packages/**/*.test.ts` → matches nothing → `No test files found,
exiting with code 1`. Confirmed real, not "a package with no tests": `packages/config`
has 2 test files / **31 passing tests** when run correctly from the repo root — the
per-package script simply can't find them. So `pnpm --filter @awb/<pkg> test` reports a
false failure for every package.

**What to do.** Make the per-package `test` script actually run that package's tests —
either a per-package `vitest.config.ts` with a local `include`, or change the script to
target the package's own test glob rather than `--dir .` against the root config.

**Where.** `vitest.config.ts:5` (root `include` globs) vs the per-package `test`
scripts (`packages/*/package.json`).

**How we'll know it's done.** `pnpm --filter @awb/config test` runs that package's
tests and passes.


## Group N — Worktree DX

### [x] TASK-78: Worktree *directory* path is a bare UUID (`<repoId>/<taskId>`) — illegible in `git worktree list`

> **Done.** `worktreeDir()` now takes a `dirName` leaf; `createWorktree` derives it
> via new `resolveWorktreeDirName(taskId, slugSource)` (`packages/workspace/src/branch.ts`),
> which mirrors the branch's `<slug>-<shortId>` minus the `awb/` prefix. Worktree leaf
> is now e.g. `add-login-flow-task1` instead of a bare UUID. Covered by
> `branch.test.ts` (slug/short-id + distinctness) and the `worktree.test.ts`
> integration test asserting the slug-based path.

**What's wrong.** The worktree directory is built as
`worktrees/<repositoryId>/<taskId>` by `worktreeDir()`
(`packages/config/src/paths.ts:63-64`) — both segments are raw UUIDs, so the
directory column of `git worktree list` carries no human-readable hint when several
worktrees are active.

> **Correction to the original report:** the *branch* half of the complaint is
> stale. `resolveTaskBranchName()` (`packages/workspace/src/branch.ts:30-33`)
> already produces a **slug-first** name with only an 8-char short id suffix — e.g.
> `awb/portal-header-subtitle-game-count-ecabb015` — **not** the `…-for-<full-uuid>`
> shown in the original example. The branch is fine; only the directory is opaque.

**What to do.** Give the worktree *directory* a human-readable name derived from the
task slug (with a short unique suffix only for disambiguation). The slug is already
available — `resolveTaskBranchName` takes a `slugSource`, so the same slug used for
the branch can name the directory. Minimum change: incorporate the slug (or the
resolved branch name) into `worktreeDir()` rather than using the bare `taskId`.

**Where.** `packages/config/src/paths.ts:63-64` (`worktreeDir`), wired at
`packages/workspace/src/worktree.ts:54-55` (`branchName`/`worktreePath`), consumed by
`git worktree add ... -b <branch>` (`worktree.ts:65`). The slug source is
`packages/workspace/src/branch.ts:30-33`. Relates to the `create-worktree` skill
conventions.

**How we'll know it's done.** *Manual:* `git worktree list` after two `drive-task`
runs shows slug-based, distinguishable directory names instead of bare-UUID leaf
directories.


## Group O — UI: the operational control plane

> **Read in light of the autonomy pivot (Group AA).** The workbench no longer has a human
> approval queue — TASK-82 (approval inbox) was **deleted** and TASK-107 removes the
> `/approvals` surface. Throughout Group O, ignore any "Approvals page / approvals count /
> human intervention" language below; the only survivor is a **read-only** "Needs attention"
> list of tasks that ended `UnmetCriteria` (TASK-105), linking to their draft PRs. The build
> order likewise drops the Approvals step.

The web app is not a project-management tool with an execution engine bolted on; it
is an **operational control plane for autonomous software work**. The redesign
target: the Board shows what the factory is doing, the Tasks table gives precise
control, Task Detail explains exactly what happened (Phase Attempts → Agent Sessions
→ Model Invocations), a read-only **Needs attention** list surfaces tasks that ended
`UnmetCriteria` (no human-approval actions), Verification proves the
result, Usage shows where resources went, Repositories define the environments. `Run`
is a storage boundary, **not** a user-facing entity — do not expose it.

> **Prior art — a partial prototype already exists (unmerged), reuse it.** Branch
> `timothyshee/ui-roadmap` (**7 commits ahead of `main`, NOT merged** — `git
> merge-base --is-ancestor timothyshee/ui-roadmap main` → 1) already prototypes much
> of this: `packages/database/migrations/0006_task_summary.sql` +
> `0007_task_title_lineage.sql`, a `deriveTaskStatus` lifted into
> `packages/domain/src/task-status.ts`, `TaskBoard.tsx`, reworked
> `ApprovalsPage.tsx`/`GatePanel.tsx`/`TaskDetailPage.tsx`, and a phased plan at
> `docs/design/ui-roadmap-plan.md`. Merge/reimplement from it rather than starting
> fresh; the tasks below are scoped to *what is still absent on `main`* (verified by
> audit). The plan doc's build order (foundation → Task Detail → Board +
> Overview → Repo Detail) is the recommended sequence (the Approvals step is dropped per
> the autonomy pivot) and matches the surviving TASK-80..86.

### [ ] TASK-80: Shared read foundation — `derivedStatus` in domain + `task_summary` projection + retry lineage + freshness metadata

**What's wrong.** Every list/board/overview page would need task rollups, a single
status vocabulary, and lineage — none of which exist on `main`. Verified: (1)
`deriveTaskStatus` is **frontend-only** (`apps/web/src/lib/task-status.ts:12`), so the
board/table/detail/overview would each invent their own mapping; the API returns raw
`phase`/`condition`/`deliveryState` with **no** `derivedStatus`
(`apps/daemon/src/routes/tasks.ts:70-83`). (2) There is **no** `task_summary`
projection — `GET /api/tasks` reads the live `tasks` table joined to `repositories`
(`listTasksWithRepository`, `packages/database/src/data-access/tasks.ts:108`), with no
`attempt_count`/`open_finding_count`/token rollups/`pending_gate_reason`. (3) **No**
retry lineage: no `retryOfTaskId`/`rootTaskId`/`retry_of` on the task schema
(`packages/database/src/schema/tasks.ts:5-18`), and `task retry`
(`apps/cli/src/commands/task.ts:273-300`) creates a fresh task from the original
prompt with **no back-pointer**, so retries look like unexplained duplicates. (4) No
freshness metadata — the redesign needs to reconcile the live workflow token total vs.
the durable breakdown, but there is no `indexedAt`/`workflowUpdatedAt`/`isIndexBehind`
anywhere.

**What to do.** Build the foundation the pages read, in this order:
- **Lift `deriveTaskStatus(condition, phase)` into `@awb/domain`** (canonical), have
  the daemon use it and the API return `derivedStatus`; `task-status.ts` re-exports it
  and keeps only the Badge-variant mapping. One source of truth for table/board/detail/
  overview.
- **Materialized `task_summary` projection** (additive numbered migration + drizzle
  mirror, `0006+` to sort last): one denormalized row per task carrying
  `phase, condition, delivery_state, size, derived_status, current_phase_attempt_id,
  attempt_count, open_finding_count, input/output/cached tokens + cost (rolled from
  `model_invocations`), pending_gate_reason?, candidate_sha?, pull_request_url?,
  retry_of_task_id, root_task_id, last_meaningful_event_at, workflow_updated_at,
  indexed_at`. **Maintained in the daemon** inside the existing worker→daemon write
  handlers (no new worker code); it is a projection, not a new source of truth. Switch
  `GET /api/tasks` to read it (same response shape, extra fields additive).
- **Retry lineage:** persist at minimum `retryOfTaskId` (and `rootTaskId`, derivable
  or denormalized) on task create when created via retry; wire it through the CLI
  `task retry` path and a new web action.
- **Freshness:** expose `workflowUpdatedAt`/`indexedAt`/`isIndexBehind` so the UI can
  say "history updating" instead of showing contradictory totals.

**Where.** `packages/domain/` (new `task-status.ts`, canonical `deriveTaskStatus`),
`packages/database/` (new `0006_task_summary`/`0007_task_title_lineage` migrations +
drizzle schema + a projection-maintain function in the daemon's write path),
`apps/daemon/src/routes/tasks.ts` (return `derivedStatus`, read projection, add
freshness), `apps/cli/src/commands/task.ts:273-300` (thread lineage), and the client
DTO `apps/web/src/api/tasks.ts`. **Start from `timothyshee/ui-roadmap`** (the two
migrations + `domain/task-status.ts` already exist there). Depends on nothing; every
other Group-O task depends on this. Relates to the `ui-roadmap` / `ui-roadmap-phase0`
learnings.

**How we'll know it's done.** *Unit:* the projection stays consistent across create →
advance → retry → delete; token rollups equal a direct `model_invocations` sum; the
lineage edge is set on a real retry; `deriveTaskStatus` has one definition consumed by
domain + web. *Manual:* `GET /api/tasks` returns `derivedStatus`, rollups, and lineage
without a live Temporal fan-out, and remains responsive when Temporal is degraded.

### [ ] TASK-81: Task Detail is the product — Phase Attempts → Agent Sessions → Model Invocations, Verification, task-level Usage

**What's wrong.** Task Detail is the operational center but today it surfaces almost
none of the rich data that already exists in SQLite. The tables are all present —
`phase_attempts` (`schema/tasks.ts:28`), `agent_sessions` (`schema/sessions.ts:5`),
`model_invocations` (`schema/sessions.ts:29`), `runtime_attribution` with **12
buckets** (`schema/observability.ts:7-32`), `context_composition` with **8 token
buckets** (`observability.ts:35`), `acceptance_claims`, `evidence`, `findings`,
`artifacts` — but the detail endpoint (`apps/daemon/src/routes/tasks.ts:86-117`) only
returns compact workflow `state`, open findings, the pending gate, `tokenBreakdown`,
`runtimeAttribution`, and maintainability findings; it exposes **no** structured
phase-attempt/session/invocation tree, no acceptance-claim view, no artifacts.
**Worse — a live bug:** the API already sends `tokenBreakdown` + `runtimeAttribution`
(`tasks.ts:108-109`) but the web client type **drops them**
(`apps/web/src/api/tasks.ts:36-42`), so the page shows only the coarse
`state.tokenUsageTotal`/`runtimeMsByPhase` and discards the richer per-model/per-bucket
data the daemon computed. Evidence lives at a separate top-level single-task-lookup
page (`EvidenceViewerPage.tsx`) instead of inside the task it belongs to.

**What to do.**
- **Type the dropped fields:** extend the client `TaskStateResponse`
  (`apps/web/src/api/tasks.ts:36-42`) with `tokenBreakdown` + `runtimeAttribution` and
  render them.
- **New read for the execution tree:** `listPhaseAttempts(taskId)` →
  `listAgentSessions(phaseAttemptId)` → `listModelInvocations(agentSessionId)` (+
  context-composition per session), one route (`GET /api/tasks/:r/:t/activity` or fold
  into detail). Restructure Task Detail around **Phase Attempts → Agent Sessions →
  Model Invocations**, using the exact phrase **"Phase attempt"** (distinct from
  "Retry as new task"). Keep the composite `:repositoryId/:taskId` route (matches the
  workflow identity `awb/task/{repositoryId}/{taskId}`).
- **Phase rail + gate-on-top:** the 10 lifecycle phases (`lifecycle.ts:4-16`) as a
  clickable rail; a pending human gate rendered as a prominent page-level panel, not
  buried in a tab.
- **Verification tab (absorbs Evidence):** organize by acceptance claim → state
  (Verified / Unverified / Failed), each linking to its evidence. Because evidence is
  pinned to `candidateSha`, clearly mark **current** vs. **stale** vs. **unpinned**
  evidence and never present earlier-candidate evidence as proof of the current one
  without a warning. Remove Evidence from primary nav (see TASK-86).
- **Usage & Time section:** task-total → phase → attempt → session → invocation token
  hierarchy (prompt/completion/cached/total, model, cost labeled **estimated**), plus
  the 12 runtime-attribution buckets and a **rework** metric (tokens/runtime spent by
  unsuccessful phase attempts). Show a "breakdown still updating" notice when the live
  total leads the persisted breakdown (uses TASK-80 freshness).
- **Navigation:** no hardcoded "Back to Tasks" — return to the originating page
  (board/tasks/overview/approvals/repo/lineage) preserving its filters; canonical
  breadcrumb `Repositories / <repo> / Tasks / <taskId>`.

**Where.** `apps/daemon/src/routes/tasks.ts:86-117` (surface the tree), new data-access
queries in `packages/database/`, `apps/web/src/api/tasks.ts:36-42` (un-drop fields),
`apps/web/src/pages/TaskDetailPage.tsx` + `EvidenceViewerPage.tsx` (fold into
Verification). Prototype on `timothyshee/ui-roadmap` (`TaskDetailPage.tsx` +437 lines).
Depends on TASK-80. Relates to `ui-roadmap`, `tasks-ui-redesign`, and the
`observability-live-proof` learnings.

**How we'll know it's done.** *Manual:* Task Detail shows the phase-attempt →
session → invocation tree, a Verification tab keyed by acceptance claim + candidate
SHA with stale-evidence warnings, and per-attempt/session token + runtime attribution
— all sourced from the SQLite tables, with the previously-dropped
`tokenBreakdown`/`runtimeAttribution` now rendered. *Unit:* the client type includes
both fields; the activity route returns the FK tree for a real task.

### [ ] TASK-83: Board at `/board` (read-only, `deriveTaskStatus`-driven) + Overview at `/`

**What's wrong.** Neither exists. `/` renders the **repository registry**
(`App.tsx:19` → `RepositoriesPage`), not a factory overview, so the home page cannot
answer "what is the factory doing and where do I intervene?" There is no `/board`
(`App.tsx:18-26` has 7 routes, none is board), so there is no at-a-glance operational
view. The sidebar (`AppSidebar.tsx:14-20`) has no Overview/Board entries.

**What to do.**
- **`/board`:** a **read-only** operational monitor whose columns are exactly the
  `deriveTaskStatus` label set from TASK-80 (`column = deriveTaskStatus(condition,
  phase)`; condition dominates for awaiting-human/blocked/failed, phase gives position
  while progressing; `deliveryState` is an independent badge). Cards read the
  `task_summary` projection (no Temporal fan-out) and show: title/prompt summary, repo,
  derived status, current phase, phase-attempt number (if >1), pending-gate indicator,
  open-finding count, total tokens, elapsed, last activity, delivery/PR badge, retry-
  lineage indicator — **never** the internal `runId`. Condition-aware card actions
  (open, review approval, resume, cancel, retry as new task, open PR, copy id).
  Filters + optional repository swimlanes. **Not draggable** (see TASK-87).
- **`/` Overview:** move the repo registry off `/` to `/repositories` (TASK-84).
  Overview reads durable summary data (no live Temporal query per task): a compact
  factory-health strip (daemon / Temporal / SQLite / worker capacity / provider /
  live-event connection / last update, degraded states clear) and a prominent **Needs
  attention** section (awaiting-approval, blocked, failed, stalled-no-progress, unusual
  token spend, repeated phase attempts, unresolved findings, evidence-vs-candidate-SHA
  mismatch, repos with trust/sync problems — each linking to the task/tab). Plus
  current-state count cards and a semantic recent-activity feed. Limited quick actions
  (create task, add repo, open approvals, open board).
- Keep `/tasks` as the dense table (search/sort/filter/bulk/exact values) reading the
  same projection; adopt attempt/finding/token columns. Both board and table read
  `task_summary` — do **not** create a second frontend status mapping.

**Where.** `apps/web/src/App.tsx:18-26` (+`/board`, repoint `/`),
`apps/web/src/components/layout/AppSidebar.tsx:14-20` (add Overview + Board), new
`OverviewPage` + `TaskBoard.tsx` (board prototyped on `timothyshee/ui-roadmap`), new
`GET /api/overview` reading the projection. Depends on TASK-80. The "Needs attention"
section lists tasks that ended `UnmetCriteria` (per the autonomy pivot, TASK-105) — a
read-only surface, **not** an approval queue. Relates to `ui-roadmap` and
`ui-redesign-decisions`.

**How we'll know it's done.** *Manual:* `/board` columns are the canonical
`deriveTaskStatus` set with projection-backed cards and no `runId`, responsive even
with Temporal degraded; `/` is a factory overview with a working Needs-attention list;
`/tasks` still does search/sort/filter. *Unit:* board columns and table rows derive
status from the single shared function.

### [ ] TASK-84: Repositories registry + Repository Detail (health, commands, policies, activity, scoped usage)

**What's wrong.** The registry is fine but lives at `/` (`App.tsx:19`); once Overview
takes `/`, it needs its own `/repositories` path. Repository Detail exists
(`RepositoryDetailPage.tsx`, param named `:id` at `App.tsx:20`) but is thin: it does
not surface repository health, discovered build/test/lint commands, policies, activity,
or scoped usage — even though that data is modeled (snapshot `units/commands/services/
qa_surfaces/facts`) and `getRepositoryCommands` exists but is **unrouted**.

**What to do.** Give the registry its own `/repositories` route (list: name, path,
origin, default branch, trust state, health, running/awaiting/failed task counts, last
activity, scoped token usage, last successful delivery). Expand Repository Detail to
answer "is this repo ready for autonomous work, and what's happening in it?": header
with health + trust + default branch + origin + last sync + primary **Create task**
action; sections for Overview (metadata, health warnings, active counts, recent
failures, pending approvals, recent deliveries, usage summary), a repo-scoped Tasks
table (reuse TASK-83's table on the projection), **Commands & environment** (build /
test / lint / package manager / workdir / detected tooling / last validation — surface
the unrouted `getRepositoryCommands`), **Policies** (trust level, shell/network perms,
protected paths, git/delivery perms, human-gate policy, token/runtime limits), and
**Activity** (tasks/retries created, approvals, candidate commits, PRs, syncs, policy
changes). Replace a generic "Approve" with a precise label (Trust repository / Approve
write access). Keep the add-repository flow a simple path input + validation — **no
wizard**.

**Where.** `apps/web/src/App.tsx:18-26` (add `/repositories`, fix `:id`→`:repositoryId`
for consistency), `apps/web/src/pages/RepositoriesPage.tsx` +
`RepositoryDetailPage.tsx` (prototyped on `timothyshee/ui-roadmap`), a new daemon route
surfacing snapshot units/commands/services/facts (route `getRepositoryCommands`) +
repo-scoped counts from the projection. Depends on TASK-80. Relates to
`projects-registry-scope` and `enterprise-repo-handling`.

**How we'll know it's done.** *Manual:* `/repositories` lists repos with health +
scoped counts; Repository Detail shows discovered commands, policies, activity, and
scoped usage, with Create-task as the primary action.

### [ ] TASK-85: Make Settings honest — diagnostics + effective config now, daemon controls only after a config API exists

**What's wrong.** `/settings` is a self-described placeholder: it shows one stat tile
(daemon base URL from `window.location.origin`) and an "About this page" panel stating
"There is no daemon route yet to read or write persisted configuration, so this page
is a placeholder" (`apps/web/src/pages/SettingsPage.tsx:5,18-21`). We should not build
a polished **fake** config UI before a daemon configuration route exists.

**What to do.** Split Settings into explicit scopes. **Available now:** a System &
diagnostics panel (daemon / Temporal status, SQLite location + health, version, worker
status, provider connectivity, live-event connection, data freshness from TASK-80, log
locations, **read-only** effective configuration) and locally-persisted **UI
preferences** (theme, table density, default task filters, board grouping, timestamp
format, log-follow behavior). **Add later, only after the config API exists:** model
providers, default models, concurrency, token/runtime budgets, approval policies, repo
defaults, retention, delivery, notifications. Clearly label every setting as UI-local /
global-daemon / repository-specific / task-override, and do not render editable
controls for config that has no write route yet.

**Where.** `apps/web/src/pages/SettingsPage.tsx`; the diagnostics read the same
health/freshness signals used by the Overview strip (TASK-83). Depends on nothing hard
(diagnostics can precede TASK-80, but the freshness fields come from it). Relates to
`update-config`.

**How we'll know it's done.** *Manual:* Settings shows live diagnostics + read-only
effective config + UI preferences, with no editable control for any setting lacking a
daemon write route, and each control labeled by scope.

### [ ] TASK-86: Demote Evidence from primary nav → Verification inside Task Detail (compat redirect)

**What's wrong.** Evidence is a top-level sidebar page (`AppSidebar.tsx`, `/evidence` →
`EvidenceViewerPage.tsx`) that requires manual repository-id + task-id entry
(`EvidenceViewerPage.tsx:50-67`) and then shows QA media + a raw evidence-id list —
i.e. it is a single-task lookup, not a cross-task browser. Evidence is strongly
contextual (`taskId + runId + phaseAttemptId + candidateSha + environment`), so it is a
poor primary-navigation destination and belongs with the task + candidate it proves.

**What to do.** Move evidence into **Task Detail → Verification** (built in TASK-81),
remove Evidence from the sidebar, and preserve `/evidence` as a **compatibility
redirect** that routes into a task's Verification tab once a repository + task are
selected. Do **not** build a global evidence index yet — there is no demonstrated
cross-task forensic-search use case. If a global page is later justified, call it
**Verification** (unresolved/stale verification across tasks: unverified acceptance
claims, failing checks, evidence tied to superseded candidate SHAs, open high-severity
findings), not a generic media browser.

**Where.** `apps/web/src/components/layout/AppSidebar.tsx:14-20` (drop Evidence),
`apps/web/src/App.tsx:24` (`/evidence` → redirect), fold
`apps/web/src/pages/EvidenceViewerPage.tsx` into the Verification tab. Depends on
TASK-81. Relates to `observability-live-proof`.

**How we'll know it's done.** *Manual:* Evidence is gone from the sidebar, its data
lives in Task Detail → Verification keyed by candidate SHA, and hitting `/evidence`
redirects into the right task's Verification tab.

### [ ] TASK-87: Guardrails — what NOT to build (single run, no draggable board, no Jira, no premature global pages)

**What's wrong / decision.** The redesign is at risk of importing conventional
issue-tracker / multi-run orchestration concepts that contradict this system's model.
Record the explicit non-goals so they are not re-proposed:
- **No Run page and no multi-run task model.** A task has exactly one run (a storage
  boundary); the meaningful hierarchy is *beneath* it: `Task → Run → Phase Attempt →
  Agent Session → Model Invocation`. The UI hides the single run and exposes **phase
  attempts** as the execution-history unit. Do **not** add
  `/tasks/:repositoryId/:taskId/runs/:runId`. The three real distinctions stay
  visible: internal repair = **phase attempt** (same task/run, new `phase_attempts`
  row); continuation = **resume** (same workflow, session continuation — an event, not
  a retry); user retry = **Retry as new task** (new taskId/workflow/card, original
  unchanged, linked via TASK-80 lineage).
- **No draggable/kanban board.** Board columns are runtime facts derived from
  `deriveTaskStatus`, not user-editable planning states — dragging "Executing"→
  "Completed" cannot truthfully update the Temporal workflow. A draggable board is only
  appropriate if a separate durable `planningState` field is introduced, which we are
  **not** doing without a real pre-execution-planning need.
- **No Jira / external issue integration.** The board is a visualization over local
  tasks; name it **Factory Board** / **Task Board**, never "Jira".
- **No new persisted `ExecutionState` field** — build a composed view over existing
  phase attempts / sessions / condition, not another competing status field.
- **No premature global pages.** `/usage` and `/activity` come **only after** granular
  task-level attribution + retry lineage + task events are proven reliable; a polished
  aggregate over untrustworthy attribution erodes trust in the whole system. Global
  evidence page: not until a cross-task use case exists (see TASK-86).
- **No Temporal fan-out for list pages.** Overview/Board/Tasks read the
  `task_summary` projection (TASK-80) and stay responsive when Temporal is degraded;
  the live workflow stays authoritative only for mutable state,
  resume, and cancel. When Temporal is unavailable: show persisted
  state, label "Live workflow unavailable," disable resume/cancel, keep history
  accessible. When SQLite is behind: prefer live for current phase/condition/token
  total and show a subtle "Updating history" indicator — never show mismatched totals
  without explanation.

**What to do.** Treat this as a standing constraint on the Group-O tasks; call it out
in reviews if any PR reintroduces a run route, a draggable board, a competing status
field, or a global page ahead of its dependency. Sidebar stays lean initially
(Overview / Board / Tasks / Repositories / Settings, with a global **Create
Task** button in the shell — no Approvals entry per the autonomy pivot); Usage + Activity
are added later.

**Where.** Cross-cutting over Group O; no code target of its own. Relates to
`ui-roadmap` (item 10 in the plan doc), the `run-phase.ts` single-run model, and the
`lifecycle-agent-vs-mock-routing` learning.

**How we'll know it's done.** N/A — a guardrail, not a deliverable. Satisfied as long
as the shipped Group-O work honors these non-goals.


## Group P — Runtime, execution, QA & token-cost gaps

Confirmed by a full audit of `main`. Each item states whether the concern is a bug, a
missing feature, or a deliberate policy to revisit.

### [ ] TASK-89: Task Detail status/phase/condition badge does not update on WebSocket events (stale until 2s poll)

**What's wrong.** On the Task Detail page the live event *timeline* streams over the
WebSocket, but the status header (Phase / Condition / Delivery / Size / Attempt tiles)
is **not** socket-driven — it refreshes only on a 2-second `setInterval` poll. So a
phase-advance event appears instantly in the timeline while the badge **right above it**
shows the prior phase until the next poll tick. Verified: `useEventStream`'s `onEvent`
only appends to the local events array (`apps/web/src/hooks/useEventStream.ts:66`) and
never refetches task state; the header tiles read `state` from `refresh()` →
`tasksApi.getState` driven by `POLL_INTERVAL_MS = 2000`
(`apps/web/src/pages/TaskDetailPage.tsx:12,47-65,137-141`). The Tasks **list** page
does not have this bug — it wires socket events to a debounced list refetch via
`useTaskListLiveRefresh` (`apps/web/src/hooks/useTaskListLiveRefresh.ts:28-32`,
`TasksPage.tsx:69`). The asymmetry is the tell: the fix already exists on the list page
and is simply not applied on detail.

**What to do.** On Task Detail, trigger `refresh()` (a `getState` re-query) when a
relevant WebSocket event for this task arrives — reuse the `useTaskListLiveRefresh`
debounce pattern rather than inventing a new one. Keep the poll as a fallback but stop
relying on it for freshness. (Overlaps the Group-O freshness work in TASK-80; this is
the narrow, shippable UI-side fix.)

**Where.** `apps/web/src/pages/TaskDetailPage.tsx:45-65` (wire the stream to
`refresh`), `apps/web/src/hooks/useTaskListLiveRefresh.ts` (reusable debounce). Relates
to TASK-80 (freshness metadata) and the `ui-roadmap-phase0` learning.

**How we'll know it's done.** *Manual:* advance a task and confirm the Phase/Condition
badge on Task Detail updates within ~300ms (same as the timeline), not after a 2s poll.
*Unit:* a new event for the open task triggers a `getState` re-query.

### [ ] TASK-90: Browser QA never interacts — production scenario is navigate+screenshot, so broken apps pass (Sheng Ji case)

> **Now a HARD DEPENDENCY of the autonomy pivot (Group AA).** With human approval gates
> removed (TASK-104) and the loop exiting on "success criteria met" (TASK-105), interactive
> QA is the *only* thing standing between "loop declares success" and a broken app becoming
> a draft-PR marked all-claims-met. Until this lands, TASK-105's success predicate rests on
> shallow navigate+screenshot evidence. Prioritize alongside Group AA.

**What's wrong.** A run can succeed while shipping a functionally broken artifact. The
production browser-QA scenario is **hardcoded** to two liveness steps —
`{navigate '/'}` + `{screenshot 'landing'}` (`run-phase.ts:1082-1085`) — so QA only
loads the app and photographs it: it never clicks a button, never asserts an outcome.
The planner emits per-claim `expectedAssertions` describing the transitions that
*should* be observed (migration `0005_plan_expected_assertions.sql`, `plan.test.ts:69-78`),
but **no code translates those into `click`/`expectVisible`/`expectText` steps** — the
only place scenario `steps` are built is that hardcoded list. Result: if the contract
has no `qaEvidenceRequired` behavior claim, coverage passes vacuously, both liveness
assertions trivially pass, a screenshot+trace exists, no console/network error fires →
evidence is `passed` and the exercise gate clears **while the app is broken**
(a game that renders but does nothing on click sails through). This is the concrete
"Sheng Ji game does not work, yet QA passed" failure. (TASK-42's assertion-strength +
coverage machinery is genuinely implemented — `shared.ts:14-42`, `coverage.ts:35-50`,
`run-phase.ts:1148-1198` — but it is **never fed an interactive scenario**, so it can
only ever block generically, never prove the app works.)

**What to do.** Generate an **interactive** QA scenario from the planner's
`expectedAssertions`: translate each expected observation into real steps (click the
control, then `expectVisible`/`expectText`/`expectHidden` on the outcome) so QA drives
the behavior the claim asserts. Feed `scenarioStrength` (`shared.ts:40-42`, today only
used in tests) into the gate so an all-liveness scenario is treated as **weak** and
cannot pass a behavior claim. Relates to but is distinct from TASK-63/TASK-75 (those
concern the gate's diff/claim wiring and repair-routing; this concerns the scenario
being non-interactive in the first place).

**Where.** `workers/temporal-worker/src/activities/run-phase.ts:1082-1085` (build steps
from `expectedAssertions`, not a fixed list), `packages/qa/src/shared.ts:40-42`
(`scenarioStrength` into the gate), `packages/qa/src/coverage.ts`. Relates to TASK-42,
TASK-63, TASK-75 and the `qa-static-checks-miss-runtime-bugs` learning.

**How we'll know it's done.** *Unit:* a contract with a behavior claim produces a
scenario containing at least one `click` + one strong assertion derived from
`expectedAssertions`; an all-liveness scenario is scored `weak` and blocks the claim.
*Manual:* re-drive the Sheng Ji game and confirm QA actually plays a hand (clicks,
asserts a rank beats another) and **fails** when the app is broken.

### [ ] TASK-91: Browser QA has no socket-leak / duplicate-connection / repeated-click detection (comments claim it does)

**What's wrong.** The specific "clicking Join twice opens multiple WebSockets" bug is
not detectable today. `browser-qa.ts` and `shared.ts` **explicitly do not inspect the
transport** (`browser-qa.ts:41-49`, `shared.ts:47-49`) — there is no WebSocket
inspection, no connection counting, no repeated-click idempotency step, no socket
assertion. Worse, several comments **claim** socket-leak detection exists —
`browser-qa.ts:172` ("socket leaks as real failing assertions"), `run-phase.ts:1152-1156`
("reports whether it saw a leaked/duplicate WebSocket open") — but the actual predicate
`policyBlockingErrorsPresent` is purely `consoleErrors.length > 0 || failedRequests.length > 0`
(`shared.ts:51-56`). So a silent duplicate socket that throws no console/network error
produces no symptom and passes. The misleading comments are themselves a hazard (they
imply a guarantee that does not exist).

**What to do.** Either (a) add real transport inspection — count WebSocket opens per
control interaction (Playwright can observe `websocket` events) and assert idempotency
(clicking "Join" twice must not open a second socket), plus a repeated-click step in the
interactive scenario from TASK-90 — or (b) if transport inspection stays out of scope,
**delete the false comments** and stop claiming socket-leak coverage. Prefer (a); at
minimum do (b) so the code does not lie about its guarantees.

**Where.** `packages/qa/src/browser-qa.ts:41-49,172-180`, `packages/qa/src/shared.ts:47-56`,
`workers/temporal-worker/src/activities/run-phase.ts:1152-1156`. Depends on TASK-90 (the
interactive scenario that would carry the repeated-click step). Relates to the
`qa-static-checks-miss-runtime-bugs` learning.

**How we'll know it's done.** *Unit:* a scenario that double-clicks a control opening a
socket fails on a duplicate-connection assertion. *Manual:* the double-"Join" case is
caught. If (b) only: no comment in the QA path claims socket detection that isn't
implemented.

### [ ] TASK-92: OpenCode "fix en masse" — a per-file parallel bulk-fix execution mode

**What's wrong / the opportunity.** Every runtime today is strictly one-agent-per-task,
one session over the whole change (shared `CliStreamAdapter`, single `opencode run` per
session, `opencode-adapter.ts:84-89`). There is **no** mode that fans a job out across
many files independently in parallel. But a real dogfood win is exactly that shape: for
a PR needing hundreds of test fixes, dumping the whole failure list to one strong model
is lossy, whereas one-file-at-a-time in a loop, in parallel, with a small local model,
produced hundreds of minimal correct fixes overnight:

```
cat failing_tests.txt | xargs -P 5 -I {} bash -c \
  'opencode run --model "ollama/qwen3-coder:30b" --agent "python-pro" "<fix instruction> in {}"'
```

The paradigm — per-file scoping = minimal, non-lossy changes; parallelism = throughput;
local model = zero API cost — is more effective for mechanical mass-fixes than a single
whole-repo session.

**What to do.** Add a **bulk-fix execution mode**: given a list of targets (files /
failing tests), fan out N independent OpenCode invocations in parallel (bounded
concurrency, like `-P 5`), each scoped to one target with a per-file prompt, each a
fresh short session — not one session over everything. Reuse the existing OpenCode
adapter (`--model`, `--dir`, capability agent file); add the fan-out orchestration + a
concurrency cap + per-target result collection above it. Pairs with TASK-93 (named
`--agent` persona, e.g. `python-pro`) and TASK-94 (per-phase/general model routing).

**Where.** New orchestration above `packages/agent-gateway/src/opencode-adapter.ts`
(the single-invocation adapter is the unit of work); a new worker activity / CLI mode
for the fan-out + concurrency bound + result aggregation. Relates to
`full-daemon-pi-delivery`, `external-tools-model-agnostic`, and the
`fender-worktree-validation-recipe` learnings.

**How we'll know it's done.** *Manual:* point the bulk mode at a list of N failing test
files and confirm it runs bounded-parallel OpenCode invocations (one per file), each
making minimal scoped changes, and reports per-file outcomes — reproducing the
overnight `xargs -P` result inside the workbench.

### [ ] TASK-93: OpenCode named `--agent` persona is a capability hash, not a chooseable persona (e.g. `python-pro`)

**What's wrong.** The OpenCode `--agent` flag is set, but the agent name is a **SHA1
hash of the granted capability set** (`opencode-adapter.ts:35`, `awb-<hash>`), and the
materialized agent file is a permission block only — no persona prompt, no model, no
skill list (`opencode-tools.ts:106-119`). So there is no way to select a named OpenCode
persona like `python-pro` per task/phase. The bulk-fix win in TASK-92 depended on
exactly that (`--agent "python-pro"`).

**What to do.** Allow a per-task/per-phase **named persona** to be passed through to
`--agent` (either a user-authored OpenCode agent name that already exists in the user's
config, or a workbench-materialized persona file that layers a role prompt on top of
the capability permission block). Keep the capability-scoped permission block; add the
persona selection on top.

**Where.** `packages/agent-gateway/src/opencode-adapter.ts:31-45,83-84`,
`packages/agent-gateway/src/opencode-tools.ts:106-119`, config plumbing in
`runtime-profile.ts:158-159`. Relates to TASK-92 and the `runtime-profile-architecture`
learning.

**How we'll know it's done.** *Manual:* a task can specify an OpenCode persona and the
spawned `opencode run` uses `--agent <that persona>`, verifiable in the argv.

### [ ] TASK-94: General cross-runtime per-phase model routing + call-count reduction

**What's wrong.** Two related cost levers are only partly built. (1) **Routing:** the
`modelForPhase(phase, config)` hook is generic (`runtime-profile.ts:90`) but **only Pi**
actually varies model by phase (`pi-adapter.ts:25-32`); Claude/Codex/OpenCode ignore the
phase and return flat `config.model` (`runtime-profile.ts:118,129,158`). There is a
separate cheap Haiku size-classifier (`size-classifiers.ts:14`) but no general "cheap
model for simple phases, strong model for hard phases" policy across runtimes. (2)
**Call count:** each phase is a fresh Activity + fresh adapter + fresh session; the only
reuse is per-slice **retry** resume, which skips re-sending context
(`run-phase.ts:826-865`, `claude-adapter.ts:313-318`). No batching, dedup, response
cache, or phase-collapsing exists.

**What to do.** (1) Give the workbench a runtime-agnostic per-phase model policy (e.g. a
default routing table consulted when a profile doesn't override), so a cheap model can
be selected for light phases and a strong one for heavy phases on **any** runtime — not
just Pi. (2) Reduce calls: evaluate resuming a single agent session across consecutive
phases where safe (instead of a cold session per phase), and adding provider
cache-control breakpoints rather than only passively reading back `cachedInputTokens`.
Sequence behind TASK-79 (measure first — which phases actually cost the most) so the
routing table is driven by real per-phase spend, not intuition.

**Where.** `packages/agent-gateway/src/runtime-profile.ts:90,118,129,158`
(`modelForPhase`), `workers/temporal-worker/src/activities/run-phase.ts` (session
create-vs-resume per phase), `packages/agent-gateway/src/claude-adapter.ts:313-336`
(cache-control). Depends on TASK-79 for the spend ranking. Relates to
`group-e-token-memory-graph` and `group-b-planning-discipline` (Haiku classifier) learnings.

**How we'll know it's done.** *Writeup + change:* a per-phase routing policy that
applies to ≥2 runtimes, plus a measured reduction in either model calls or tokens on a
real run vs. the current fresh-session-per-phase baseline.

### [ ] TASK-95: Token-output compression + evaluate a token-saving proxy (RTK / Caveman / Headroom)

**What's wrong.** The token-cost finding is documented — cost is dominated by
in-session accumulated context, and the recommended lever is to **compress tool-result
output before it re-enters context** (`docs/token-cost-measurement.md:43-76,97-104`) —
but the compression is **not implemented**: `command-runner.ts:85-108` accumulates
stdout/stderr verbatim with no truncation/summarization/byte cap. RTK / Caveman are
named only as a *technique* in that doc (`:72-76`), explicitly noting the personal RTK
shell hook "never intercepts SDK-driven agents," so nothing token-reducing is wired into
the agent path. The operator also wants to evaluate external token-savings utilities and
have them apply **during workbench runs** (the agent sessions the workbench spawns), not
just the operator's own Claude Code session.

**What to do.** (1) Implement tool-output compression in the execution path: cap/clip
large stdout/stderr, summarize or head/tail truncate, and elide repeated output before
it re-enters model context. (2) Investigate the external token-savings utilities and
whether any can be wired into workbench-spawned agent sessions in a **model-agnostic**
way (per the `external-tools-model-agnostic` learning) — candidates:
`https://github.com/rtk-ai/rtk`, `https://github.com/juliusbrussee/caveman`,
`https://github.com/chopratejas/headroom`. Note the SDK-agent interception limitation up
front (a shell-hook proxy won't catch the Claude SDK path). Measure the before/after on
real runs (fold into TASK-79).

**Where.** `packages/execution/src/command-runner.ts:85-108` (the compression seam),
`docs/token-cost-measurement.md:97-104` (the spun-out task it anticipates), a short
evaluation writeup in `docs/`. Depends on / feeds TASK-79. Relates to
`group-e-token-memory-graph`.

**How we'll know it's done.** *Unit:* large tool output is compressed/capped before it
enters context (assert a byte/line bound). *Writeup:* a keep/decline call on each of RTK
/ Caveman / Headroom for workbench-run use, with a measured token delta on a real run.

### [ ] TASK-96: Provider-neutral model endpoint — point the Claude path at an alternate online provider without code changes

**What's wrong.** Backend runtime + model + binary are env-swappable
(`AWB_AGENT_RUNTIME`/`AWB_AGENT_MODEL`/`AWB_AGENT_BINARY`, `agent-factory.ts:21-44`), but
"provider" there means which local CLI/SDK backend — **not** an online API endpoint.
The Claude adapter calls the Anthropic SDK `query()` directly with no `env`/base-URL/
endpoint override (`claude-adapter.ts:320-335`), so repointing it at a different online
or OpenAI-compatible provider requires code changes. There is no base-URL seam and no
OpenAI-compatible client in the agent path (the one direct HTTP-to-model call is the
local Ollama shadow classifier). This blocks "switch online providers without rebuilding
the workflow."

**What to do.** Add a provider/base-URL seam to `RuntimeConfig` (still credential-free —
credentials stay in ambient env) so the Claude/SDK path (and, where relevant, the CLI
adapters) can be pointed at an alternate endpoint via config/env without editing adapter
code. Confirm the SDK actually honors a base-URL override before committing to the seam;
if it does not, document the constraint and scope this to the runtimes that do.

**Where.** `packages/agent-gateway/src/runtime-profile.ts:24-35` (`RuntimeConfig`),
`packages/agent-gateway/src/claude-adapter.ts:320-335`,
`workers/temporal-worker/src/activities/agent-factory.ts:37-44`. Relates to
`runtime-profile-architecture` and `external-tools-model-agnostic`.

**How we'll know it's done.** *Manual:* set a provider/base-URL via env/config and drive
a phase against an alternate endpoint with **no** adapter code change (or a documented
statement that the SDK cannot be repointed, scoping the seam to the CLI runtimes).

### [ ] TASK-97: Revisit the no-subagent policy for OpenCode / Pi (currently denied by design)

**What's wrong / the decision to weigh.** Subagents are **deliberately denied** in every
runtime today: the Claude SDK tool set excludes `Task` (`capability-tools.ts:15-23`),
OpenCode's `task` tool is always set to `deny` ("the workbench grants no subagent or
external-research capability," `opencode-tools.ts:83-84`, asserted in
`opencode-tools.test.ts:25`), and Pi's `--mode json` path has no subagent tool
(`pi-tools.ts:13-16,70-72`). The operator wants to evaluate **integrated subagent
functionality** (OpenCode) and **Pi subagent customization** — which is a reversal of a
standing policy, not a bug fix, and must be treated as such.

**What to do.** Evaluate enabling scoped subagents for OpenCode and Pi specifically,
weighing the tradeoffs the current denial exists to avoid: the escape-tool boundary
(subagents/Task were denied partly because a shell-capable delegated tool can bypass a
read-only stage — see the `monitor-tool-escapes-readonly-deny` learning), capability
containment (a subagent must inherit, not widen, the parent role's permission block),
determinism/observability (nested sessions must still emit semantic events + token
attribution), and cost. Output a keep-denied / enable-scoped decision per runtime; only
implement if the containment story is airtight. Do **not** enable subagents as a side
effect of another task.

**Where.** `packages/agent-gateway/src/opencode-tools.ts:83-84`,
`packages/agent-gateway/src/pi-tools.ts:13-16,70-72`,
`packages/agent-gateway/src/capability-tools.ts:15-23`; a short decision writeup in
`docs/`. Relates to `monitor-tool-escapes-readonly-deny`, `skill-delivery-prompt-injection`,
and `runtime-profile-architecture`.

**How we'll know it's done.** A per-runtime (OpenCode, Pi) keep-denied / enable-scoped
decision backed by the containment/escape-boundary analysis; if enabled, a scoped
subagent inherits (never widens) the parent capability block and still emits events +
token attribution, proven by a test.

### [ ] TASK-98: External token-usage reporting across repos & tasks (Claude-Code-driven)

**What's wrong.** The token data exists in SQLite — `model_invocations` (per-invocation
tokens + cost), `runtime_attribution` (12 buckets), `context_composition` (8 buckets),
and `tokenBreakdown`/`runtimeAttribution` already on the task-detail wire — but there is
no **cross-repo / cross-task** aggregation and no external report. The operator wants to
use Claude Code to build external reporting on token usage across repos and tasks (a
standalone report/artifact), beyond the in-app per-task Usage view.

**What to do.** Build a cross-repo/cross-task token aggregation read path (sum by repo,
by task, by model, by phase, by outcome; include the retry-lineage rollup from TASK-80)
and a way to emit it as an external report artifact that Claude Code can generate on
demand (e.g. a query surface + a report template). This is the aggregate layer that the
Group-O global `/usage` page (deferred until granular usage is trustworthy) would also
consume — build the query/report first so the numbers are validated before any global
page renders them. Sequence after TASK-79 (which establishes trustworthy per-run spend)
and alongside TASK-81 (task-level Usage) / TASK-80 (projection + lineage).

**Where.** New aggregation queries in `packages/database/` over `model_invocations` /
`runtime_attribution` / `context_composition`, a daemon route or CLI export, a report
template in `docs/` or `scripts/`. Depends on TASK-79/TASK-80/TASK-81. Relates to
`ui-roadmap`, `graph-engineering-five-planes`, and `token-cost-measurement`.

**How we'll know it's done.** *Manual:* generate an external report showing token
spend broken down across ≥2 repos and their tasks (by model/phase/outcome, with retry
lineage rolled up), from the durable data — not a live Temporal fan-out.


### [ ] TASK-101: One-command local containerization (Dockerfile + compose) — Temporal + daemon + worker + web

**What's wrong.** There is no deployment / easy-setup path on `main`. Docker/compose
exist **only under `archive/`** (the retired v4 system:
`archive/agentic-development-task-system-v4__ai/Dockerfile` + `docker-compose.yml`) —
the live app has **none**. Today setup is manual and multi-step: run
`temporal server start-dev` then `awb up` (README.md:157,179), with a local
SQLite-backed Temporal server (`AGENTS.md:37`). A new machine / new contributor has to
assemble the runtime by hand.

**What to do.** Provide a **local** containerized setup: a Dockerfile (or a small set)
plus a `docker-compose.yml` that brings up the whole stack — local Temporal, the daemon,
the temporal-worker, and the web app — in one command, mirroring what `awb up` wires
today. Keep it reproducible and self-contained for a single developer machine.

> **Scope guard — stay inside the design invariant.** `AGENTS.md:162` explicitly says
> *"Don't add a vector database, Kubernetes, Postgres, Redis, or a message broker —
> this is a single-developer-machine tool by design."* So this task is **local
> containerization only**: compose for one-command local dev, no Kubernetes, no
> managed cluster, no Postgres/Redis swap-in (Temporal stays local SQLite-backed). A
> real cluster deployment would first require amending that invariant — out of scope
> here.

**Where.** New `Dockerfile`(s) + `docker-compose.yml` at repo root (do **not** copy the
`archive/` v4 versions blindly — they predate the current package layout); wiring must
match the current `awb up` boot (`apps/cli/src/commands/lifecycle.ts`) and the
pnpm-workspace build. Relates to the `boot-stale-dist-symlink` and
`worktree-build-loop-db-migrations` learnings (fresh env needs `pnpm install` + dist
build in dep order).

**How we'll know it's done.** *Manual:* on a clean checkout, `docker compose up` brings
the full stack healthy (Temporal + daemon + worker + web) and a task can be driven end
to end — with no manual `temporal server start-dev` / `awb up` sequence — and **no**
Kubernetes/Postgres/Redis introduced.


### [ ] TASK-102: A `grill-me` skill that adversarially stress-tests the plan/contract before implementation

**What's wrong.** The lifecycle gates review a plan for completeness (specify contract
gate, plan approval), but there is no artifact that **adversarially grills** the plan —
poking at hidden assumptions, missing edge cases, under-specified acceptance criteria,
and "what would make this wrong?" — *before* code is written. The closest existing
things are the `dg` skill (adversarial *code* review, post-hoc) and the agent's own
self-review during `challenge` (also over produced code). Neither pressure-tests the
**plan** itself at the point it is cheapest to fix. This is upstream of TASK-61 (which
*measures* whether program-design helps) — grilling is a concrete technique that could
be what program-design *does*.

**What to do.** Author a `grill-me` skill (reference the grilling SKILL pattern:
`https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md`)
that takes a plan/contract and interrogates it: surfaces unstated assumptions, asks for
the failure mode of each step, checks that every acceptance claim is falsifiable and
QA-observable (ties to TASK-90's interactive-scenario need), and flags scope the plan
silently expands or omits. Output is a findings list the operator (or the workbench's
plan/program-design phase) can act on before implementation. Keep it model-agnostic per
`external-tools-model-agnostic`.

**Where.** A new skill under `.claude/skills/grill-me/` (sibling to `implement-feature`
/ `run-workbench-task`); optionally invocable from the `plan` / `program-design` phase
prompt. Relates to TASK-61/TASK-52 (program-design value), TASK-90 (falsifiable claims),
the `dg` skill, and `group-b-planning-discipline`.

**How we'll know it's done.** *Manual:* run `grill-me` on a real plan and confirm it
surfaces concrete, actionable gaps (assumptions/edge-cases/unfalsifiable claims) that a
completeness check would pass over.

### [ ] TASK-103: `awb task list` shows the raw prompt, not a readable name/summary

**What's wrong.** `awb task list` prints `taskId · repositoryId · createdAt · prompt`
(`apps/cli/src/commands/task.ts:138`) — the full raw prompt, which is long and hard to
scan; there is **no** task name or short summary. Tasks on `main` have no title/name
concept at all (the prompt is the only human-facing text). So the CLI can't give a
quick, legible roster of what's in flight.

**What to do.** Give tasks a readable **name/summary** and surface it in `awb task list`
(and `task show`): either a first-sentence/slug-derived title (cheap, no model) or a
short generated summary, displayed instead of — or alongside a truncated — prompt.
Prefer sourcing it from the same title field the Group-O foundation introduces
(TASK-80's `task_summary`; the unmerged `0007_task_title_lineage` migration on
`timothyshee/ui-roadmap` already adds a task title), so the CLI and web agree on one
name. Minimum viable: truncate the prompt to one readable line + derive a slug title.

**Where.** `apps/cli/src/commands/task.ts:101-142` (the `list` printout at `:138`) and
`:145` (`show`); the title field from TASK-80 / `packages/domain/src/tasks.ts`. Depends
on / relates to TASK-80 (shared title/summary in the projection). Relates to the
`tasks-ui-redesign` learning.

**How we'll know it's done.** *Manual:* `awb task list` shows a scannable name/summary
per task (not the full raw prompt), consistent with what the web UI displays.


## Group Q — UI-building skills

### [ ] TASK-99: A `build-ui` skill for beautiful greenfield UIs — invoked only when building from scratch, not when editing

**What's wrong.** There is no skill that helps build polished UIs. The existing skills
are `implement-feature` / `run-workbench-task` (task driving) and the worktree helpers —
none carry UI/design craft. When the workbench (or the operator) builds a frontend from
scratch, there is no design-system-aware guidance to make it look good, and no scoping
rule to keep such guidance **out** of routine edits to an existing frontend (where it
would fight the established style).

**What to do.** Author a `build-ui` skill focused on greenfield UI quality: layout,
type scale, spacing, color/token discipline, light/dark, responsive rules, and a
component-kit-first approach. **Scope it tightly** with a clear trigger rule: invoke
**only when building a UI from scratch**, and explicitly **do not invoke when merely
updating/extending an existing frontend** (match the existing style instead). Reuse the
built-in `artifact-design` / `dataviz` guidance where applicable rather than duplicating
it. Investigate whether the `design.md` pattern (TASK-100 research item) makes the
output meaningfully better and, if so, fold its approach in.

**Where.** A new skill under `.claude/skills/build-ui/` (or the plugin's skills), sibling
to `implement-feature`. Relates to the Group-O UI redesign, the `ui-redesign-decisions`
learning, and the `design.md` research item in TASK-100.

**How we'll know it's done.** *Manual:* the skill fires when a from-scratch UI is
requested and is (correctly) **not** used for an edit-existing-frontend task; a
from-scratch page built under it reads as visually coherent (tokens, light/dark,
responsive) without hand-holding.

> **Deferred / likely out-of-repo — a Klaviyo Fender / Ascent component skill.** The
> operator also wants a Fender-specific skill wiring the Ascent component design library
> (with the insight that *incorrect component usage may signal the components' own docs
> aren't agent-parsable*, and a question of Chrome-DevTools-MCP screenshots vs. a
> `design.md`). This is **Klaviyo-Fender-specific**, not agent-workbench code, so it
> most likely belongs in the operator's Klaviyo tooling (alongside the existing
> `fender`/`pr-*` skills), not here. Noted so it isn't lost; not filed as an
> agent-workbench task unless the workbench is meant to host cross-repo UI skills.


## Group R — Investigate / research (external references)

Reference items to evaluate against the workbench. Each is a **read + short writeup +
decision** (adopt / steal-one-idea / decline), not a build task on its own. Where a
finding turns into work, spin it into a numbered task.

### [x] TASK-100: Evaluate external agentic-framework / memory / tooling references

**What to do.** Read each reference, decide what (if anything) the workbench should
steal, and record the call + which existing task/learning it maps to. Do **not** adopt
wholesale — the workbench already has strong opinions (five-plane architecture, no
draggable board, deliberate no-subagent policy, project-memory-as-markdown).

- **Vibe Kanban** (board/orchestration UI) — mostly **already covered**: the Group-O
  board (TASK-83) is a read-only `deriveTaskStatus`-driven board; a drag-to-plan kanban
  is explicitly declined (TASK-87). Question to answer: does Vibe Kanban surface anything
  our board omits *other than* draggability (e.g. multi-agent orchestration views)?
- **ruflo** — `https://github.com/ruvnet/ruflo` — orchestration/workflow patterns; compare
  to our Temporal + phase model.
- **Agentic frameworks 2026 survey** —
  `https://blog.jetbrains.com/pycharm/2026/06/top-agentic-frameworks-for-building-applications-2026/`.
- **"Build a software factory with Claude Code"** —
  `https://www.freecodecamp.org/news/how-to-build-software-factory-with-claude-code/` —
  compare to our control-plane framing (Group O).
- **Memory-OS (6-layer memory on Hermes)** —
  `https://www.marktechpost.com/2026/06/01/meet-memory-os-...` — map against ADR-009
  (markdown memory, declined AgentMemory) + `graph-engineering-five-planes` /
  `project-memory-design`.
- **LLM Wiki v2 (extends Karpathy's LLM Wiki with agentmemory lessons)** —
  `https://share.google/eu7cbvlrJGqrJKVDy` — Karpathy's note is already our reference
  architecture; capture what v2 adds.
- **open-interpreter** — `https://github.com/OpenInterpreter/open-interpreter`.
- **open-agents.dev** — `https://open-agents.dev/`.
- **auto-memory ("I wasted 68 min/day re-explaining my code")** —
  `https://share.google/oXjo34ahE29NMPYaE` — relates to the auto-memory pattern +
  `project-memory-design`.
- **autoagent memory** — `https://github.com/hkuds/autoagent` (read its memory design).
- **AnythingLLM memory** — read for ideas only. Its memory is a **vector-store RAG**
  approach, which conflicts with the `AGENTS.md:162` "no vector database" invariant and
  ADR-009 (markdown memory, repo-is-truth, memory invalidated against the repo — never
  the reverse). Standing bias: **steal an idea at most; do not adopt the vector-DB
  dependency.** Replacing our markdown memory with it would require reopening ADR-009
  first — not filed as a build task.
- **design.md** — `https://github.com/google-labs-code/design.md` and
  `https://getdesign.md/linear.app/design-md` — does a `design.md` improve UI output?
  Feeds TASK-99 (`build-ui` skill) and the Group-O UI work.
- **markitdown** — `https://github.com/microsoft/markitdown` — convert docs/assets to
  Markdown; relevant to context ingestion (cf. the Karpathy-PDF-via-pdfminer note in
  `group-e-token-memory-graph`).
- **"MCP server that made developers faster"** —
  `https://medium.com/@himanshusingour7/...` — MCP-server patterns; relates to the
  MCP-token-savings ask (TASK-95).
- **Sandcastle** — sandboxing / isolation approach; compare to our capability-broker +
  worktree confinement + `native-trusted` (NOT a hostile-code sandbox, `AGENTS.md`
  known-gaps) and the `monitor-tool-escapes-readonly-deny` learning.
- **Conductor (conductor-oss)** — `https://github.com/conductor-oss/conductor` —
  workflow orchestration engine; compare to our Temporal + deterministic-workflow phase
  model. Bias: we already committed to Temporal; look for ideas, not a swap.
- **Self-built observability writeup** —
  `https://doneyli.substack.com/p/i-built-my-own-observability-for` — compare to our
  observability (`packages/telemetry` OTel spans + `packages/database`
  `runtime_attribution`/`context_composition`,
  trace-per-run); relates to TASK-79 and the `observability-live-proof` learning.
- **SQLite vs Beads** — investigate Beads as an alternative to our SQLite store. Bias:
  SQLite-as-single-writer (daemon-owned) is a firm invariant (`AGENTS.md`); "no Postgres/
  vector DB/etc." (`AGENTS.md:162`). Read for ideas; a store swap would reopen a core
  decision.
- **turbovec (vector search)** — `https://github.com/RyanCodrai/turbovec` — same
  caveat as AnythingLLM: vector search conflicts with the `AGENTS.md:162` "no vector
  database" invariant. Read for ideas only; do not adopt the dependency.
- **ByteByteAI agentic reference** — a survey of patterns to grade ourselves against:
  context engineering (budgeted context windows, layered memory, compression/
  summarization → TASK-95; retrieval/lazy loading → TASK-74 blast-radius), skills as
  reusable/composable workflows (→ our skills + TASK-99/dogfood), MCP & agentic tooling
  (browser automation, self-correcting loops → QA TASK-90/91), subagents/agent-teams
  (→ TASK-97 no-subagent policy), parallel development (worktree isolation, concurrent
  testing → TASK-92 bulk-fix, `parallel-fanout-rebase-conflict`), long-running agent
  workflows (→ Temporal). Map each pattern to have/gap.
- **microsoft/agent-framework** — `https://github.com/microsoft/agent-framework`.
- **deep-agents-from-scratch** — `https://github.com/langchain-ai/deep-agents-from-scratch`.
- **Google ADK** — `https://google.github.io/adk-docs/`.
- **Clinical image de-identification tutorial** —
  `https://www.freecodecamp.org/news/build-ai-image-de-identification-for-clinical-research/`
  — an unrelated domain build (medical imaging), not a workbench feature; keep as a
  reference to read only unless a concrete workbench use emerges.

**Where.** Research only; writeups land in `docs/` (or the relevant ADR under
`docs/decisions/`). Each adopted idea spins into a numbered task. Relates to
`graph-engineering-five-planes`, `project-memory-design`, `ui-redesign-decisions`,
and ADR-009.

**How we'll know it's done.** A short note per reference with an adopt / steal-idea /
decline call, and any adopted idea promoted to its own task.

> **Done.** TASK-100's review surfaced the candidate tasks below (TASK-116..122);
> everything else was `decline` / `reference-only` (covered by an existing invariant,
> task, or learning, or conflicting with no-vector-DB / SQLite-single-writer /
> no-subagent / read-only-board).

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
already have the stacked-PR DAG for decomposition via `decompose-into-dag`/TASK-51; the
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
