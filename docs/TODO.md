# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

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

Two problems the run exposed (both open, below): **TASK-20** ("stop before
release" isn't enforceable — release pushed a real draft PR #2 before the
external watch could stop it) and **TASK-7 regression** (the qa-video/trace
upload comments say `undefined` instead of a real download URL).

---

## P0 — Blocking the first real end-to-end run

### [~] TASK-7 (regression): QA media upload returns no download URL
**Finding (2026-07-22):** on PR #2 the release phase posted
`QA artifact (browser-trace): undefined` / `(qa-video): undefined` — the media
upload returned an undefined `attachmentUrl` even though the real `.webm`/`.zip`
exist on disk.

**Root cause — CONFIRMED against the real API (2026-07-23), no longer a guess:**
- `gh api repos/Borghese-Gladiator/browser-games__ai/releases/tags/awb-qa-2` →
  the release WAS created (`id=358135821`) but has **`assets: 0`**. So
  `octokit.repos.uploadReleaseAsset` **returned without throwing** and with
  `data.browser_download_url === undefined` — GitHub silently accepted the call
  but attached nothing.
- Why the asset is rejected: in `packages/github/src/release-asset-uploader.ts`
  the asset `name` is `` `${prNumber}-${basename(filePath)}` `` and `filePath` is
  the ArtifactStore **content-hash blob path** (e.g. `sha256/76/76e64273c949…`),
  so the asset name has **no extension** and no explicit content-type is sent.
  GitHub needs a real filename/content-type to store a release asset.
- Because the failure is a silent undefined-return (NOT a throw), the release
  step's existing `try/catch` never saw it — that's why the broken `undefined`
  comment got posted.

**Partial fix DONE (2026-07-22/23):** the release media loop was extracted to
`postQaMediaBriefs()` (`workers/temporal-worker/src/activities/qa-media-support.ts`),
which treats an undefined/empty `attachmentUrl` as a FAILED upload
(`requiredVideosUploaded=false`) and does NOT post a broken `undefined` comment;
successful uploads post a descriptive brief via `renderQaMediaBrief`
("Browser QA recording — <what was tested>" + link), not "QA artifact (kind): url".
This is unit-proven in `qa-media-support.test.ts` (undefined-URL → no comment +
false; real URL → brief; throw → false; no media → vacuously true; mixed →
posts good one + flags failure). The guard is confirmed on the correct code path.

**REAL ROOT CAUSE FOUND + FIXED (2026-07-23, live run task cedb9b68 → real Draft
PR #3):** the filename/content-type part of the earlier fix was necessary but NOT
sufficient — the upload still failed and release still `blocked` on
`requiredVideosUploaded=false`. Reproduced directly against the API: the real
qa-video blob uploaded via `octokit.repos.uploadReleaseAsset({owner,repo,release_id})`
returns **HTTP 307** (redirect) with `browser_download_url === undefined` and does
NOT throw; the asset never lands (`assets: 0`). The 307 is the **renamed-repo
redirect**: the remote is `wip-browser-games` but GitHub has renamed the repo to
`browser-games__ai`, so `api.github.com/.../wip-browser-games/...` 307-redirects to
the canonical repo and Octokit follows the redirect **without re-sending the body**.
The guard (throw-on-undefined-URL) then correctly fires → `postQaMediaBriefs` reports
failure → release blocks. So the guard works; the upload host was wrong.
**Fix (DONE):** post the asset to the release's own `upload_url` (already returned by
`getReleaseByTag`/`createRelease`, on `uploads.github.com` and carrying the canonical
repo) via `octokit.request({method:'POST', url: uploadUrl, name, headers, data})`
instead of `repos.uploadReleaseAsset`. Proven end-to-end through the *fixed uploader
code* against real GitHub: returns 201, asset lands (`state: uploaded`,
`contentType: video/webm`, `size: 53556`), and the `releases/download/...` URL
downloads a real playable `.webm`. Unit tests updated to intercept `request()` (5/5
pass). NOT yet re-run through the live pipeline (worker still on old build; a live
re-run needs rebuild+fresh task — see P1 note below).
**Done when:** ~~the PR comment links a `releases/download/...` URL that actually
downloads the `.webm`, and the release has ≥1 asset.~~ Upload proven to land + download
via fixed code; remaining = observe it once inside a live release phase (rebuild worker
+ fresh task).
_Files: `packages/github/src/release-asset-uploader.ts` (307→upload_url fix, DONE),
`packages/github/src/release-asset-uploader.test.ts` (coverage updated, DONE),
`qa-media-support.ts`/`.test.ts` (guard, already done).

## P1 — Validate the real-pipeline code we wrote but have NOT proven live

**Live validation run 2026-07-23 (task cedb9b68, claude runtime + AWB_QA_MODE=browser,
footer feature on wip-browser-games).** Two false starts first, both instructive:
(1) restarting the worker mid-task to inject an env var wiped the in-memory contract →
permanent `blocked` at specify ("no contract was drafted before approval was expected")
= **live repro of TASK-27**; (2) a default `up` runs the whole pipeline on the **mock**
runtime (0 tokens, fake "Draft PR #1", ~90s) because `resolveAgentRuntime()` defaults to
mock unless `AWB_AGENT_RUNTIME=claude` is in the WORKER env — the drive-task skill never
sets it. Third run (both env vars set before `up`, no restart) reached the release gate
with real usage (tok 106/12696; plan 242s / implement 87s / challenge 111s).

