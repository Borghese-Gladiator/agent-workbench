# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

---

## P0 — Blocking the first real end-to-end run

### [x] TASK-1: Plan phase stalls on the live claude runtime (`repeated-failure-no-progress`)
**Root cause (diagnosed 2026-07-21, no model needed):** `buildClaimCoverage`
in `@awb/planning` hardcoded `qaScenarioIds: []`, so
`everyBehavioralClaimHasQaScenario` could NEVER be satisfied for the Fix-9
contract (which always carries a `behavior` + `qaEvidenceRequired` claim). The
plan gate therefore always returned `blocked`, which the Workflow surfaces as
the misleading `repeated-failure-no-progress` reason (the phase's fallback gate
label, not an actual repeated failure).
**Fixed:**
- `PlanSlice` gained an optional `qaScenarioIds`; `buildClaimCoverage` now
  derives coverage `qaScenarioIds` from the covering slices.
- `plannerInstruction` asks for `qaScenarioIds` and names the behavioral claim;
  `parsePlannerOutput` parses them AND synthesizes a scenario when the planner
  omits one for a covered behavioral claim (forgiving). The single-slice
  fallback in `run-phase` does the same.
- Every agent session (planner/critic/builder/reviewer) now writes its text +
  tool + usage events to `agent-logs/<phase-attempt>-<role>.ndjson` under the
  task's artifacts dir (replacing `NOOP_EVENT_SINK`), so a stall is inspectable.
Verified the three plan paths (JSON+scenario, JSON-omitted-scenario,
no-JSON-fallback) all pass the plan gate for the Fix-9 README contract.
_Still needs a live claude run to confirm end-to-end (TASK-2+)._

<details><summary>original</summary>
**Symptom (observed 2026-07-21 live run):** a minimal real task ("add a Games
section to the README") drafted a real contract, passed the contract gate, then
advanced specify → plan and went `condition: blocked`, gate reason
`repeated-failure-no-progress`, at `attemptNumber: 1`. It never reached
implement/verify/exercise/release. The whole delivery path (TASK-6/7 below) was
therefore never exercised.
**Why we can't diagnose it yet:** `runPhase` passes `NOOP_EVENT_SINK` to every
agent session (`run-phase.ts`), so the planner/critic's actual output is
discarded — the worker log shows nothing about why the loop failed.
**Suspected cause:** the real planner didn't emit the fenced JSON plan block
`parsePlannerOutput` expects, so it fell back to a single slice; or the critic
returned blocking findings repeatedly. Unconfirmed.
**Do:**
- Replace `NOOP_EVENT_SINK` in the plan/critic (and builder/reviewer) sessions
  with a sink that persists the agent's text + tool events (SemanticEventBus /
  a per-task log file under the artifacts dir) so a stall is inspectable.
- Re-run the minimal task; read the captured planner output.
- If it's a JSON-format miss: harden `plannerInstruction` (make the JSON schema
  explicit / few-shot) and/or make `parsePlannerOutput` more forgiving.
- If it's critic non-convergence: inspect the findings and adjust.
**Done when:** the minimal task advances past plan to implement on the claude
runtime, with the planner output visible in a log/artifact.
</details>

---

## P1 — Validate the real-pipeline code we wrote but have NOT proven live

All of Stages 0–3 + Fixes 1–9 are unit/fixture-tested, but only the SDK path +
Fix 9 (real contract) were confirmed against a live model. Everything below is
"works in tests, unproven end-to-end with a real agent."

> **Live-run status (2026-07-21):** driving `wip-browser-games` (add a Games
> section to the README) on the claude runtime, the pipeline now runs
> specify→plan→implement→verify with real work at each phase. Every blocker found
> was fixed + committed (TASK-1, 13, planner-cwd, no-op-slice, claim-coverage,
> verify-env, prepare-install). TASK-2/3/8/9/11 are live-confirmed. TASK-4/5
> (exercise/challenge) are code-complete but not yet reached in a single clean
> run; TASK-6/7/12 open a REAL draft PR (release pushes to the target remote with
> no dry-run guard) so they were deliberately NOT run unattended — drive them
> with supervision. The builder spends ~1–2h on this trivial task because the
> planner over-decomposes it into discovery/author/verify slices, each a full
> session (worth tuning; not a blocker).

