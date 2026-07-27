# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

---

## P1 — Observability follow-ups (from live run f47a0d8e, 2026-07-27)

First full-lifecycle claude run under the new OTel layer (TASK-34) succeeded end
to end (draft PR `browser-games__ai#7`) and proved control-plane events +
per-phase traces + metrics land. But looking at the traces in Tempo surfaced a
structural bug the unit tests couldn't (they assert a span exists + carries
`run_id`, never the trace *shape*).

### [ ] TASK-36: One trace per run, not one trace per phase (nested span tree)

**What's wrong.** Each phase renders as its OWN trace with a single span — a run
is 9 separate one-span traces (`phase.specify`, `phase.plan`, … each a distinct
trace id), not one trace with the phases nested under it. The Tempo waterfall for
any phase shows "1 span" and no structure, so the trace view is not actually
useful for "why did this run take so long / where did time go". Two root causes:
1. **No shared trace id across phases.** Every phase is a separate Temporal
   activity execution (`runPhase` invoked once per phase, often a different
   event-loop turn / worker), and `withSpan` (`packages/telemetry/src/spans.ts`)
   calls `tracer.startActiveSpan` with **no parent context**, so OTel mints a
   fresh random trace id per phase. In-process context propagation can't link them
   because there is no shared process context between activities.
2. **The phase span is a leaf.** The agent session + tool calls are emitted only
   as `semantic_events` rows; no OTel **child spans** are opened under the phase
   span (`run-phase.ts:1275` wraps only `drivePhase`). So even within a phase
   there is nothing to nest.

**What to do.**
1. Derive a **deterministic 16-byte trace id from `run_id`** (hash) so every phase
   of the same task lands in the same trace. Add a `withSpan` variant (or an
   option) to `@awb/telemetry` that takes `runId` and attaches a reconstructed,
   non-recording run-level `SpanContext` as the parent (build it with
   `trace.setSpanContext` on a fresh context; pass that context to
   `startActiveSpan`).
2. Optionally emit a stable per-run **root span** (`run`) once, or just parent all
   phase spans to the derived run context so they nest as siblings under one trace.
3. Open **child spans** under each phase span for the agent session
   (`session.<role>`) and, where cheap, tool calls — the builder path
   (`builder-support.ts` / `run-phase.ts` implement loop) and the QA/review paths.
   This gives the real tree: `run → phase.plan → session.planner → tool.Read …`.

**Where.** `packages/telemetry/src/spans.ts` (the parent-context variant),
`workers/temporal-worker/src/activities/run-phase.ts:1275` (parent the phase span
to the run context; open session child spans), `builder-support.ts` (tool/session
spans). Bridge ids already present (`run_id`/`task_id` on every span).

**How we'll know it's done.**
- *Unit:* a telemetry test asserting two `withSpan` calls with the same `runId`
  share a trace id (and differ across run ids), and that a child span's parent is
  the phase span.
- *Manual (live):* re-drive a task; in Tempo a single trace id covers the whole
  run, its waterfall shows `phase.*` spans nested under one root with real
  durations, and at least the builder phase has a nested `session.*` child.

### [ ] TASK-37: `awb task remove` + cascade (no CLI way to delete a task today)

**What's wrong.** There is no CLI command to delete a task — cleaning up old/failed
tasks (2026-07-27) required hand-writing DELETEs across ~15 FK-linked tables
(`tasks`, `runs`, `phase_attempts`, `agent_sessions` + its `model_invocations`/
`tool_invocations`/`context_composition`/`command_executions`, `semantic_events`,
`runtime_attribution`, `evidence` + claims/deps, `findings`, `plans` + slices/
coverage, `task_contracts` + claims, `pull_requests` + feedback, `workspace_leases`,
`waivers`, `human_decisions`, `artifacts`, `memory_sources`). `repo remove`
(`packages/repository/src/persist.ts:99`) deletes only the repo + discovery rows,
so removing a repo **orphans** its tasks rather than cascading.

**What to do.**
1. Add a daemon data-access `deleteTask(db, taskId)` that removes a task and all
   descendant rows in FK-safe order, in one transaction (mirror the cleanup script
   used on 2026-07-27).
2. Expose `awb task remove [taskId] --yes` in the CLI.
3. Make `repo remove` optionally cascade its tasks (a `--with-tasks` flag) so it no
   longer orphans them, or at least warn + list the tasks it would orphan.

