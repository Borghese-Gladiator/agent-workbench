# Backlog
Prioritized List of Things to Fix

Every task should have what is wrong / what to do, where, and how we'll know when it's done


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

**Where.** `packages/observability/` (run attributes, via TASK-55), a config flag to
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
  (`packages/observability/` + the SQLite run tables — `tokenBreakdown` /
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
support), `packages/observability/` + the run/attempt/session token tables for the
query side, a short ranked writeup + the applied reductions in `docs/`. Depends on
the TASK-46/TASK-55 token plumbing for the query surface; relates to
`group-e-token-memory-graph` (in-session context is the real cost, not caching) and
TASK-74 (don't read code the change doesn't need).

**How we'll know it's done.** A ranked writeup — per-phase / per-prompt **actual**
token spend across several real runs, the top waste sources named, and the applied
reductions with a before/after token delta on the same runs. Not "we reviewed the
prompts," but "we queried the runs, found X phase burns N tokens on Y, cut it, and
re-measured."


## Group I — Delivery & stacked PRs

The two ways a finished change fails to *land*: no origin to open a PR against,
and no way to stack one task's branch on the previous task's branch.

### [x] TASK-71: No `origin` → task can't deliver; should branch + merge to local `master` instead

**What's wrong.** When a repo has no `origin` remote, a task that is fully
implemented and verified has nowhere to go. The delivery/PR-readiness path assumes
a remote to push to and a PR to open, so a done change strands in the worktree. In
one live case both games were fully implemented, committed, and verified in the
worktree (307 unit tests + both Playwright e2e specs passing), yet the run could
never "deliver" — compounded by the run being stuck in a QA-evidence gate loop
(`repeated-failure-no-progress`) that re-raises forever, so it never reaches its own
pr-readiness gate. The code was done and there was no delivery mechanism for it.

**What to do.** When there is no `origin`, deliver locally: create the feature
branch, then merge it into the local default branch (`master`/`main`) as a new
commit (or fast-forward), rather than attempting a push/PR. Detect the
no-remote case explicitly and route delivery to a local-merge strategy. Two seams
already make this tractable (verified): (1) the release handler already
runtime-swaps the delivery mechanism — the mock path injects `FakeGitHubClient` /
`FakeGitPushRunner` at `run-phase.ts:1461-1464`, so a "no-origin → local merge"
runner can be injected the same way; (2) resolving the local target branch is
already solved by `getDefaultBranch` (`packages/repository/src/git.ts:49-71`,
origin/HEAD → current branch → main/master fallback) — only the delivery *action*
is missing. This is the mirror of the `close-worktree` Mode-B / no-remote handling.
(The QA-evidence false-positive loop that kept this particular run from reaching
pr-readiness is a separate defect; see TASK-75.)

**Where.** Verified on main: push is hardcoded to `origin`
(`packages/github/src/push.ts:12-14`, `git push origin`); the repo ref resolves only
from a GitHub-parseable remote (`delivery-support.ts:29-34` `resolveRepoRef`); when
that returns undefined the release handler terminally blocks
(`run-phase.ts:1455-1458`, "could not resolve a GitHub owner/repo…"); delivery always
opens a PR via Octokit (`packages/github/src/delivery.ts:50,72-79` →
`real-github-client.ts:18-22`). A grep found **zero** existing local-merge fallback.
Relates to the `close-worktree-detect-merged-mode` learning.

**How we'll know it's done.** *Unit:* a delivery test on a repo with no `origin`
produces a feature branch merged into local `master` with a new commit, and does
NOT attempt a push. *Manual:* drive a small task on a local-only repo end to end and
confirm the change lands as a commit on local `master` with no remote configured.

### [x] TASK-72: Stacked-PR DAG — tasks whose branches stack on one another with distinct bases

**What's wrong.** There is no first-class way to build a *chain* of stacked PRs,
where each task's branch is based on the previous task's delivered branch (not
`master`), and each PR's base = the previous PR's branch. Today this only works by
manually threading `repository.defaultBranch` between runs:

1. Set `repository.defaultBranch` = previous task's delivered branch (for PR#0,
   leave it `master`).
2. Create the task with a tightly-scoped prompt pointing at the exact files.
3. Approve the contract gate; drive to pr-readiness, answering gates.
4. Once the PR is opened, record its branch → becomes the base for the next task.
5. After all deliver, use `gh` to confirm each PR's base = the previous PR's branch.