### [x] TASK-2: Live-validate the real builder (Stage 2) + real worktree (Stage 1)
Confirm that, on the claude runtime, a real task creates a real worktree,
the Claude builder actually edits files + commits, and a real candidate SHA is
threaded downstream. **Done when:** after a live run, the worktree under
`~/.agentic-workbench/worktrees/...` contains a real commit authored by the
builder, and `task show` reflects a real (non-`f…f`) candidate SHA.
**DONE (live-confirmed 2026-07-21):** real worktree materialized at
`~/.agentic-workbench/worktrees/<repo>/<task>`, the builder used real
Read/Write/Edit/Bash to explore + edit, committed
`awb: Add a 'Games' section…` (README +11), and the real candidate SHA
`60606a9…` (not `f…f`) was threaded to verify's evidence
(`implement-60606a96…`). Required fixes TASK-13 + the no-op-slice fix.

### [x] TASK-3: Live-validate real verification (Fixes 1–2)
Confirm verify runs the repo's real discovered test/build commands against the
candidate SHA (not `echo ok`). **Depends on TASK-8** (0 commands were discovered
on the workspace repo, so verify would fall back to the placeholder).
**Done when:** verify evidence shows a real command from the repo ran and its
result is tied to the real candidate SHA.
**DONE (live-confirmed 2026-07-21):** verify resolved the discovered
`npm run test` + `npm run build` (TASK-8) and ran them against candidate
`60606a9…`. Uncovered + fixed a real bug: verify passed `env: {}`, so the
shell-less spawn had no PATH and `npm` hit ENOENT (→ inconclusive → false
block); now inherits the worker env. Both commands pass in the worktree
(253 tests incl. the builder's new `portal/src/readmeGames.test.jsx`; vite
build OK).

### [x] TASK-4: Live-validate real browser QA (Fix 5) produces video/trace
Confirm that with `AWB_QA_MODE=browser` the exercise phase starts the game's dev
server, runs `runBrowserQa`, and produces a real `qa-video` + `browser-trace`
artifact. **Done when:** those artifacts exist in the ArtifactStore for a live
task and `browserScenariosHaveTraces` is satisfied by a real trace.
**DONE (validated 2026-07-21):** ran `runBrowserQaViaServer` against
wip-browser-games' real `npm run dev` (Vite :5173) in an installed worktree — it
started the server, drove real chromium, and produced real `qa-video` (.webm) +
`browser-trace` (.zip) + screenshot, both assertions passing. **Found + fixed a
blocking bug:** the default base URL was `http://127.0.0.1:5173`, but Vite binds
`localhost` (IPv6 `::1` here), so `127.0.0.1` returned 000 and QA always timed
out. Defaulted to `localhost` and made the readiness probe try both localhost
forms + drive the browser at whichever responds.

### [ ] TASK-5: Live-validate real adversarial review input (Fix 4)
Confirm the challenge phase reviews the real `git diff baseSha..candidateSha`,
not the placeholder string. **Done when:** the reviewer session's input contains
the real diff/changed paths for a live task.
_Not yet reached in a single clean run. TASK-14 is now fixed, so the reviewer's
prompt DOES contain the real diff/changed-paths/contract/plan (via the
contextPayload preamble) — TASK-5 is now just waiting on a live run to observe it._

### [ ] TASK-6: Live-validate real draft PR delivery (Fix 6 / Stage 4a)
Confirm `runRelease` opens a **real draft PR** on the target repo via Octokit
(authed by `gh auth token`) + git-CLI push, with the correct owner/repo resolved
from the remote and the real branch/base. **Done when:** a real draft PR exists
on the repo with the evidence-matrix comment, and the task reaches
`release`/`awaiting-human`.
_Blocked by TASK-1._