**Where.** `packages/database/src/data-access/` (new `deleteTask`), the daemon
internal route + `apps/daemon` handler, `apps/cli/src/commands/` (task remove),
`packages/repository/src/persist.ts` (cascade option).

**How we'll know it's done.** *Unit:* a data-access test that `deleteTask` removes
the task + every descendant and leaves a sibling task's rows intact, with
`PRAGMA foreign_key_check` clean afterward. *Manual:* `awb task remove <id> --yes`
drops it from `task list` and the web UI with no orphaned rows.

---

## P1 — Retry resilience (from live run 5a513429, 2026-07-24)

Drove the 6-blocker deployment-hardening task on `wip-browser-games` (claude
runtime, `AWB_QA_MODE=browser`). **Plan+critic passed in ~3 min and the builder
wrote a correct fix** for blocker #1/#2 (hardcoded `localhost` → runtime
same-origin gateway derivation, in `packages/game-client/src/useGameSocket.js`).
Then the agent-SDK stream dropped (`API Error: Connection closed mid-response`)
mid-implement. Temporal retried the `runPhase` activity 3× and the whole run
failed after ~51 min — **~47 min of it wasted on retries that re-did nothing**.
Root cause is two workbench defects the transport drop merely *exposed*; the
drop itself is external (`@anthropic-ai/claude-agent-sdk/sdk.mjs` `readMessages`).
Full evidence survived in `semantic_events` (137 rows) + `agent_sessions` +
`worker.log` + the worktree diff. (The plan-phase FK crash that killed the prior
run — `persistRunStateSnapshot` inserting artifacts before their `runs`/
`phase_attempts` parents — was fixed this session and proven by this run getting
past `plan` for the first time.)

### [x] TASK-31: A cold builder session can drift into the workbench repo

**What's wrong.** Try 3's builder logged *"This is an 'agentic workbench'
project"* — it was exploring the **workbench repo itself**, not the target
`wip-browser-games`. The `cwd` passed to the SDK is actually correct
(`builder-support.ts:39` passes `worktreePath`, and the lease persisted the right
`worktree_path`), so this is not a cwd-passing bug — it's that a fresh, cold
session doing path-less discovery (`ls`, `pwd`, bare `Read`) can resolve against
the worker's `process.cwd()` (the workbench) instead of the pinned worktree. Two
silent fallbacks make this worse: `run-phase.ts:483,620` fall back to
`process.cwd()` when `worktreePath` is unset, and `run-phase.ts:540-542` silently
takes the scripted **mock** success path when `worktreePath` is undefined on the
claude runtime. (Resuming instead of cold-starting — TASK-32 — largely prevents
the drift; this task hardens the cwd guarantee regardless.)

**What to do.**
1. Pin the agent's working directory so path-less discovery cannot escape the
   worktree (e.g. pass an absolute cwd the adapter enforces; consider a sandbox/
   allowed-paths constraint so reads outside the worktree fail).
2. Remove the silent fallbacks on the real path: if `ctx.strategy === 'claude'`
   and `worktreePath` is unset, **fail loudly** (`run-phase.ts:483,620`) rather
   than defaulting to `process.cwd()`, and never fall through to the mock success
   path (`run-phase.ts:540-542`) on the real runtime.

**Where.** `workers/temporal-worker/src/activities/builder-support.ts:36-43`
(`createSession` cwd), `run-phase.ts` (`implementHandler` L513-580, cwd fallbacks
L483/L620), the adapter in `packages/agent-gateway`.

**How we'll know it's done.**
- *Unit:* a `run-phase` test asserting the real path throws/blocks (never silently
  mocks) when `worktreePath` is undefined.
- *Manual (live):* re-drive a task on `wip-browser-games`; no `producer='builder'`
  event should reference the workbench repo.
- *Regression guard:* grep the run's `semantic_events` for `producer='builder'`
  messages containing `agentic workbench` — there should be none for a task
  targeting another repo.

---

### [x] TASK-32: Agent sessions cannot resume after a transient failure

**What's wrong.** The real builder has **no resume path at all**.
`runRealBuilderAttempt` always calls `adapter.createSession(...)` fresh
(`workers/temporal-worker/src/activities/builder-support.ts:36`) and never passes
a resume/session handle. The ids that look like they'd support resume are
attribution-only: `runState.builderSessionId` (`run-phase.ts:522`) is a
regenerated `randomUUID()`, and the observability `sessionId` (`run-phase.ts:566`)
embeds `attemptNumber`. So when Temporal retries the `runPhase` activity
(`packages/workflow/src/task-workflow.ts:27`, `maximumAttempts: 3`) after a
transient drop (`API Error: Connection closed mid-response`), every attempt starts
a **cold** session and re-explores from zero — the event log shows each retry
opening with *"I'll start by exploring the repository structure"*. On run
5a513429 this wasted ~47 min across 2 retries that reproduced no new work.
This is the *per-retry* cold-start; distinct from TASK-19, which is the intended
cold-start *per plan slice*. Resume should apply to any long agent session
(builder today; planner/critic/reviewer/QA use the same adapter and would benefit).

