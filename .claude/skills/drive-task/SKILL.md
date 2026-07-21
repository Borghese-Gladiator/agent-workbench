---
name: drive-task
description: Drive an implementation task through the Agentic Workbench end to end — boot the stack, register a repo, create a task, approve the contract gate, and watch it advance. Use when the user wants to run the workbench against a repo, implement something via the workbench, or drive a task from Claude Code.
---

# Drive a task through the Agentic Workbench

This repo IS the workbench. It runs against *other* Git repos. Driving a task
means: boot the stack, point it at a target repo, create a task, then respond
to human gates as they arise (the contract gate up front; a plan gate only if
planner/critic don't converge; the PR outcome at the end). You do NOT run the
plan→implement→verify→QA→review loop yourself — Temporal owns that. You only
answer gates and signal the final PR outcome.

Everything below goes through the `awb` CLI. Run it buildless with the `cli`
script, or as `node apps/cli/dist/index.js` after `pnpm build`. This skill
uses the script form so no build step is needed:

```
pnpm --filter @awb/cli cli -- <args>
```

(Or `pnpm link` the CLI once to get a bare `awb <args>`.)

## 1. Boot the stack

One command boots Temporal, the worker, and the daemon, and waits for health:

```
pnpm --filter @awb/cli cli -- up
```

Wait for it to print `ready.`. Logs stream to `~/.agentic-workbench/runtime/logs/`.
If it times out, read those logs before retrying — do not loop `up` blindly.

## 2. Register and trust the target repo

```
pnpm --filter @awb/cli cli -- repo add /abs/path/to/target/repo --json
```

Parse the `id` from the JSON. The CLI also *remembers* the last repo id, so
the next two commands can omit it:

```
pnpm --filter @awb/cli cli -- repo refresh   # discovers structure, records a snapshot
pnpm --filter @awb/cli cli -- repo approve   # marks it trusted (required before tasks run)
```

A repo is `untrusted` until approved; tasks will not run against an untrusted repo.

## 3. Create the task

```
pnpm --filter @awb/cli cli -- task create --prompt "<what to implement>" --json
```

Parse the `taskId`. It's remembered too, so later commands can omit it.

## 4. Approve the contract gate

The lifecycle pauses at the **contract** gate for human approval — this is the
one place a human (or you, on the user's behalf) must confirm the workbench
understood the task. Poll until the gate is pending:

```
pnpm --filter @awb/cli cli -- task show
```

Look at `pendingHumanGate` in the JSON. When it names the contract gate,
inspect the `state`'s contract, confirm it matches the user's intent, then:

```
pnpm --filter @awb/cli cli -- task approve-contract --contract-version 1
```

Do NOT auto-approve without checking the contract text against what the user
asked for — a wrong contract sends the whole task down the wrong path.

## 5. Watch it advance, and answer any further gates

Poll `task show` and read `state.phase`, `state.condition`, and
`pendingHumanGate`. The workbench runs plan → implement → verify → QA → review
autonomously; `evaluatePhaseCompletion` (not the agent) decides each phase
advanced. You do NOT drive the loop — Temporal does. You only respond when
`condition` is `awaiting-human`, keyed on `pendingHumanGate.reason`:

| `pendingHumanGate.reason` | Respond with |
| --- | --- |
| `task-contract-approval` | `task approve-contract --contract-version <n>` (or `reject-contract`) |
| `planner-critic-non-convergence` | `task approve-plan --plan-version <n>` (or `reject-plan --reason ...`) |
| `pr-readiness` (at `release`) | deliver, then `task pr-merged --sha <sha>` once the PR merges |

On the happy path only two gates fire: the contract gate, then `pr-readiness`
at `release`. The plan gate fires only if the planner and critic can't
converge. If `condition` is `blocked` or `pendingHumanGate.reason` is one the
CLI has no command for (waiver / permission / budget / scope), stop and tell
the user — do not fabricate a way past it.

## 5b. Complete the task

A task does NOT finish on its own at `release` — it waits for the PR outcome.
Once the (draft) PR is delivered and merged on the target repo, signal it:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
```

`task pr-closed` (closed without merge) and `task pr-feedback --feedback-id <id>`
signal the other PR outcomes. Only after `pr-merged`/`pr-closed` does the task
reach `assimilate` / `completed`.

`pnpm --filter @awb/cli cli -- task list` shows all tasks created this session.

## 6. Tear down

```
pnpm --filter @awb/cli cli -- down
```

## Key invariants (do not violate)

- The browser/CLI never touch fs/git/shell directly — everything goes through
  the daemon API, which the `awb` CLI wraps. Stay on the CLI.
- Agents never decide a phase is done; only `evaluatePhaseCompletion` does. If
  a phase isn't advancing, read `openFindings`, don't force it.
- A repo must be `approve`d (trusted) before any task runs against it.
- See `AGENTS.md` and `docs/temporal-workflows.md` for the full lifecycle.
```