### [ ] TASK-7: Live-validate QA-media upload to the PR (Fix 7 / Stage 4c)
Confirm the release-asset uploader hosts the qa-video/trace as a GitHub release
asset and links it in a PR comment. **Done when:** the PR from TASK-6 has a
comment linking a real `releases/download/...` URL that actually downloads the
`.webm`. _Blocked by TASK-6._

---

## P1 — Durability & observability (spec-deviation gaps)

These are architectural deviations from the original spec (§3 durable
orchestration, §8 SQLite schema, §18 capability enforcement, §27 observability,
§37 constraints) surfaced by the 2026-07-21 spec-vs-code audit. They are not
live-run bugs; the pipeline *runs* without them. They are the parts that make the
system durable, inspectable, and safe as designed. Grouped here at P1 because the
persistence gap (TASK-20) can silently reintroduce Decision-003's "advanced on a
lie" failure after a worker restart.

### [ ] TASK-20: Heavy lifecycle state lives in an activity-local Map, not SQLite
**What's wrong:** there are two state layers. The Workflow's own
`TaskWorkflowState` (phase/condition/attempt/evidence-IDs/finding-IDs/usage) IS
durable — Temporal replays it correctly across a worker crash, by construction.
But the *heavy objects* those IDs point at — the drafted `TaskContract`, accepted
`ImplementationPlan`, `baseSha`/`candidateSha`, `WorkspaceLease`, accumulated
`verificationEvidence`/`qaEvidence`, `reviewFindings`, and the `ArtifactStore`
metadata — live only in an in-memory `Map<taskId, TaskRunState>` inside the
activity module (`run-phase.ts:80`), plus a `createdTasks[]` array in the daemon
(`routes/tasks.ts:34`). `run-phase.ts` imports no database package at all.
**Consequence (ADR 006):** on a worker restart, Temporal re-invokes `runPhase`
for the current phase, but `getOrCreateTaskRunState` finds nothing and silently
creates an EMPTY state — so the durable `TaskWorkflowState`'s evidence/finding
IDs now point at objects that no longer exist. This is exactly the
"lifecycle moved forward on a lie" class Decision 003 exists to prevent.
This also leaves **31 of the 37 spec §8 tables dead at runtime** (only the 6
repository-onboarding tables are ever INSERTed, by the daemon): task_contracts,
acceptance_claims, plans, plan_slices, plan_claim_coverage, runs, phase_attempts,
workspace_leases, agent_sessions, model/tool/command_invocations, semantic_events,
findings, evidence + join tables, artifacts, human_decisions, waivers,
pull_requests + feedback, memory_entries + sources, failure_signatures,
repository_symbols, repository_dependencies (repository_facts + sources are
written from tests only). Their FTS5 mirrors are therefore empty at runtime too.
**Do:** have `runPhase` read/write `TaskContract`/`ImplementationPlan`/`Evidence`/
`Finding`/lease rows through `@awb/database` (via the daemon's data layer, or its
own handle) instead of the in-memory Map; persist the `tasks` row on create; back
`ArtifactStore` with a SQLite `artifacts`-table metadata store + the durable
`layout.artifactsDir` (not `mkdtemp`/`InMemoryArtifactMetadataStore`).
**Done when:** killing and restarting the worker mid-task resumes with the real
contract/plan/candidate-SHA/evidence intact, and `task show` reads lifecycle rows
from SQLite rather than a session-scoped array.

### [ ] TASK-21: Enforce the single-writer invariant (spec §8)
**What's wrong:** spec §8 says "the daemon must be the only application writer,"
but the worker also opens read/write `better-sqlite3` handles and runs migrations
against the daemon's DB file (`worktree-support.ts:18`, `command-support.ts:17`,
via `createDatabase` which is not read-only and calls `runMigrations`). Today the
worker only SELECTs, so nothing is corrupted, but it attaches read-write and can
run DDL.
**Do:** give the worker a read-only connection (open with a readonly handle, no
`runMigrations`), or route all worker reads through a daemon API. Decide this
alongside TASK-20 (the worker needs *some* DB access for persistence — make it a
scoped/read path, or funnel writes through the daemon so the invariant holds).
**Done when:** the worker cannot write to or migrate the workbench DB, and TASK-20
persistence goes through a path that preserves "daemon is the only writer."