**What to do.**
1. Give `adapter.createSession` (or a new `adapter.resumeSession`) a resume handle
   and thread it from the run-state store. The resume key MUST be stable across
   Temporal attempts — base it on `taskId + phase + slice.id`, **not**
   `attemptNumber`.
2. Persist the provider's real session/resume token (whatever the Agent SDK
   returns) in the durable run-state so a fresh activity attempt — even after a
   worker restart — can resume rather than restart.
3. Cold-start only when there is genuinely nothing to resume (first attempt, or no
   known prior session token).
4. Classify `Connection closed mid-response` as a *resumable* transport error so
   the retry resumes instead of treating it like a logic failure.

**Where.** `packages/agent-gateway` (adapter `createSession`/`resumeSession`
contract + what the Claude Code SDK exposes for resume),
`workers/temporal-worker/src/activities/builder-support.ts` (use the resume
handle), `run-phase.ts:522/566` (stable, persisted session id),
the run-state store (`sqlite-run-state-store.ts` + `run-lifecycle.ts`) so the
session token is durable, `packages/workflow/src/task-workflow.ts` (retry policy).

**How we'll know it's done.**
- *Unit:* a builder-support test that, given a persisted prior session token, calls
  the adapter's resume path (not a fresh `createSession`). Parametrize
  first-attempt (cold) vs retry (resume). A run-state test that the session token
  round-trips through SQLite.
- *Manual (live):* re-drive a task on `wip-browser-games`; if a transport drop
  occurs mid-implement, confirm in `semantic_events` that the retry **continues**
  the prior session (no "I'll start by exploring…" cold-open) and that a retry
  after a drop costs a fraction of the original attempt, not a full repeat.

---

### [x] TASK-34: Observability — control-plane events + OpenTelemetry traces/metrics/logs

**Decision recorded in ADR-008** (`docs/decisions/008-observability-split.md`):
keep `semantic_events` as the durable domain/evidence record; add OpenTelemetry as
the runtime-telemetry layer (traces, metrics, app logs) alongside it, bridged by a
shared `run_id`/`task_id`. This task is the implementation of that decision. It
subsumes the former TASK-33 (structured control-plane events) — those events land
as OTel span-events AND, where they're user-facing (a phase failing/retrying the
dashboard should show), as `semantic_events` rows.

**What's wrong today.** Two coverage gaps + one structural gap, all surfaced by run
5a513429:
- **No control-plane events.** The event pipeline
  (`durable-event-sink.ts`) only carries *agent-produced* events. The
  `EventType` enum (`packages/domain/src/events.ts:16`) has no `phase-failed`,
  `attempt-retry-scheduled`, or `transport-error`. So the `Connection closed
  mid-response` only landed in `semantic_events` as an undifferentiated `message`,
  and the **retry decision emitted nothing** to our store — it lived only as a
  `[WARN] Activity failed` line in worker stderr (Temporal's SDK logger; the app
  has no structured logger of its own).
- **No traces.** We have a flat event *stream* with a `sequence` but no span tree
  — can't see phase → session → tool-call as nested durations. The incident
  timeline had to be hand-built; a trace view gives it for free.
- **No metrics.** Cost/tokens are computed per-task on read (`getTokenBreakdown`);
  there's no time-series for retry rate, phase-failure rate, transport-drop
  frequency, or p95 phase duration across runs.

**What to do.**
1. **Control-plane events.** Add lifecycle event types (`phase-started`,
   `phase-failed`, `attempt-retry-scheduled`, `transport-error`,
   `session-started`/`session-resumed`) to `EventTypeSchema` + a `workbench`
   producer (`EventProducerSchema`). Payload: attempt number, error class, whether
   resumable, and **the cwd + session/resume key each attempt started with** (the
   exact "runtime decision" context missing from the 5a513429 write-up — see
   TASK-31/TASK-32). Emit from the control plane (`runPhase`/`drivePhase` on
   entry, catch/throw, retry boundaries) via the existing `daemon.postEvent` path
   so the dashboard + catch-up route get them for free. Best-effort — never fail a
   phase on a dropped event.