### [x] TASK-5: Live-validate real adversarial review input (Fix 4) — DONE 2026-07-23
CONFIRMED live: the challenge-phase reviewer session (`challenge-1-adversarial-reviewer.ndjson`)
operated on the REAL worktree — read the actual changed files (`Portal.jsx`, `portal.css`,
`main.jsx`), ran `git -C <worktree> diff/status`, ran the targeted + full vitest suite
("All 251 tests pass, including the new Portal test"), and probed for e2e coverage. It
received the real changed paths (went straight to the footer files), not the PLACEHOLDER
diff. `resolveReviewDiff` → `contextPayload.inputs.finalDiff` path (run-phase.ts:705-713)
works end-to-end.

### [x] TASK-6: Live-validate real draft PR delivery (Fix 6 / Stage 4a) — DONE 2026-07-23
CONFIRMED live: release opened **real Draft PR #3** on `Borghese-Gladiator/wip-browser-games`
(`isDraft:true`, branch `awb/in-the-browser-games-portal-landing-page-cedb9b68` pushed to
the real remote, real commit `17d2fe26`, title from objective). PR body carries the evidence
matrix in a Test plan section (build ✅, unit-test ✅, qa-video ✅ "2/2 assertions passed").
`deliverToGitHub` → `createRealDelivery` (real Octokit + git push, owner/repo resolved from
the remote) works. Task reached `release` (though `blocked` not `awaiting-human` — see TASK-7).

### [~] TASK-7: Live-validate QA-media upload to the PR (Fix 7 / Stage 4c) — ROOT CAUSE FOUND + FIXED, live re-run pending
The live run exposed that the earlier fix was insufficient: release went `blocked`
(`requiredVideosUploaded=false`), no media comment, release `awb-qa-3` had `assets: 0`.
Root cause = **307 renamed-repo redirect** on `repos.uploadReleaseAsset` (see the P0 TASK-7
section above for the full diagnosis + the `upload_url` fix). Browser QA itself fired for
real: exercise produced a genuine WebM (53 KB) + Playwright trace zip (57 KB) + 1280×720 PNG.
Fix proven end-to-end through the fixed uploader code (201, asset lands, `.webm` downloads);
**still to observe once inside a live release phase** (rebuild worker + fresh task, since the
running worker is on the pre-fix build and can't hot-reload without losing in-mem state).

---

## P1 — Durability & observability (spec-deviation gaps)

These are architectural deviations from the original spec (§3 durable
orchestration, §8 SQLite schema, §18 capability enforcement, §27 observability,
§37 constraints) surfaced by the 2026-07-21 spec-vs-code audit. They are not
live-run bugs; the pipeline *runs* without them. They are the parts that make the
system durable, inspectable, and safe as designed. Grouped here at P1 because the
persistence gap (TASK-27) can silently reintroduce Decision-003's "advanced on a
lie" failure after a worker restart.

### [ ] TASK-27: Heavy lifecycle state lives in an activity-local Map, not SQLite
**Owner note:** these lifecycle entities are workbench-application state (source
of truth the completion policy reads by ID), NOT observability telemetry — the
observability layer (TASK-22) may *emit* an `evidence-created` semantic event when
a record is written, but must never *own* the record itself (see Decision 003).
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
**Prereq DONE:** TASK-30 landed — the Map is behind a `RunStateStore` interface
(`workers/temporal-worker/src/activities/run-state-store.ts`, `InMemoryRunStateStore`
default), so this is now a single drop-in impl (a `@awb/database`-backed store) rather
than a nine-site rewrite.
**Do:** have the `RunStateStore` impl read/write `TaskContract`/`ImplementationPlan`/
`Evidence`/`Finding`/lease rows through `@awb/database` (via the daemon's data layer,
or its own handle) instead of the in-memory Map; persist the `tasks` row on create;
back `ArtifactStore` with a SQLite `artifacts`-table metadata store + the durable
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
alongside TASK-27 (the worker needs *some* DB access for persistence — make it a
scoped/read path, or funnel writes through the daemon so the invariant holds).
**Done when:** the worker cannot write to or migrate the workbench DB, and TASK-27
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
**Prereq DONE:** TASK-30 landed — the driver has ONE `phase.started`/`phase.completed`
emit hook (`PhaseEventEmitter` on `PhaseContext`, no-op default in `phase-driver.ts`)
and usage now rides a per-invocation `UsageAccumulator` on the context (was the
`currentUsage` global), so this task wires a real sink into that single seam and feeds
`UsageAggregator` without reading a global.
**Do:** replace `NOOP_EVENT_SINK` (and the file-only sink) with a real sink that
(a) persists normalized `SemanticEvent` rows to SQLite, (b) publishes them to the
`SemanticEventBus` for the live WebSocket, and (c) feeds `UsageAggregator` for the
by-model breakdown; write `agent_sessions`/`model_invocations` rows; add at least the
coarsest useful runtime-attribution buckets. (Also depends on TASK-27 for the SQLite
write path.)
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