### [ ] TASK-22: Wire the event sink — semantic events, live stream, §27 attribution
**What's wrong:** every `adapter.execute(...)` call in `run-phase.ts` passes
`NOOP_EVENT_SINK` (5 sites: planner, plan-critic, builder, reviewer, plus
builder-support). Adapters correctly EMIT `usage`/`message`/`tool-*` events, but
they are dropped on the floor before `normalizeAgentEvent` (`event-normalization.ts`)
or the `SemanticEventBus` (`event-bus.ts`) ever see them. Consequences:
`semantic_events` is never written outside a test; the WebSocket
`/api/events/stream` connects but never emits (zero `.publish()` callers); the UI
falls back to a 2s REST poll; `UsageAggregator` is orphaned test-only code. This
is also why TASK-1's stall was undiagnosable — the planner's output was discarded.
(NOTE: TASK-11 already threads a coarse `usage` total into `TaskWorkflowState` via
the phase result, independent of this sink — that part works. This task is about
the *event stream* and the finer breakdown.)
Beyond the sink, spec §27 also asks for detail we don't have at all:
- the **12 runtime-attribution buckets** (environment-setup-ms,
  dependency-install-ms, model-wait-ms, model-generation-ms, tool-execution-ms,
  test-execution-ms, service-startup-ms, qa-execution-ms, artifact-processing-ms,
  github-operation-ms, human-wait-ms, retry-backoff-ms) — zero exist; we only
  have coarse `runtimeMsByPhase`.
- **token usage by role/adapter/provider/model/attempt** — only a flat
  input/output total exists (`model_invocations` columns exist but are unwritten).
- **context-composition tracking** (8 buckets) — does not exist at all.
- **cost estimation** to the UI — `cost_usd` column exists, never populated.
**Do:** replace `NOOP_EVENT_SINK` with a real sink that (a) persists normalized
`SemanticEvent` rows to SQLite, (b) publishes them to the `SemanticEventBus` for
the live WebSocket, and (c) feeds `UsageAggregator` for the by-model breakdown;
write `agent_sessions`/`model_invocations` rows; add at least the coarsest useful
runtime-attribution buckets. (Depends on TASK-20 for the SQLite write path.)
**Done when:** a live run streams semantic events to the UI over the WebSocket,
`semantic_events`/`model_invocations` have real rows, and `task show` reports a
by-model token/cost breakdown — not just the flat total.

### [ ] TASK-23: Reconnect catch-up route by sequence number (spec §31)
**What's wrong:** `SemanticEvent` carries a `sequence` field and the websocket
route comments that reconnect catch-up happens "via a REST query keyed on
`sequence`" — but that route does not exist (`websocket.ts` says "not yet
implemented"), and the Web UI never opens the WebSocket at all (HTTP-only client,
2s poll). So §31's "on reconnect, use SQLite event sequence numbers to catch up"
is unimplemented end-to-end.
**Do:** add a daemon REST route `GET /api/events?afterSequence=N` reading
`semantic_events` from SQLite; have the Web UI open the WebSocket for live updates
and replay missed events via that route on reconnect. (Depends on TASK-22 for
persisted events.)
**Done when:** disconnecting and reconnecting the UI mid-task shows no gap in the
event timeline.

### [ ] TASK-24: Capability broker is defined but NOT enforced at runtime (spec §18)
**What's wrong:** the broker (`capability-broker`) is real and unit-tested, but at
runtime the per-role restriction is decorative. `allowedToolsForBrokerRole`
(`run-phase.ts:98`) returns capability strings like `repository.read`/
`worktree.write` verbatim; nothing maps them to the SDK's actual tool names
(`Read`/`Edit`/`Bash`/`Grep`). They are then passed to the Claude adapter's
`options.tools` (`claude-adapter.ts:205`) — the wrong field; the SDK's top-level
query uses `allowedTools`/`disallowedTools`/`canUseTool`, none of which are set.
`broker.assert(...)` is never called in the session path. Net: an agent session's
real toolset is whatever the SDK defaults to, so the planner/reviewer are NOT
actually read-only and the builder is NOT actually scoped — contradicting §18's
"the deny-list is wired into what tools the agent session gets" and the §33
security boundaries.
**Do:** add a capability→SDK-tool-name mapping; pass the resulting allow list to
`allowedTools` and an explicit `disallowedTools` (or a `canUseTool` handler that
consults `broker.assert`) to the SDK; verify read-only roles cannot invoke
`Edit`/`Write`/`Bash`.
**Done when:** a planner/reviewer session provably cannot write files or run shell
on the claude runtime, enforced by the adapter, not just by the broker's unit test.

