---
name: run-workbench-task
description: Run an implementation task through the Agentic Workbench end to end — boot the stack, register a repo, create a task, approve the contract gate, watch it advance, and triage failures. Use when the user wants to run the workbench against a repo, implement something via the workbench, or drive a task from Claude Code. REQUIRES an absolute path to the target repo.
---

# Run a task through the Agentic Workbench

This repo IS the workbench. It runs against *other* Git repos. Running a task
means: boot the stack, point it at a target repo, create a task, then respond to
human gates as they arise (the contract gate up front; a plan gate only if
planner/critic don't converge; the PR outcome at the end). You do NOT run the
plan→implement→verify→QA→review loop yourself — Temporal owns that. You answer
gates, watch for failure, and signal the final PR outcome.

Everything goes through the `awb` CLI, run buildless with the `cli` script:

```
pnpm --filter @awb/cli cli -- <args>
```

## 0. REQUIRED: the target repo path

**This skill requires an absolute path to the target Git repo. If the user did
not give one, STOP and ask — do not guess, do not default to the workbench, do
not proceed.** The workbench edits real files and opens real PRs on whatever repo
it's pointed at; running it against the wrong repo (or the workbench itself) is a
real hazard. Validate before booting anything:

```
test -d "<REPO_PATH>/.git" && echo OK || echo "NOT A GIT REPO"
```

If that prints anything but `OK` (missing path, not absolute, not a git repo),
stop and ask the user for a valid absolute path. Only continue once it passes.

**Then check for a greenfield / no-remote repo — a valid `.git` is not enough.** A
repo can be a git repo with zero commits and no remote, and both break the workbench
in ways that only surface much later (a wasted live run):

```
git -C "<REPO_PATH>" rev-parse HEAD 2>/dev/null || echo "NO COMMITS"
git -C "<REPO_PATH>" remote -v
```

- **No commits (no `HEAD`):** `repo refresh` hard-fails on `git rev-parse HEAD`.
  Seed one first: `git -C "<REPO_PATH>" commit --allow-empty -m "Initial commit"`.
- **No remote (`origin`):** the happy path ends at a `pr-readiness` gate that expects
  to push/open a PR — there is nowhere to deliver. Decide the delivery story with the
  user *now*, not at the gate: either add a remote, or run "local branch only" and
  plan to land the worktree code directly (see step 7's recover-and-land path).

**Greenfield + large scope is the workbench's worst case.** An empty repo taking a
full-app build trips several gates that a mature-repo change never sees (diff cap,
`program-design` checks, no QA start command — TASK-65..68). If the user asks for a
large greenfield build, say so up front and consider scoping the first task to a
skeleton, or expect and pre-plan for those gates.

Set these for the rest of the run so every command is unambiguous:
- `REPO_PATH` = the validated absolute path (e.g. `/Users/you/GitHub/wip-browser-games`)
- Repo/task ids are remembered between CLI calls, so you pass them only to target
  something other than the most recent. **Arg order is positional: `[repositoryId]
  [taskId]`** — `task cancel <taskId>` alone errors; pass repo first, or rely on the
  remembered "most recent" and pass neither.

## 1. Choose runtime, THEN boot

**`up` defaults to the MOCK runtime** — it produces a fake PR in ~90s and spends
zero tokens. That is a dry-run of the plumbing, NOT a real implementation. To run
a real task with a live agent doing browser QA, export the runtime env **inline
on the same command as `up`** (shell state does not persist between separate CLI
calls, and you must never `down`/`up` mid-task — that wipes in-memory state and
permanently blocks the task):

```
# LIVE run (real agent, real tokens, browser QA):
AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser pnpm --filter @awb/cli cli -- up

# MOCK dry-run (plumbing check only):
pnpm --filter @awb/cli cli -- up
```

Wait for `ready.`. Logs stream to `~/.agentic-workbench/runtime/logs/`.

**If `up` says "runtime already ready", the env you just passed did NOT take.** A warm
stack from a prior session keeps whatever runtime/QA/cap env it booted with — your new
flags are ignored (env is read at worker spawn), and there is currently no way to read
the active runtime back (`/api/health` only returns `{status:"ok"}`; TASK-70). So a
"live" run can silently execute as MOCK. Tells that it's MOCK: a fake PR in ~90s and
zero tokens. If you need specific env and a stack is already warm, `down` then `up`
with the env inline — this is safe **only before a task exists**; never `down`/`up`
mid-task.

### If `up` times out ("Waiting for the daemon to become healthy… timed out")

**Do NOT loop `up` blindly.** A health timeout almost always means the daemon
process crashed on import — read the log first:

```
tail -40 ~/.agentic-workbench/runtime/logs/daemon.log
```

Two common crash causes on a clean checkout (both are build-state, not config):
- `ERR_MODULE_NOT_FOUND: Cannot find package '@awb/…'` → a workspace symlink was
  never materialized. `pnpm install` says "up to date" and does NOT fix it. Run
  `pnpm install --force`.
- `SyntaxError: … does not provide an export named '…'` → a package `dist/` is
  stale (the daemon runs via `tsx` but imports other packages from their built
  `dist/`). Run `pnpm build`. (Its `apps/daemon` test-file TS error is harmless —
  the package dists build fine before it.)

Then `down` the half-started processes and `up` again.

## 2. Register and trust the target repo

```
pnpm --filter @awb/cli cli -- repo add "<REPO_PATH>" --json   # parse the `id`
pnpm --filter @awb/cli cli -- repo refresh                    # discovers structure, records a snapshot
pnpm --filter @awb/cli cli -- repo approve                    # marks trusted — REQUIRED before tasks run
```

A repo is `untrusted` until approved; tasks will not run against an untrusted repo.
(A repo trusted in a prior session stays trusted — the DB persists it.)

## 3. Create the task

```
pnpm --filter @awb/cli cli -- task create --prompt "<what to implement>" --json   # parse `taskId`
```

Write the prompt to name the concrete files/paths the change touches — the
planner and builder ground on it, and a specific prompt converges faster.

## 4. Approve the contract gate

The lifecycle pauses at the **contract** gate. Poll with `task show` — note it
**outputs JSON by default and rejects a `--json` flag** (`error: unknown option`):

```
pnpm --filter @awb/cli cli -- task show
```

Read `pendingHumanGate`. When its `reason` is `task-contract-approval`, confirm
the contract (`state.prompt` is the contract text at v1) matches the user's
intent, then:

```
pnpm --filter @awb/cli cli -- task approve-contract --contract-version 1
```

Do NOT auto-approve without checking — a wrong contract sends the whole task down
the wrong path.

## 5. Watch it advance — AND watch for hard failure

Poll `task show` for `state.phase` / `state.condition` / `pendingHumanGate`. But
the daemon state alone will make a **crashed** workflow look like it's still
running. Also check the raw Temporal workflow status, which surfaces a hard
`Failed`:

```
temporal workflow describe --address 127.0.0.1:7233 \
  -w "awb/task/<repositoryId>/<taskId>" -o json
```

Look at `workflowExecutionInfo.status`: `RUNNING` = healthy; `FAILED` /
`TERMINATED` / `TIMED_OUT` = the run died, go to step 7. When backgrounding a
monitor, cover BOTH signals and emit on every terminal state (a monitor that only
greps for success stays silent through a crash — silence is not success).

Respond only when `condition` is `awaiting-human`, keyed on
`pendingHumanGate.reason`:

| `pendingHumanGate.reason` | Respond with |
| --- | --- |
| `task-contract-approval` | `task approve-contract --contract-version <n>` (or `reject-contract`) |
| `planner-critic-non-convergence` | `task approve-plan --plan-version <n>` (or `reject-plan --reason …`) |
| `pr-readiness` (at `release`) | deliver, then `task pr-merged --sha <sha>` once merged |

Happy path fires only two gates: contract, then `pr-readiness`. The plan gate
fires only if planner/critic can't converge. If `condition` is `blocked` or the
gate `reason` has no CLI command (waiver / permission / budget / scope), STOP and
tell the user — do not fabricate a way past it.

**Non-happy-path gates you may hit (esp. large/greenfield tasks), and what they
really mean:**
- `slice-diff-exceeds-cap` — the implement diff exceeds the velocity cap. Cleared by
  the *reused* `approve-plan` update, but it **re-raises every implement pass with no
  memory of the ack**, so approving loops forever on a legitimately large diff. Do NOT
  loop it: the only real escape is a restart with `AWB_SLICE_DIFF_CAP=0` + a fresh task
  (see TASK-68), which you must clear with the user.
- `repeated-failure-no-progress` — a phase's completion gate keeps failing. This is
  often a workbench false-positive, not bad agent output (e.g. `program-design`'s
  bodyless-signature check, TASK-67). Diagnose the *specific* failing predicate (step
  7) before re-running; do not assume the agent is at fault.
- A `blocked` at `exercise` on a greenfield repo usually means **no QA start command
  exists** (TASK-65) — browser QA has nothing to launch. This is not resolvable by
  approving; it needs a start command wired or the QA story decided with the user.

If a gate loops, or a `blocked` reason has no first-class CLI resolve, treat the
pipeline as stuck and go to step 7 — including the "recover the code directly" path.

**If `task show` returns blank/empty (not an error, not a state):** the CLI itself is
likely the broken link, not the task — a stale `@awb/*` dist crashes the CLI on import
while the daemon+worker (running from source) keep advancing the task (TASK-69). Do
NOT read a blank `task show` as a stall. Rebuild the offending package
(`pnpm --filter @awb/<pkg> build`, or `pnpm build`) and, meanwhile, read ground truth
straight from SQLite (see step 7).

## 6. Complete the task

A task does NOT finish on its own at `release` — it waits for the PR outcome:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
```

`task pr-closed` and `task pr-feedback --feedback-id <id>` signal the other
outcomes. Only after `pr-merged`/`pr-closed` does the task reach
`assimilate` / `completed`.

## 7. When a run fails — triage before re-running

A hard failure is terminal in Temporal: **the workflow cannot be resumed — you
create a fresh task** (the repo stays trusted, so skip re-registering). But
diagnose FIRST; blind re-runs repeat the failure and waste live tokens. The real
error is NOT in `task show`; find it here, in order:

1. **Worker log** — the actual exception + stack:
   `grep -n "Activity failed\|Error:\|returned 500" ~/.agentic-workbench/runtime/logs/worker.log | tail -30`
2. **Semantic events** — the agent's turn-by-turn stream (what it actually did):
   `sqlite3 ~/.agentic-workbench/database/workbench.sqlite "SELECT sequence, occurred_at, phase, producer, type, substr(summary,1,70) FROM semantic_events WHERE run_id='<taskId>-run' ORDER BY sequence;"`
3. **The worktree** — code the agent wrote may be intact even if the DB write
   never fired (do NOT report "0 changes" from a DB count alone):
   `git -C ~/.agentic-workbench/worktrees/<repoId>/<taskId> status --short`
   `git -C ~/.agentic-workbench/worktrees/<repoId>/<taskId> diff`
   Note the agent commits its work, so `status` may be clean while the branch is
   full — check `git log --oneline` and `git diff <baseSha> HEAD` too.
4. **SQLite ground truth** — when the CLI is down (blank `task show`) or you need the
   exact failing predicate, read the DB directly. Useful tables:
   `phase_attempts` (per-phase attempts + outcomes), `program_designs`,
   `repository_commands` (is a `start` command present?), `acceptance_claims`
   (does the contract require QA/behavioral evidence?), `semantic_events`.

Known failure modes seen live (check TASK-31/32/34/65-70 in `docs/TODO.md` for status):
- **`FOREIGN KEY constraint failed` at the plan phase** — a run-state durability
  bug (fixed 2026-07-24; if it recurs, `packages/database/.../run-lifecycle.ts`
  plus a stale `@awb/database` dist is the suspect — rebuild it).
- **`API Error: Connection closed mid-response`** — transport drop from the agent
  SDK on long turns. Retries currently **cold-restart** (no resume — TASK-32), so
  each retry re-explores from scratch and can even drift into the wrong repo
  (TASK-31). A run that spends many minutes with repeated "I'll start by exploring
  the repository structure" in `semantic_events` is stuck in this loop.

Distinguish an **agent/transport failure** (retry/re-run may help) from a
**workbench code bug** (must be fixed first) before re-driving.

### 7a. When the pipeline is stuck but the code is done — recover and land directly

A run can be blocked late (e.g. at `exercise`/QA) with the **implementation already
complete and past `implement` + `verify`**. The deliverable then lives in the worktree
branch even though the task will never reach `release`. Don't throw that away chasing
the gate — recover it:

1. **Confirm the code is real and works** before touching anything — inspect the
   branch (`git -C <worktree> log/diff`) and, for an app, actually boot it (e.g.
   `uvicorn`/`vite` from the worktree) and hit an endpoint. A verified worktree is the
   deliverable.
2. **Recover BEFORE cancelling.** `task cancel` may garbage-collect the worktree — runs
   that blocked *before* implementing leave nothing, and even a completed one is not
   guaranteed to persist. Copy the code out first.
3. **Land it** into the target repo (works with no remote): copy only tracked files,
   excluding `.venv`/build cruft, via
   `git -C <worktree> archive HEAD | tar -x -C "<REPO_PATH>"`, then commit in the
   target repo. Verify a clean-install boot in the target (fresh venv from its own
   manifest) so a new developer can reproduce it.
4. This is the right ending for a **no-remote** run (step 0): there is no PR to sign
   off, so the merged-PR gate never applies — the landed local commit *is* delivery.

## 8. Tear down

```
pnpm --filter @awb/cli cli -- down
```

`task list` shows all tasks created this session.

## Key invariants (do not violate)

- **A target repo path is required** (step 0). Never run against an unspecified
  repo or the workbench itself.
- The browser/CLI never touch fs/git/shell directly — everything goes through the
  daemon API, which `awb` wraps. Stay on the CLI.
- Never `down`/`up` mid-task — it wipes in-memory run state and permanently blocks
  the task.
- Agents never decide a phase is done; only `evaluatePhaseCompletion` does. If a
  phase isn't advancing, read `openFindings` — don't force it.
- A failed Temporal workflow is terminal → fresh task, never a resume.
- See `AGENTS.md` and `docs/temporal-workflows.md` for the full lifecycle.