2. **OTel SDK + OTLP exporter** in worker + daemon; a leveled app logger stamped
   with `run_id`/`task_id` that **replaces raw stdout diagnostics**.
3. **Spans** at phase / agent-session / tool-call boundaries; **metrics** for
   failure rate, retry count, transport-drop frequency, p95 phase duration,
   tokens/cost.
4. **Bridge, don't merge.** Every span/metric carries `run_id`/`task_id` so a
   trace links back to `semantic_events` rows. `semantic_events`/`agent_sessions`
   stay in SQLite exactly as today — they are product data + the completion-policy
   / evidence-matrix trail (ADR-002, ADR-003), NOT lossy telemetry.
5. Ship a collector in the local stack (Tempo/Prometheus or an all-in-one), wired
   into `awb up`.

**Where.** `packages/domain/src/events.ts` (enums + payloads), a shared
`packages/telemetry` (OTel init + logger), worker + daemon bootstrap,
`run-phase.ts`/`phase-driver.ts` (emit events + open spans),
`apps/daemon/src/routes/internal.ts` (`/internal/events` already persists +
republishes — no change), `apps/web` (render new event types on the timeline),
`apps/cli` (`up` boots the collector).

**How we'll know it's done.**
- *Unit:* domain schema test for the new event types/payloads; a phase-driver test
  asserting `phase-failed` (+ `attempt-retry-scheduled` when attempts remain) is
  emitted when a phase throws; a telemetry test that a span carries `run_id`.
- *Manual (live):* force/await a transport drop, then
  `SELECT type, payload_json FROM semantic_events WHERE run_id=… AND type IN
  ('phase-failed','attempt-retry-scheduled','transport-error')` returns the
  failure + attempt number + error class — **and** the same run shows a trace whose
  spans nest phase→session→tool with real durations. No diagnosis requires grepping
  `worker.log`/`daemon.log`/`temporal.log`.
- *Cross-check:* `attempt-retry-scheduled` event count == Temporal activity attempt
  count == the retry metric for the run.

**Depends on:** TASK-31/TASK-32 (the cwd + resume key that the new
`session-started`/`session-resumed` events are meant to record).

---

### [x] TASK-35: Write `docs/observability.md` — the observability model, end to end

**What's wrong.** There is no single doc describing how a run is observed. The
knowledge is scattered across code comments (`durable-event-sink.ts`,
`observability-accumulator.ts`), ADR-008, and this backlog. A newcomer debugging a
failed run has to rediscover the three channels the hard way (as happened with
5a513429).

**What to do.** Add `docs/observability.md` covering:
- The **channels and their purposes**: `semantic_events` (durable domain/evidence
  stream → dashboard live + catch-up, completion policy, PR evidence matrix);
  `agent_sessions`/`phase_observability` (per-session token/cost attribution); OTel
  traces/metrics/app-logs (runtime diagnostics, post-TASK-34); and how they bridge
  by `run_id`/`task_id`. State the split rule explicitly: **domain/evidence →
  SQLite; runtime telemetry → OTel; never the reverse.**
- The **event pipeline**: `AgentEvent` → `normalizeAgentEvent` → `SemanticEvent`
  → `daemon.postEvent` (single writer) → `semantic_events` + WebSocket bus.
- The **event taxonomy**: every `EventType` + producer, agent-produced vs
  control-plane, with when each fires.
- A **"debugging a failed run" runbook**: which query/trace/log answers which
  question (the thing that would have made 5a513429 a 2-minute diagnosis).
- Link it from `README.md` (the "Humans" doc list) and reference ADR-008.

**How we'll know it's done.** The doc exists, is linked from `README.md`, and a
reader can go from "a run failed" to the right channel + query without reading
source. Kept honest: it must describe what's actually built (mark the OTel layer
as post-TASK-34 until that lands, rather than documenting aspirational state).

---

## Live shakeout run — game-count UI feature (2026-07-22)