### [ ] TASK-25: Wire the unwired real QA/feedback features (spec §23, §29)
**What's wrong:** these are fully implemented, tested library modules with **no
runtime caller** — real code that never runs in a task:
- **HTTP-API QA** (`qa/src/http-api-qa.ts`) and **Library QA**
  (`qa/src/library-qa.ts`) are never invoked from the exercise phase; only CLI QA
  (default) and Browser QA (`AWB_QA_MODE=browser`) are wired.
- **PR-feedback loop** (`github/src/feedback-classification.ts`:
  `classifyFeedback`/`canAutoLoop`/`feedbackRequiresHumanGate`) has zero callers.
  Nothing ingests PR comments, classifies them, or drives the §29 auto-loop /
  human gate; the merge/close transition is a manual `POST .../merged` signal, and
  `getPrStatus` is never polled.
Related but already tracked: real critic/reviewer findings = TASK-14; browser QA
assertions are weak (per-step `passed:true` unless the scenario adds
`waitForText`/`ariaSnapshot`), CLI QA is a text transcript not a PTY/terminal
video, and verify's `environmentDigest` is hardcoded rather than computed.
**Do:** invoke HTTP-API/Library QA from exercise when the repo surface calls for
it; build a PR-feedback ingest (manual refresh + poll per §29) that classifies
comments and drives the loop/gate; compute a real environment digest for verify.
**Done when:** an API/library-surfaced task runs the matching QA executor, and PR
feedback on a draft PR is classified and either auto-looped or gated.

### [ ] TASK-26: Temporal robustness — continue-as-new + discovery workflow (spec §9, §15, §34)
**What's wrong:**
- No **continue-as-new** threshold. Spec §34 lists it as a required Temporal test,
  and a long task (especially the Assimilate PR-feedback wait) grows workflow
  history unbounded; there is no history-size guard in the `TaskWorkflow` loop.
