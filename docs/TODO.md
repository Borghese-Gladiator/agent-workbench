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

### [ ] TASK-2: Live-validate the real builder (Stage 2) + real worktree (Stage 1)
Confirm that, on the claude runtime, a real task creates a real worktree,
the Claude builder actually edits files + commits, and a real candidate SHA is
threaded downstream. **Done when:** after a live run, the worktree under
`~/.agentic-workbench/worktrees/...` contains a real commit authored by the
builder, and `task show` reflects a real (non-`f…f`) candidate SHA.
_Blocked by TASK-1 (can't reach implement until plan converges)._

### [ ] TASK-3: Live-validate real verification (Fixes 1–2)
Confirm verify runs the repo's real discovered test/build commands against the
candidate SHA (not `echo ok`). **Depends on TASK-8** (0 commands were discovered
on the workspace repo, so verify would fall back to the placeholder).
**Done when:** verify evidence shows a real command from the repo ran and its
result is tied to the real candidate SHA.

### [ ] TASK-4: Live-validate real browser QA (Fix 5) produces video/trace
Confirm that with `AWB_QA_MODE=browser` the exercise phase starts the game's dev
server, runs `runBrowserQa`, and produces a real `qa-video` + `browser-trace`
artifact. **Done when:** those artifacts exist in the ArtifactStore for a live
task and `browserScenariosHaveTraces` is satisfied by a real trace.
_Note: needs a repo/game with a discoverable dev-server `start` command
(`resolveStartCommand`)._

### [ ] TASK-5: Live-validate real adversarial review input (Fix 4)
Confirm the challenge phase reviews the real `git diff baseSha..candidateSha`,
not the placeholder string. **Done when:** the reviewer session's input contains
the real diff/changed paths for a live task.

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

## P2 — Bugs found during the live run

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

---

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