That is a manual DAG walked by hand. It should be a declared dependency graph the
workbench executes.

**What to do.** Reference the "V4" DAG design for how to declare a task graph and
let each node's branch stack on its parent. Model an explicit task dependency edge
(parent task → child task) that sets the child's base branch to the parent's
delivered branch, and carries that base through both worktree creation and PR
creation (so the opened PR's base = parent's branch, not `master`). PR#0's base
stays `master`/`main`. This subsumes the manual `defaultBranch`-threading recipe
above into declared edges. The plumbing is ~90% present (verified): the base string
already flows lease `baseRef` → `baseBranch` → `octokit.pulls.create({ base })`
(`run-phase.ts:1467,1515` → `real-github-client.ts:22`), so an arbitrary base is
*accepted* — what's missing is a per-task base **override** and a task-dependency
field to source it from. Minimal change: thread a base override into
`materializeWorktree` (`worktree-support.ts:13-35`) and add the edge/base field to
`TaskSchema` (`packages/domain/src/tasks.ts:4-13`).

**Where.** Verified gaps on main: the lease `baseRef` is set **only** from
`repository.defaultBranch` (`worktree-support.ts:32`); `materializeWorktree` takes no
base param and its caller passes none (`run-phase.ts:697-702`); the worktree/branch
is created FROM that baseRef (`packages/workspace/src/worktree.ts:64-65`);
`repository.defaultBranch` is per-repo, set once at registration
(`schema/repository.ts:18`, `persist.ts:42`); `TaskSchema` has **no**
base/parent/dependency field (`tasks.ts:4-13`). The existing `dependsOn` in the code
is unrelated (repository *unit* graph + evidence supersession), and stacked-PR hits
exist only under superseded `archive/`. Relates to the `flex-dashboards-stacked-prs`
and `parallel-fanout-rebase-conflict` learnings.

**How we'll know it's done.** *Unit:* a two-node DAG resolves the child's base
branch to the parent's delivered branch, and PR-creation is called with that base.
*Manual:* drive a 3-task stacked chain and confirm via `gh` that each PR's base =
the previous PR's branch (PR#0 base=`master`), with no manual `defaultBranch` edits.

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

### [ ] TASK-104: `verify` runs EVERY discovered test+build command (root full-suite + all 24 packages), serially, with no per-command timeout → exhausts the 30-min activity budget

> **Re-verified against `main` @ `320b2dd` (2026-08-17).** Still an issue; the
> "dogfood fixes" in that commit touched delivery/DAG code, not the verify path.
> Code paths below are current line numbers on that main.

**What's wrong.** `verifyHandler` (`workers/temporal-worker/src/activities/run-phase.ts:941`)
calls `resolveVerificationCommands` (`command-support.ts:86`), which returns **every**
discovered command whose purpose is `unit-test` or `build` (`command-support.ts:94-97`)
with **no filtering by which packages the diff touched**. For agent-workbench,
discovery recorded (verified in the `repository_commands` table): the root
`unit-test = pnpm test` (which is `vitest run` = **132 test files**, incl. self-booting
e2e like `tasks-completion-e2e.test.ts` / `run-phase-e2e.test.ts`), **plus one
`unit-test = npm run test` per package (24 of them), plus ~24 `build` commands**. So a
2-file, test-only change re-runs the entire monorepo *and* every package build. Two
aggravating factors found in code:
- `runVerificationMatrix` runs them **serially** — `for (const command of commands)`,
  each `await`ed (`packages/verification/src/verification-runner.ts:142`) — so the
  wall-clock is the *sum*, not the max.
- The verify `VerificationRunContext` sets **no `timeoutMs`** (`run-phase.ts:967-983`),
  and `runCommand` only arms a timeout `if (timeoutMs !== undefined)`
  (`packages/execution/src/command-runner.ts:113`), so **each command runs unbounded**.
The only ceiling is the workflow's `startToCloseTimeout: '30 minutes'`
(`packages/workflow/src/task-workflow.ts:22`). With `maximumAttempts: 3` the activity
burns 3 × 30 min ≈ 90 min and then the **whole workflow FAILS** (terminal) — this is
what killed the first dogfood run (observed `STATUS_FAILED`; `phase verify started
(attempt 1)` logged at 21:07 → 21:37 → 22:08, exactly 30 min apart; **zero**
`phase_attempts` / `command_executions` rows persisted because verify never completed a
single pass).

