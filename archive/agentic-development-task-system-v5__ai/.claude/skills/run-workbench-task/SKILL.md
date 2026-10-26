---
name: run-workbench-task
description: The single entry point for running work through the Agentic Workbench. Use to implement or fix something via the workbench, split a big request into stacked draft PRs, dogfood the workbench against its own repo, or drive and triage a task that is already running. REQUIRES an absolute path to the target repo.
---

# Run work through the Agentic Workbench

This repo IS the workbench. It runs against a target Git repo — sometimes
against its own. This skill is the only entry point.

**Do not write the code, run the tests, or open the PR yourself.** Each task does
that inside its own leased git worktree, and only `evaluatePhaseCompletion`
decides that a phase advanced — an agent's own "done" is a candidate, never a
decision. Your job is six commands and the gate answers between them: probe,
boot, register, create, answer gates, signal the PR outcome. Then you read the
diff yourself, because a task's success message is not evidence.

Everything goes through the `awb` CLI, because the daemon API is the only writer
of filesystem, git, and shell state. Run it buildless from a checkout:

```
pnpm --filter @awb/cli cli -- <args>
```

Three references hold the conditional detail. Load one only when the router
sends you there; the rest of the run is in this file.

| Reference | Load it when |
| --- | --- |
| `references/isolated-stack.md` | The route says `stack=isolated`. |
| `references/decompose.md` | The route says `shape=dag`. |
| `references/triage.md` | A task fails, blocks, or stalls, or `up` times out. |

---

## Step 0 — Route (three probes and one judgment call)

Run the probes. Print the route on one line, so the run is auditable:

```
route: shape=<single|dag|drive-only> stack=<shared|isolated> target=<this-repo|other-repo>
```

| # | Question | Probe | If yes |
| --- | --- | --- | --- |
| 1 | Does a task already exist, and were you asked only to advance it? | `pnpm --filter @awb/cli cli -- task show` prints a task | `shape=drive-only` — skip to **Step 5** |
| 2 | Is the target repo this workbench repo? | `grep -q '"name": "agentic-workbench"' "$TARGET/package.json"` | `target=this-repo`, `stack=isolated` |
| 3 | Is a shared MAIN stack already warm? | `curl -sf http://127.0.0.1:4417/api/status` | `stack=isolated` |
| 4 | Is the request more than one reviewable PR? | judgment — see below | `shape=dag` |

**Question 4 is the only judgment call.** Answer `dag` when any of these holds:

- The work crosses two or more seams the repo already has (schema, then API,
  then UI; a migration, then the code that reads it).
- One PR would be too large to review honestly, or would trip the slice diff cap.
- The user says "split this", "break this up", or "stacked PRs".

Answer `single` for one self-contained change. A one-node DAG is a normal task
with ceremony. When you are unsure, propose the split and let the user choose.

Questions 2 and 3 both set `stack=isolated`. A warm MAIN stack is a reason to
isolate, never a question to raise with the user.

---

## Step 1 — Preflight the target repo (always)

**This skill requires an absolute path to the target Git repo. If the user did
not give one, STOP and ask.** Do not guess. Do not default to this repo. The
workbench edits real files and opens real PRs against whatever you point it at.

Set `TARGET` to the validated absolute path, then run all three probes:

```
test -d "$TARGET/.git" && echo OK || echo "NOT A GIT REPO"
git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "NO COMMITS"
git -C "$TARGET" remote -v
```

- **Not a git repo, or the path is not absolute:** STOP and ask for a valid path.
- **No commits:** `repo refresh` hard-fails on `git rev-parse HEAD`. Seed one
  first: `git -C "$TARGET" commit --allow-empty -m "Initial commit"`.
- **No remote:** the happy path ends at a gate that expects to open a PR. There
  is nowhere to deliver. Settle the delivery story with the user now, not at the
  gate. Either add a remote, or plan to land the worktree branch locally
  (`references/triage.md`).
- **Greenfield plus a large scope is the worst case.** An empty repo trips the
  diff cap, the `program-design` checks, and the missing QA start command. Say so
  up front. Scope the first task to a skeleton.

---

## Step 2 — Boot the stack

