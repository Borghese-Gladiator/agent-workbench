# Activities — `workers/temporal-worker/src/activities/`

This is where **all I/O-bearing work happens**. Temporal Workflow code
(`@awb/workflow`) must stay deterministic, so every filesystem / git / process /
network / agent call lives here, behind an Activity. `runPhase` is the one
Activity the `TaskWorkflow` calls per lifecycle phase; everything else in this
directory is support it composes.

Read this map first, then the target module — each module carries its own
top-of-file docblock explaining the *why*.

## The hub

- **`run-phase.ts`** — the `runPhase` Activity itself (the 800-line hub the
  legibility audit flags). Resolves the runtime profile, builds a `PhaseContext`,
  and dispatches each `TaskPhase` (specify → plan → program-design → implement →
  verify → exercise → challenge → deliver → release) through the driver. Also owns
  the mock↔real fork: mock returns scripted offline results, the real path calls
  the support modules below. `computeRealPrepareInputs` (worktree + commands + memory)
  lives here.
- **`phase-driver.ts`** — the per-invocation `PhaseContext` and the drive loop that
  runs an agent session, records usage/observability, evaluates completion via
  `evaluatePhaseCompletion`, and routes the loop. The seam that keeps `run-phase.ts`
  from being one giant function.
- **`agent-factory.ts`** — resolves `AWB_AGENT_RUNTIME` → adapter + `RuntimeProfile`
  (mock by default; an unknown value degrades to mock). The one place a runtime
  string is read. See TASK-38 for the profile-driven gate.
- **`index.ts`** — the Activity barrel: re-exports `runPhase` and `discoverRepository`.
- **`discovery-support.ts`** — the `discoverRepository` Activity behind
  `RepositoryDiscoveryWorkflow`; delegates the snapshot write to the daemon.

## Run state (survives worker restarts)

- **`run-state-store.ts`** — `RunStateStore` seam + `TaskRunState` (contract, plan,
  program design, candidate/base SHA, evidence) accumulated across phase calls.
- **`sqlite-run-state-store.ts`** — the durable `RunStateStore`: read-only DB handle
  for reads, daemon POST for writes (single-writer invariant). A restart mid-task
  resumes with the real state instead of an empty map.

## Per-phase support (the real, non-mock work each phase delegates to)

- **`contract-support.ts`** — specify: builds the deterministic draft `TaskContract`
  (objective + falsifiable correctness/behavioral claims) from the task prompt.
- **`classifier-support.ts`** / **`size-classifiers.ts`** — specify: task-size
  classification. `size-classifiers.ts` holds the two sibling classifiers
  (authoritative Claude/Haiku + local Ollama shadow); `classifier-support.ts`
  decides when to run each and records the comparison. Shadow is observe-only.
- **`plan-support.ts`** — plan: the planner instruction and the plan-JSON parser.
- **`program-design-support.ts`** — program-design (L tasks): the instruction and
  parser for the bodyless file-tree + signatures artifact fed to the builder.
- **`builder-support.ts`** — implement: one real builder attempt for a plan slice
  (run session in the worktree, detect a meaningful diff, commit, report HEAD SHA).
- **`worktree-support.ts`** — prepare: materializes the real git worktree + task
  branch off the repo's default branch.
- **`command-support.ts`** — resolves/install/verify/start/review-diff commands for
  the worktree; installs deps into a fresh worktree (a real live-run blocker).
- **`memory-support.ts`** — the read side of project memory: fetches the facts most
  useful to the next implementation and shapes them for the planner/builder context.
- **`delivery-support.ts`** — deliver: `owner/repo` parsing, GitHub token/ref
  resolution, and the real delivery client wiring.
- **`browser-qa-support.ts`** — exercise: URL-readiness probing (localhost/IPv6
  quirks) so the browser QA executor drives the dev server once it's actually up.
- **`qa-media-support.ts`** — exercise: posts branch-committed QA media (video/trace)
  briefs so they reach the PR.

## Observability & event streams (best-effort, never load-bearing)

- **`observability-accumulator.ts`** — per-attempt accumulator for the 12
  runtime-attribution buckets; drained into a `PhaseObservability` payload.
- **`durable-event-sink.ts`** — normalizes each agent `AgentEvent` into a compact
  `SemanticEvent`, stamps a per-run sequence, POSTs to the daemon (persist + WS republish).
- **`control-plane-events.ts`** — workbench-produced lifecycle events (phase
  start/fail, retry, transport drop, session start/resume); `producer: 'workbench'`.
- **`event-sink-support.ts`** — a file-backed agent event sink under the task's
  artifacts dir, so a stalled session's raw output is inspectable after the fact.
- **`decay-metrics.ts`** — pure WSFF "decay" signals (diff size, reviewed-diff ratio,
  finding density) derived from what the challenge phase already holds.

## Guardrails

- **`slice-guardrail.ts`** — the per-slice diff cap ("amplify, don't automate"):
  forces a human checkpoint when a slice's committed diff exceeds the bound. OFF for
  mock, ON for a real-agent path.

## Rules for this directory

- Activities may do I/O; Workflow code may not. If a helper needs fs/git/process/
  network/agent access, it belongs here, not in `@awb/workflow`.
- Writes go through the daemon (single application writer). Reads may use a
  read-only DB handle. Never open a second writer here.
- An agent session returns a `PhaseAttemptResult`; it never decides a phase is done.
  Only `evaluatePhaseCompletion` (imported from `@awb/workflow`) advances a phase.
- Telemetry/events are best-effort: a dropped event or telemetry hiccup must never
  fail a phase.