**What to do.** Scope the verify command set to the **changed packages** (the base→head
diff already identifies them) instead of returning the whole discovered matrix; drop
the redundant root full-suite when per-package commands cover the change; and
**exclude the self-booting e2e/integration tests** from the verify gate (run them
elsewhere). Independently, give verify commands a per-command `timeoutMs` so one hung
command can't consume the whole activity budget silently.

**Where.** `command-support.ts:86-101` (`resolveVerificationCommands` — add diff-scope),
`run-phase.ts:941-1006` (`verifyHandler` — set `timeoutMs`, pass changed-package
filter), `verification-runner.ts:142` (serial loop). Relates to the velocity/slice
machinery that already knows the touched files, and to TASK-106 (a scoped verify can't
naively call the per-package `test` script).

**How we'll know it's done.** A single-package change verifies in well under the
timeout, running only that package's tests (not the root suite, not other packages,
not e2e), and a hung command is cut by its own `timeoutMs` rather than the 30-min
activity kill.

### [ ] TASK-105: activity-timeout retries are invisible to the workbench — no attempt bump, no durable trace, and a slow phase is misclassified as a transient infra failure

> **Re-verified against `main` @ `320b2dd` (2026-08-17).** Still an issue;
> `startToCloseTimeout`/`maximumAttempts` and the attempt-counter flow are unchanged
> (the +2 lines that commit added to `task-workflow.ts` were the stacked-PR
> `baseBranch`, unrelated).

**What's wrong.** `attemptNumber` is bumped **in the workflow**, once per phase
dispatch: `task-workflow.ts:215` does `attemptNumber + 1` immediately before
`await activities.runPhase(...)` (`:217`). When that **activity** hits its
`startToCloseTimeout`, Temporal retries the *activity* per the RetryPolicy — but the
**workflow code does not re-execute**; the pending `await` is simply re-dispatched with
the **same input**, so `state.attemptNumber` is frozen and `control-plane-events.ts:70`
emits `phase … started (attempt 1)` every retry (observed: three identical "attempt 1"
events 30 min apart). Consequences:
- The workbench's own no-progress accounting (`failureStreak` /
  `repeated-failure-no-progress`, `task-workflow.ts:252-258`) only counts workflow-level
  `repair` outcomes — it **never sees** activity-timeout retries, so it can neither
  escalate nor de-dupe them.
- A timed-out phase persists **nothing** — no `phase_attempts` row, no
  `command_executions`, no evidence (all written on phase completion, which never
  happens). The run is completely opaque in the DB.
- The RetryPolicy comment (`task-workflow.ts:6-9`) says retries are only for *transient
  infrastructure* failures (provider timeout, GitHub blip, fs hiccup). A verify that is
  legitimately slow because it's over-scoped (TASK-104) is **misclassified** as
  transient, silently burns the 3-attempt budget (≈90 min), then fails the whole
  workflow terminally.

**What to do.** Distinguish "activity is genuinely making progress but slow" from
"transient infra failure." Options: heartbeat long-running phases (so Temporal sees
liveness and a `heartbeatTimeout` replaces the coarse `startToClose`), and/or record a
durable phase-attempt row *at start* so timed-out attempts are counted and visible,
and/or shorten per-command work (TASK-104) so the 30-min ceiling is never approached.
At minimum, an activity retry should be counted as a distinct attempt with a recorded
outcome, not a silent replay of "attempt 1".

**Where.** `packages/workflow/src/task-workflow.ts:2-10` (proxyActivities retry/timeout),
`:215-217` (attempt bump vs activity retry), `:252-258` (no-progress accounting);
`workers/temporal-worker/src/activities/control-plane-events.ts:70` (the "attempt N"
emit). Related to the known cold-restart-on-retry gap (`observability-live-proof`,
TASK-32).