**Always pass the runtime inline on the same command as `up`.** Shell state does
not persist between CLI calls, and the worker reads the env when it spawns.

```
# LIVE run — real agent, real tokens, browser QA. Use this unless told otherwise:
AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser pnpm --filter @awb/cli cli -- up --quiet
```

Wait for `ready.`.

**A bare `up` runs MOCK, and MOCK is not a real implementation.** It produces a
fake PR in about 90 seconds and spends zero tokens. `mock` is the code-level
fallback (`resolveAgentRuntime` in `workers/temporal-worker/src/activities/agent-factory.ts`): an
unset *or misspelled* runtime degrades to `mock` so the deterministic tests stay
offline, so a typo gives you a fake run instead of an error. Omit the env only
for a deliberate plumbing dry-run.

**If `up` says "runtime already ready", the env you just passed did NOT take.** A
warm stack keeps whatever env it booted with. You do not have to guess which:
`up` reports the running env, and names every difference from what you asked for.

```
pnpm --filter @awb/cli cli -- up --json     # alreadyReady, runtimeConfig, envMismatch
pnpm --filter @awb/cli cli -- status --json # runtimeConfig on a stack you did not boot
```

A non-empty `envMismatch` means your env did NOT take — the plain-text form
prints `runtime already ready [...]` plus a warning listing each difference.
**Read it before you create a task**, or a "live" run executes as MOCK. To force
new env, `down` then `up` with the env inline — **safe only before a task
exists**. Never `down`/`up` mid-task: it wipes in-memory run state and blocks the
task permanently, and in a DAG it costs you every downstream node.

**`stack=isolated`** — read `references/isolated-stack.md` and boot from there
instead. It owns the free-port probe, the stack coordinates, and the env you must
re-pass inline on every later command, including Steps 3 to 8.

**`target=this-repo`** — boot the controller from a **pinned** build, never
`awb up --dev`. `--dev` runs the worker and daemon from live source through
`tsx watch`, so a save hot-reloads the runtime while it is orchestrating itself.
Pinned is the default:

```
pnpm -C "$TARGET" build
```

**`DATA_DIR` — resolve it once, use it everywhere.** Logs, the SQLite database,
and the leased worktrees all hang off one root (`resolveDataDir` in
`packages/config/src/paths.ts`):

```
DATA_DIR="${AWB_DATA_DIR:-$HOME/.agentic-workbench}"
```

Logs stream to `$DATA_DIR/runtime/logs/`. Under an isolated stack, re-root every
path at that stack's data dir — the default root is a *different* stack and tells
you nothing about your run.

If `up` times out, do NOT loop it. Go to `references/triage.md`.

---

## Step 3 — Register and trust the target repo

```
pnpm --filter @awb/cli cli -- repo add "$TARGET" --json   # parse the id
pnpm --filter @awb/cli cli -- repo refresh                # records a snapshot
pnpm --filter @awb/cli cli -- repo approve                # trusted — required
```

A repo stays `untrusted` until you approve it, and tasks do not run against an
untrusted repo. Trust persists in SQLite, so a repo approved in an earlier
session stays approved.

Repo and task ids are remembered between calls. You pass them only to target
something other than the most recent. The order is positional:
`[repositoryId] [taskId]`.

---

## Step 4 — Create the work

The task edits its own leased worktree under `$DATA_DIR/worktrees/`, created with
`git worktree add` in the registered repo (`packages/workspace/src/worktree.ts`).
Your registered checkout's working tree is never touched.

Write the prompt so it carries all of this:

- the behavior the user asked for, in their terms;
- the concrete files and paths the change touches — the planner and the builder
  ground on the prompt text, and a specific prompt converges in fewer passes and
  produces a smaller diff;
- the instruction to make the smallest correct change;
- the requirement to add focused tests;
- the requirement not to land, push, or delete the worktree.

**`shape=single`**:

```
pnpm --filter @awb/cli cli -- task create --prompt "<the prompt>" --json
```

**`shape=dag`** — read `references/decompose.md`. Propose the split, get explicit
approval, then declare the whole graph in one atomic call. Do not create nodes
one at a time. Do not set base branches by hand.