Drove a trivial UI feature ("show N games available in the portal header") on
`wip-browser-games`, claude runtime + `AWB_QA_MODE=browser`. **The full pipeline
ran end-to-end, first try, in ~7.5 min** (plan→implement→verify→exercise→
challenge→release; implement only ~100s — TASK-19's fewer-slices bias landed):
- Builder wrote a correct, clean, **test-backed** change (reused `enabledGames`,
  added `Portal.test.jsx` + wired vitest). candidate `7cde5fa`.
- **Browser QA fired inside the live pipeline** and produced real PNG + WebM
  video + Playwright trace zip (first live proof — TASK-4 confirmed e2e).
- **Adversarial reviewer reviewed the real diff** (ran Bash to inspect files)
  and converged with no blocking findings — TASK-14 confirmed live.
- Evidence-matrix PR comment correct: build/unit-test/qa-video all `passed`.

Two problems the run exposed: **TASK-20** ("stop before release" isn't
enforceable — release pushed a real draft PR #2 before the external watch could
stop it) and a **TASK-7 regression** (the qa-video/trace upload comments say
`undefined` instead of a real download URL; since fixed and confirmed live).

---

## P2 — The capstone

### [ ] TASK-12: Full President dogfood → real Draft PR with QA artifacts
The originally-requested end-to-end goal: use the workbench (claude runtime) to
implement the **President** card game in `Borghese-Gladiator/wip-browser-games`,
matching the poker/sheng-ji structure — a pure engine
(`packages/engines/president/src/engine.js` + Vitest), a React client
(`games/president/`, `useGameSocket("president")`), and a Playwright e2e — ending
in a **real Draft PR** carrying the workbench's QA artifacts (engine unit-test
run + browser-QA video/trace).
**Prerequisites:** TASK-1 (plan converges), TASK-2–7 (each real phase proven),
TASK-8 (real commands discovered so verify/QA are real). President also needs
server-side `useGameSocket` wiring, so it's an interactive run (answer the
contract gate; possibly reject a too-coarse plan).
**Done when:** a real Draft PR for President exists on the repo with real QA
evidence, reached via the workbench with no fake artifacts, and we stop at the
pr-readiness gate (no auto-merge).

**Assessment (2026-07-21) — would this work today? Partially; not unattended.**
What now works, proven on the README run: the mechanical spine
(specify→plan→implement→verify with a real worktree, real builder edits/commits,
real candidate SHA, real discovered test/build after prepare installs deps, real
usage aggregation). President is a bigger *code* task than a README, but the same
machinery applies, so the spine should hold.
The real risks are NOT in the plumbing anymore, they are:
1. **Convergence/quality of a hard multi-file task.** President is a real engine
   + React client + server `useGameSocket` wiring + Playwright e2e across several
   packages. The builder runs each plan slice as an *independent, cold* session
   (see TASK-19) with no shared memory, a 10k-token / 60s per-slice budget, and a
   diff-based success signal. A cross-cutting feature that needs coordinated
   edits across engine/client/server is exactly where cold per-slice sessions and
   tight budgets tend to stall or produce a partial, non-wiring-complete change.
   Expect iteration, not a clean first pass.
2. **The critic + adversarial reviewer are no-ops (TASK-14).** They never see the
   plan/diff, so nothing catches an under-wired or subtly-wrong implementation —
   the run can "pass" challenge with a broken feature. For President's
   correctness that matters a lot.
3. **Browser QA (TASK-4) is unproven live** and President's "done" REQUIRES a
   real qa-video/trace. It needs a discoverable dev-server start command
   (`resolveStartCommand`) and the server to actually come up in the worktree;
   that path has only been fixture-tested.
4. **Runtime.** At ~1–2h for a README (TASK-19), a multi-slice President run is
   plausibly many hours — needs supervision and probably a plan reject or two.
5. **Release opens a REAL draft PR + pushes** to the target remote (no dry-run
   guard) — must be run with a human present, never unattended.
**Bottom line:** the pipeline will very likely *drive* President through the
phases and produce a branch + commits, but reaching a *correct, QA-evidenced*
Draft PR in one shot is unlikely without (a) TASK-14 so review actually guards
quality, (b) TASK-4 proven so browser QA is real, and (c) TASK-19 so iteration is
tractable. Best run interactively, prepared to reject a too-coarse plan and to
repair after review.

**Update (2026-07-21):** the three named prerequisites are now addressed —
TASK-14 (critic/reviewer now receive their inputs via the contextPayload
preamble), TASK-4 (browser QA validated end-to-end; produces real video/trace),
TASK-19 (planner biased to fewest slices). Remaining risk is inherent difficulty:
President is a real multi-package feature and the builder still runs each slice as
a cold session, so cross-cutting engine/client/server wiring may need a repair
loop or two — but the review step can now actually catch an under-wired result.
Still: run it interactively (answer the contract gate, be ready to reject a coarse
plan) and remember release pushes a REAL PR, so a human must be present.