**How we'll know it's done.** A phase that exceeds the activity budget either
heartbeats and continues, or is recorded as a distinct, counted attempt with a
persisted outcome — never a silent "attempt 1" replay that leaves no DB trace.

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
exiting with code 1`. So a *scoped* verify (the TASK-104 fix) can't just shell out to
the package's own `test` script as-is — it would report a false failure.

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

The web app is not a project-management tool with an execution engine bolted on; it
is an **operational control plane for autonomous software work**. The redesign
target: the Board shows what the factory is doing, the Tasks table gives precise
control, Task Detail explains exactly what happened (Phase Attempts → Agent Sessions
→ Model Invocations), Approvals handles human intervention, Verification proves the
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
> audit). The plan doc's build order (foundation → Task Detail → Approvals → Board +
> Overview → Repo Detail) is the recommended sequence and matches TASK-80..85.

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

### [ ] TASK-82: Approvals as a real cross-task human-gate queue (not a task-ID lookup)

**What's wrong.** `/approvals` is a self-described stub: the user must type a
repository id **and** task id, then it shows that one task's gate via `GatePanel`; the
page itself renders a banner admitting "There is no daemon route yet that lists every
pending gate across all tasks" (`apps/web/src/pages/ApprovalsPage.tsx:47-51`). There is
**no** cross-task pending-gate query and **no** `approval_request`/
`ApprovalRequestSummary` projection (the nearest is `human_decisions`,
`schema/evidence.ts:84`, which records decisions, not a pending queue). Human-in-the-
loop is the whole point of the control plane, and it currently requires knowing the
task id in advance.

**What to do.** Make `/approvals` a real inbox. Add a durable pending-gate projection /
list query (`ApprovalRequestSummary`: `gateId, repositoryId, taskId, reason
(HumanGateReason), status, requestedAt, resolvedAt?, phaseAttemptId?, candidateSha?,
summary`) and a `GET /api/approvals` route. Two-pane UI: left = pending gates across
all tasks (reason, task, repo, phase, age, risk, candidate); right = the exact
approval context (what/why, triggering `HumanGateReason` from
`lifecycle.ts:55-75`, proposed operation, affected paths, network destination,
candidate SHA, phase attempt, related acceptance claim, agent rationale, consequence
of denial). Actions: Approve / Deny / Deny-with-instructions / Open task. **Temporal
stays authoritative for actionability** — on approve/deny: revalidate against the live
workflow, submit the Temporal Update, wait for ack, update the projection. Feed a
pending count to the sidebar badge. Cover **every** `HumanGateReason` including
`pr-readiness` (today display-only). Do not invent "approve similar forever" in the
frontend unless the policy model supports it.

**Where.** New projection + `listPendingHumanGates()` in `packages/database/` +
`GET /api/approvals` in `apps/daemon/src/routes/`, reworked
`apps/web/src/pages/ApprovalsPage.tsx` + reusable `GatePanel.tsx` (both prototyped on
`timothyshee/ui-roadmap`). Depends on TASK-80 (projection + `pending_gate_reason`).
Relates to the `brief-reject-flow` and `cli-drivable-completion-gap` learnings.

**How we'll know it's done.** *Manual:* `/approvals` lists every pending gate across
all tasks with no task-id entry, and approving one revalidates against the live
workflow, submits the update, and updates the queue + sidebar badge. *Unit:* the
pending-gate list query returns open gates across active tasks and excludes resolved
ones.

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
`GET /api/overview` reading the projection + approvals count. Depends on TASK-80 (and
TASK-82 for the approvals count). Relates to `ui-roadmap` and `ui-redesign-decisions`.

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
- **No Temporal fan-out for list pages.** Overview/Board/Tasks/Approvals read the
  `task_summary` projection (TASK-80) and stay responsive when Temporal is degraded;
  the live workflow stays authoritative only for mutable state, gate actionability,
  resume, cancel, and approval updates. When Temporal is unavailable: show persisted
  state, label "Live workflow unavailable," disable approve/resume/cancel, keep history
  accessible. When SQLite is behind: prefer live for current phase/condition/gate/token
  total and show a subtle "Updating history" indicator — never show mismatched totals
  without explanation.

**What to do.** Treat this as a standing constraint on the Group-O tasks; call it out
in reviews if any PR reintroduces a run route, a draggable board, a competing status
field, or a global page ahead of its dependency. Sidebar stays lean initially
(Overview / Board / Tasks / Repositories / Approvals / Settings, with a global **Create
Task** button in the shell); Usage + Activity are added later.

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

### [ ] TASK-100: Evaluate external agentic-framework / memory / tooling references

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
  `packages/observability/` (OTel spans, `runtime_attribution`, `context_composition`,
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