**`target=this-repo`** — read `AGENTS.md` first and quote its constraints into
the prompt. It is authoritative for architecture, layout, and prohibited
patterns: strict TypeScript with no `any`, Zod at process and persistence
boundaries, no I/O in `@awb/workflow`, Temporal I/O only in
`workers/temporal-worker/src/activities/`, all writes through the daemon. For
worker changes, also read `workers/temporal-worker/src/activities/AGENTS.md`.

---

## Step 5 — Drive the gates

Poll one command, read two fields, run the one command that matches. Fill in the
`<...>` placeholders only; do not invent flags or subcommands. Under
`stack=isolated`, carry the isolated env inline on every command here.

1. **Poll.** `pnpm --filter @awb/cli cli -- task show`
   It prints JSON by default and **rejects a `--json` flag**
   (`error: unknown option`).
2. **Read two fields:** `state.condition`, and `pendingHumanGate.reason`
   (meaningful only when `condition` is `awaiting-human`).
3. **Run the one command** from the row below.
4. **Wait about 30 seconds, then poll again.** Repeat until `condition` is
   `completed`, or a row says STOP.

| `state.condition` | `pendingHumanGate.reason` | Run this ONE command |
| --- | --- | --- |
| `running` | any or none | *nothing* — wait, then poll again |
| `awaiting-human` | `task-contract-approval` | Read the contract (below), then `task approve-contract --contract-version <n>` |
| `awaiting-human` | `planner-critic-non-convergence` | `task approve-plan --plan-version <n>`, or `task reject-plan --reason …` |
| `awaiting-human` | `pr-readiness` | The draft PR is open — go to **Step 6** |
| `awaiting-human` | `slice-diff-exceeds-cap` | STOP — see **Gates that loop** |
| `blocked` | `repeated-failure-no-progress` | STOP — `references/triage.md` |
| `blocked` | anything else | STOP and tell the user |
| `completed` | — | Done. Report the result. |

For `<n>`, use the version in `pendingHumanGate` (`contractVersion` /
`planVersion`, or `state.contractVersion` / `state.planVersion`). Use `1` when
you cannot find a number.

The happy path fires two gates: the contract, then PR readiness. The plan gate
fires only when the planner and the critic fail to converge.

### Contract check — the one place you must read

Before you approve, read `state.prompt` (the contract text at v1) and confirm it
matches what the user asked for. This is a yes-or-no glance, not a rewrite. If
the contract is about something else, or you are unsure, STOP and show the text
to the user. A wrong contract sends the whole task down the wrong path, and there
is no `reject-contract` command, so it is not fixable mechanically.

### Gates that loop — do not answer them repeatedly

- **`slice-diff-exceeds-cap`** — the implement diff exceeds the velocity cap. The
  reused `approve-plan` update clears it, but it **re-raises on every implement
  pass with no memory of the ack**, so approving loops forever on a legitimately
  large diff. Either re-slice smaller (`references/decompose.md`), or restart
  with the cap disabled and a **fresh task**, which you must clear with the user
  first:

  ```
  pnpm --filter @awb/cli cli -- down
  AWB_SLICE_DIFF_CAP=0 AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser \
    pnpm --filter @awb/cli cli -- up
  # then re-create the task; the repo stays trusted
  ```

- **`repeated-failure-no-progress`** — a phase's completion gate keeps failing.
  Often a workbench false positive rather than bad agent output (for example the
  `program-design` bodyless-signature check). Diagnose the specific failing
  predicate before you re-run. Do not loop `approve`.

- **A `blocked` at `exercise` on a greenfield repo** usually means no QA start
  command exists, so browser QA has nothing to launch. Approving does not clear
  it. Wire a start command, or settle the QA story with the user.

When a gate reason has no row here, or a `blocked` reason has no CLI resolution
(waiver, permission, budget, scope), STOP and tell the user. Do not fabricate a
way past it.

### Two ways a task lies about being alive

- **A crashed workflow still reads as `running`** in daemon state. Every few
  polls, check Temporal directly and read `workflowExecutionInfo.status`:
  `temporal workflow describe --address 127.0.0.1:7233 -w "awb/task/<repositoryId>/<taskId>" -o json`.
  `RUNNING` is healthy; `FAILED`, `TERMINATED`, or `TIMED_OUT` means it died — go
  to `references/triage.md`. When you background a monitor, cover both signals: a
  monitor that greps only for success stays silent through a crash.
