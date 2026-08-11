# Backlog
Prioritized List of Things to Fix

Every task should have what is wrong / what to do, where, and how we'll know when it's done


## Group I — Delivery & stacked PRs

The two ways a finished change fails to *land*: no origin to open a PR against,
and no way to stack one task's branch on the previous task's branch.

### [ ] TASK-71: No `origin` → task can't deliver; should branch + merge to local `master` instead

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

### [ ] TASK-72: Stacked-PR DAG — tasks whose branches stack on one another with distinct bases

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

### [ ] TASK-74: Repo discovery can't complete on large monorepos (fender, ~620 packages) — scan times out / retry-loops

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

### [ ] TASK-75: `exercise` QA-evidence gate parks a finished, verified change at `repeated-failure-no-progress` (repairs `implement`, which can't fix an evidence deficiency)

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

### [ ] TASK-76: A prompt/skill that lets even a weak local model *drive* a task (not code it)

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

### [ ] TASK-77: Dogfood the workbench on *this* repo (agent-workbench itself)

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
