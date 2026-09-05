---
name: run-workbench-task
description: The single entry point for running work through the Agentic Workbench. Routes the request to the right shape (one task, a stacked-PR DAG, a self-hosted change to this repo, or a task that is already running), boots the right stack (shared or isolated), creates the task or the whole graph, and drives the gates to draft PRs. Use whenever the user wants the workbench to implement, fix, refactor, or ship something; wants a big request split into stacked PRs; wants to dogfood the workbench against itself; or wants an existing task advanced or triaged. REQUIRES an absolute path to the target repo.
---

# Run work through the Agentic Workbench

This repo IS the workbench. It runs against a target Git repo — sometimes against
itself. This skill is the only entry point. You answer four routing questions,
then run ONE pipeline.

You never run the plan → implement → verify → QA → review loop yourself. Temporal
owns that loop. You route, you boot, you create, you answer gates, and you land.

Detail lives in `references/`. Load a reference only when the router sends you
there. Do not read all five up front.

| Reference | Load it when |
| --- | --- |
| `references/boot.md` | Before you type any `up` command, always. |
| `references/gates.md` | At Step 5, always. Holds the one gate table. |
| `references/decompose.md` | The route says `shape=dag`. |
| `references/self-host.md` | The route says `self-host=yes`. |
| `references/triage.md` | A task fails, blocks, or stalls. |

All commands use the `awb` CLI. Run it buildless from a checkout:

```
pnpm --filter @awb/cli cli -- <args>
```

---

## Step 0 — Route (three probes and one judgment call)

Run the probes. Write the route on one line and print it, so the run is
auditable:

```
route: shape=<single|dag|drive-only> stack=<shared|isolated> self-host=<yes|no>
```

| # | Question | Probe | If yes |
| --- | --- | --- | --- |
| 1 | Does a task already exist, and were you asked only to advance it? | `pnpm --filter @awb/cli cli -- task show` prints a task | `shape=drive-only` — skip to **Step 5** |
| 2 | Is the target repo a workbench checkout? | `grep -q '"name": "agentic-workbench"' "$TARGET/package.json"` | `self-host=yes`, `stack=isolated` |
| 3 | Is a shared MAIN stack already warm? | `curl -sf http://127.0.0.1:4417/api/health` | `stack=isolated` |
| 4 | Is the request more than one reviewable PR? | judgment — see below | `shape=dag` |

**Question 4 is the only judgment call.** Answer `dag` when any of these holds:

- The work crosses two or more seams the repo already has (schema, then API,
  then UI; a migration, then the code that reads it).
- One PR would be too large to review honestly, or would trip the slice diff cap.
- The user says "split this", "break this up", or "stacked PRs".

Answer `single` for one self-contained change. A one-node DAG is a normal task
with ceremony. When you are unsure, propose the split to the user and let them
choose.

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
  gate. Either add a remote, or plan to land the worktree branch locally (see
  `references/triage.md`).
- **Greenfield plus a large scope is the worst case.** An empty repo trips the
  diff cap, the `program-design` checks, and the missing QA start command. Say so
  up front. Scope the first task to a skeleton.

---

## Step 2 — Boot the stack

**Read `references/boot.md` and copy the command from there.** Do not type an
`up` command from memory. `boot.md` owns the runtime env, the MOCK trap, the
warm-stack trap, the isolated-stack derivation, and the boot-failure triage.

- `stack=shared` — one `up` with the runtime env inline.
- `stack=isolated` — `up --isolated`, a free-port probe first, and the isolated
  env re-passed inline on **every** later command, including Steps 3 to 7.

A stack booted without the runtime env runs MOCK, which produces a fake PR in
about 90 seconds and proves nothing.

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

Branch on the route.

**`self-host=yes`** — read `references/self-host.md` FIRST. It sets up the
controller and target split and the `plan.md` that the task prompt quotes. Then
create the task against the target worktree, never against the controller
checkout.

**`shape=single`**:

```
pnpm --filter @awb/cli cli -- task create --prompt "<what to implement>" --json
```

Name the concrete files and paths in the prompt. The planner and the builder
ground on the prompt text. A specific prompt converges in fewer passes and
produces a smaller diff.

**`shape=dag`** — read `references/decompose.md`. Propose the split, get explicit
approval from the user, then declare the whole graph in one atomic call. Do not
create the nodes one at a time. Do not set base branches by hand.

---

## Step 5 — Drive the gates

**Read `references/gates.md`.** It holds the one gate table, the poll loop, the
multi-task fleet loop, and the crash check. The short form:

1. Poll `task show`, or `awb fleet --md` for several tasks.
2. Read `state.condition` and `pendingHumanGate.reason`.
3. Run the one command that matches the row.
4. Wait, then poll again.

The happy path fires two gates: the contract up front, then PR readiness at the
end. Approve nothing before you read the contract text.

---

## Step 6 — Finish

A task does not finish on its own at `release`. It waits for the PR outcome:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
```

`task pr-closed` and `task pr-feedback --feedback-id <id>` signal the other two
outcomes. Only after one of these does the task reach `assimilate` and
`completed`.

The workbench opens DRAFT PRs and never marks them ready. Do not run
`gh pr ready`, do not clear the draft flag, and do not request reviewers — even
when an approved plan lists "mark ready" as a step. That step belongs to the
human.

When the task fails, blocks, or stalls, read `references/triage.md`. Diagnose
before you re-run. A failed Temporal workflow is terminal, so you create a fresh
task. You never resume one.

---

## Step 7 — Tear down

`references/boot.md` carries the teardown for both stack modes. An isolated stack
needs its env inline. A bare `down` hits the default ports and stops the shared
MAIN stack, which may be serving another task.

---

## Key invariants (do not violate)

- **A target repo path is required.** Never run against an unspecified repo.
- **Never `down`/`up` mid-task.** It wipes in-memory run state and blocks the
  task permanently. In a DAG it costs you every downstream node too.
- **Never touch the shared MAIN stack when `stack=isolated`.** No task, no gate
  command, and no `down` on the default ports.
- **The browser and the CLI never touch fs, git, or the shell directly.**
  Everything goes through the daemon API, which `awb` wraps. Stay on the CLI.
- **Agents never decide that a phase is done.** Only `evaluatePhaseCompletion`
  does. When a phase does not advance, read `openFindings`. Do not force it.
- **You drive; the workbench writes the code.** Edit source yourself only where
  `references/self-host.md` permits it, and say so in the report.
- **The draft PR is the terminal state.** The human reviews and merges.

See `AGENTS.md` and `docs/temporal-workflows.md` for the full lifecycle.