- **`RepositoryDiscoveryWorkflow` is not a Temporal workflow.** Spec §9/§15 want
  discovery as its own workflow; today it runs as synchronous daemon route logic
  (`repository/src/persist.ts` via `POST /api/repositories[/refresh]`). Arguably
  fine (it's already persisted and synchronous), but it's an architecture
  deviation to record.
**Do:** add a continue-as-new guard keyed on history length / event count in the
task loop; decide whether to promote discovery to a real workflow or explicitly
document the daemon-route choice as an accepted deviation (an ADR).
**Done when:** a task that loops many times continues-as-new instead of growing
history without bound, and the discovery-workflow decision is recorded.

---

## P2 — Bugs found during the live run

### [x] TASK-19: Planner over-decomposes trivial tasks → ~1–2h per run
**Live-run finding (runs 3/5, 2026-07-21):** the builder spends ~1–2h on the
*trivial* "add a Games section to the README" task because the planner splits it
into discovery/author/verify slices, and each slice is a full, separate Claude
builder session (`runSliceLoop` → one `runRealBuilderAttempt` per slice; on run 5
`runtimeMsByPhase.implement` was ~5.1M ms ≈ 85 min, plan ~14 min). Most of that
is the discovery/verify slices doing repo-wide exploration that the single
feature edit didn't need. This isn't a correctness bug (the runs converged) but
it makes iteration painfully slow and burns tokens.
**Do (options, cheapest first):**
- Bias the planner toward fewer slices for low-risk/doc-only work — e.g. tell it
  in `plannerInstruction` to prefer a single slice unless the work genuinely
  spans independent units, and/or collapse a plan whose slices all touch the
  same paths.
- Carry context across slices so a later slice doesn't re-discover from scratch
  (today each builder session starts cold; resume/session-reuse or a shared
  discovery note would cut the repeated exploration).
- Cap per-slice budget more aggressively for non-code slices.
**Done when:** the README task completes in minutes, not hours, without
regressing convergence.
**DONE (2026-07-21):** `plannerInstruction` now tells the planner to use the
FEWEST slices (prefer a single slice) and NOT to make separate investigate/verify
slices — folding discovery + checks into the change slice. Cuts the cold-session
multiplier that drove the ~1–2h runtime. (Runtime win to be confirmed on the next
live run.)

### [x] TASK-15: Worktree deps never installed → verify's build failed
**Live-run finding (run 5):** with the verify-env fix, verify actually ran the
discovered commands, but `npm run build` (vite build) failed
`Cannot find package 'vite'` — a fresh `git worktree` has no `node_modules` and
prepare never installed them (`dependenciesPrepared` was rubber-stamped).
**Fixed:** prepare runs the discovered `install` command, or a package-manager
default from the worktree lockfile (pnpm/yarn/npm), with the worker env;
`dependenciesPrepared` now reflects the real exit code. **Verified directly:**
after `npm install` in a task worktree, both discovered commands pass
(`npm run test` 253 tests; `vite build` OK).

### [x] TASK-16: Planner ran in the workbench repo, not the target
Plan runs before prepare creates the worktree, so the planner's cwd fell back to
`process.cwd()` (the workbench) — it planned against `@awb/temporal-worker` and
reported "no games in this repo." Fixed: resolve the registered repo's
canonicalPath (DB) as the plan cwd on the claude runtime. Live-confirmed: the
planner now explores the real target and finds the 5 games in the registry.

### [x] TASK-17: Plan gate false-blocks (qa-scenario + claim coverage)
Two plan-gate false-blocks, both surfaced as the misleading
`repeated-failure-no-progress`: (a) `buildClaimCoverage` hardcoded
`qaScenarioIds: []` so `everyBehavioralClaimHasQaScenario` could never pass
(TASK-1); (b) the planner mapped only the behavioral claim to its slice, failing
`everyClaimMappedToSlice`. Fixed: coverage derives QA scenarios from slices +
`parsePlannerOutput` synthesizes/attaches missing scenarios and unmapped claims.

### [x] TASK-18: Diff-less slices failed implement
A multi-slice plan's discovery/verify-only slice makes no diff;
`runRealBuilderAttempt` treated no-diff as `noMeaningfulDiff` → no-progress →
implement blocked even though the feature slice committed a correct diff. Fixed:
a COMPLETED no-edit session is a legitimate no-op slice (success); only an
INCOMPLETE no-diff session is the stuck signal.

### [x] TASK-13: Builder session had no file tools (only ambient MCP) — implement stalled
**Live-run finding (2026-07-21, after the plan fix):** the task converged
through plan and reached `implement`, then blocked `repeated-failure-no-progress`
at attempt 1. The captured builder log showed the session had NO
`Read`/`Write`/`Edit`/`Bash` — only the ambient MCP servers
(Buildkite/Chronosphere/Figma/Playwright/Sentry) — so it could not edit files,
produced no diff, and looped to no-progress.
**Root cause:** run-phase passed the capability broker's *abstract* capability
names (`worktree.write`, `repository.read`, …) straight to the SDK `tools`
option, which expects concrete tool names and recognized none, falling through
to ambient MCP inheritance. Compounded by the headless worker having no human
to answer per-tool permission prompts (every call denied).
**Fixed:** added `capabilitiesToSdkTools` (agent-gateway) mapping abstract
capabilities → `Read/Write/Edit/Grep/Glob/Bash`, applied on the claude runtime;
set the SDK `permissionMode` to `bypassPermissions` for the headless worker.
**Done when:** the builder edits + commits a real diff on a live run
(verifying).

### [x] TASK-8: `repo refresh` discovers 0 commands on a workspace repo
On `wip-browser-games`, discovery found 0 `ValidatedCommand`s because the games
are pnpm/npm-workspace sub-packages and the root `package.json` scripts didn't
classify. This makes Fix 2's verify fall back to `echo ok`.
**Do:** make command discovery recurse into workspace packages (read
`workspaces`/`pnpm-workspace.yaml`, discover per-package `test`/`build`).
**Done when:** refresh on `wip-browser-games` returns real per-game test/build
commands.
**DONE (live-confirmed 2026-07-21):** `repo refresh` on `wip-browser-games` now
records 13 units + 6 commands (was 0) — real root `test`/`build`/`dev`
discovered, plus nested `packages/engines/*`, `games/*`, `portal` units.

### [x] TASK-9: CLI `--version` flag collision breaks `task approve-contract`
`node apps/cli/dist/index.js task approve-contract <ids> --version 1` prints
`0.1.0` and no-ops, because it collides with the global `program.version('0.1.0')`
flag. Had to approve via the daemon route in the live run.
**Do:** rename the option (`--contract-version`) — and audit `approve-plan
--version` for the same collision.
**Done when:** `awb task approve-contract ... --contract-version 1` works and a
test covers it.
**DONE (live-confirmed 2026-07-21):** approved the live task's contract with
`awb task approve-contract --contract-version 1` (reached the daemon, no
`0.1.0` short-circuit). `approve-plan` renamed to `--plan-version` too.

### [x] TASK-10: `cli` npm script injects `--`, breaking required options
`pnpm --filter @awb/cli cli -- <args>` prepends its own `--`, so required options
like `--prompt` get swallowed; had to run the built `dist` directly.
**Do:** fix the `cli` script (or document `awb`-via-`pnpm link` as the supported
path) so `--prompt`/`--version` pass through.
**Done when:** driving a task via the documented CLI invocation works without the
`dist` workaround.

### [x] TASK-11: Per-phase token/runtime usage is not aggregated
`tokenUsageTotal` stays 0 and `runtimeMsByPhase` empty even on a live run — the
workflow doesn't aggregate usage the activity/adapter reports.
**Do:** thread `AgentExecutionResult.usage` from the activity back into
`TaskWorkflowState` (via the candidate result or a dedicated signal/query).
**Done when:** `task show` reflects real token + per-phase runtime for a live run.
**DONE (live-confirmed 2026-07-21):** on a live run `task show` reported
`tokenUsageTotal {input: 2714, output: 19724}` and
`runtimeMsByPhase {plan: 48520, implement: 2338651}` (was 0 / empty).

---

### [x] TASK-14: plan-critic + adversarial-reviewer are no-ops on the claude runtime
**Live-run finding (2026-07-21):** the ClaudeAgentAdapter sends only
`assignment.instruction` as the prompt and NEVER reads `contextPayload`. The
planner works because `plannerInstruction(contract)` embeds the objective, but
the plan-critic's instruction ("Critique the plan against the contract") and the
reviewer's ("Adversarially review …") embed nothing — the critic literally
replied "I don't have the plan or the contract yet." So both effectively return
no findings without seeing their inputs (the challenge diff is threaded via
`reviewInputs`→`contextPayload`, also dropped).
**Do:** thread the relevant context (plan text for the critic; contract/plan/
diff/changed-paths/evidence for the reviewer) INTO the instruction prompt (or
teach the adapter to serialize `contextPayload` into the first user turn).
**Done when:** the critic/reviewer session input contains the real plan/diff and
they produce grounded findings on a live run. Not pipeline-blocking (both pass
through today), so deferred rather than rushed unsupervised.
**DONE (2026-07-21):** the ClaudeAgentAdapter now serializes `contextPayload`
into a JSON preamble on the session's FIRST prompt (resumed turns skip it, large
payloads truncated), so the critic sees the plan and the reviewer sees the
contract/plan/diff/changed-paths/evidence. Critic + reviewer instructions
rewritten to reference "the JSON context above" and ask for concrete findings.
Unit-tested (preamble present on turn 1, absent on resume). Grounded-findings
quality still to be observed on a live run.

## P3 — The capstone

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