- **A blank `task show`** — not an error, not a state — usually means a stale
  `@awb/*` dist crashed the CLI on import while the daemon and worker keep
  advancing the task. Do NOT read it as a stall. Rebuild (`pnpm build`), and read
  SQLite meanwhile (`references/triage.md`).

### Driving several tasks at once

A declared DAG, or independent tasks, are driven from **one** session with a
single poll loop:

```
pnpm --filter @awb/cli cli -- fleet --md
```

`awb fleet` composes one row per task from SQLite in a single call: phase,
condition, current activity and its age, the bounce-back signal `#N ↩<phase>`,
open findings, and the PR. Prefer it over `task list`, which shows no rollups.

- **Do not spawn one subagent per task.** A context-inheriting fork believes it
  is the coordinator, re-narrates the fleet, and may drive *other* tasks. It also
  tends to answer one poll and end its turn, then idles into a false stall.
- **Loop inside your own turn** — poll every 45–90 seconds with one bounded
  `sleep`, then re-poll. Never fire one poll and end the turn expecting a wake-up.
- **Read the pending gate from the daemon**, not from a raw SQLite column.
- **Keep to about five live tasks on a laptop.** Heavy phases are bounded by
  `AWB_MAX_CONCURRENT_ACTIVITIES` (default 4), but ten tasks still bury the
  machine under parallel test runs.

---

## Step 6 — Verify the result yourself (every repo, not just this one)

The task reached `pr-readiness`. **Its success message is not evidence.** None of
these prove success on their own: a completion message, daemon state, database
row counts, grep or string-match QA, or a clean checkout. The diff plus observed
verification are the source of truth.

1. **Read the whole diff** on the task's branch — not the summary of it.
2. **Compare it against what you asked for.** Look for unrelated edits, missing
   tests, architecture violations, and abstraction nobody asked for.
3. **Run the target's own build and tests** against the leased worktree:
   `pnpm -C "$DATA_DIR/worktrees/<repoId>/<taskId>" build` and `… test`, or that
   repo's equivalent. Report observed results, never expected ones. If a step
   cannot run, say exactly which one and why.
4. **Read the diff once more for correctness.** A green build and passing
   grep-based QA routinely coexist with real runtime and data-integrity bugs, so
   this is a separate pass, not a formality: data integrity, edits outside scope,
   accidental generated files, stale comments, tests that assert implementation
   details instead of behavior.

A MOCK run proves plumbing only. It never proves model-driven behavior.

**When something is wrong, repair with another focused task** against the same
target: give it the observed failure, the relevant diff or test output, the
expected behavior, and an instruction to fix only that defect. **Cap it at two
rounds.** If the same substantive failure survives twice, stop delegating,
diagnose it directly, and either fix it or report the blocker accurately. Say so
explicitly whenever you edited source by hand instead of delegating.

Report what changed, the branch, each verification step as PASS, FAIL, or
SKIPPED, and the runtime you used (MOCK or CLAUDE).

---

## Step 7 — Finish

A task does not finish on its own at `release`. It waits for the PR outcome:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
pnpm --filter @awb/cli cli -- task pr-closed
pnpm --filter @awb/cli cli -- task pr-feedback --feedback-id <id>
```

Only after `pr-merged` or `pr-closed` does the task reach `assimilate` and
`completed`. In a DAG, the open draft PR is also the release event that unblocks
the dependent nodes.

The workbench opens DRAFT PRs and never marks them ready. Do not run
`gh pr ready`, do not clear the draft flag, and do not request reviewers — even
when an approved plan lists "mark ready" as a step. That belongs to the human.

When a task fails, blocks, or stalls, read `references/triage.md` and diagnose
before you re-run.

---

## Step 8 — Tear down

```
pnpm --filter @awb/cli cli -- down
```

Under `stack=isolated`, tear down with the isolated env inline
(`references/isolated-stack.md`). A bare `down` hits the default ports and stops
the shared MAIN stack, which may be serving another task.

See `AGENTS.md` and `docs/temporal-workflows.md` for the full lifecycle.
