# Driving: the gate table and the poll loop

This is the single source of truth for gate answers. Nothing else in the skill
restates it.

You DRIVE; you do not code. Poll one command, read two fields, run the one
command that matches. Every command here is copy-paste ready. Fill in the
`<...>` placeholders only. Do not invent flags or subcommands.

If the route said `stack=isolated`, carry the isolated env inline on every
command below (see `boot.md`).

## The loop

1. **Poll.** `pnpm --filter @awb/cli cli -- task show`
   It prints JSON by default and **rejects a `--json` flag**
   (`error: unknown option`).
2. **Read exactly two fields:** `state.condition`, and
   `pendingHumanGate.reason` (meaningful only when `condition` is
   `awaiting-human`).
3. **Look up the row** below and run the ONE command in it.
4. **Wait about 30 seconds, then poll again.** Repeat until `condition` is
   `completed`, or a row tells you to STOP.

## Decision table

| `state.condition` | `pendingHumanGate.reason` | Run this ONE command |
| --- | --- | --- |
| `running` | any or none | *nothing* — wait, then poll again |
| `awaiting-human` | `task-contract-approval` | Read the contract (below), then `task approve-contract --contract-version <n>` |
| `awaiting-human` | `planner-critic-non-convergence` | `task approve-plan --plan-version <n>`, or `task reject-plan --reason …` |
| `awaiting-human` | `pr-readiness` | The draft PR is open. Deliver, then `task pr-merged --sha <sha>` once merged |
| `awaiting-human` | `slice-diff-exceeds-cap` | STOP — see **Known gates that loop** |
| `blocked` | `repeated-failure-no-progress` | STOP — diagnose first, see `triage.md` |
| `blocked` | anything else | STOP and tell the user |
| `completed` | — | Done. Report the result. |

For `<n>`, use the version shown in `pendingHumanGate` (`contractVersion` /
`planVersion`, or `state.contractVersion` / `state.planVersion`). Use `1` when
you cannot find a number.

The happy path fires two gates only: the contract, then PR readiness. The plan
gate fires only when the planner and the critic fail to converge.

## Contract check — the one place you must read

Before you approve, read `state.prompt` (the contract text at v1) and confirm it
matches what the user asked for. This is a yes-or-no glance, not a rewrite.

- The contract describes the same change the user wanted → approve.
- The contract is about something else, or you are unsure → STOP and show the
  contract text to the user.

A wrong contract sends the whole task down the wrong path. There is no
`reject-contract` CLI command, so a wrong contract is not fixable mechanically.

## PR readiness

The code is done and the draft PR is open. In a DAG, this is also the release
event that unblocks the dependent nodes. Review and merge on GitHub, then:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
pnpm --filter @awb/cli cli -- task pr-closed
pnpm --filter @awb/cli cli -- task pr-feedback --feedback-id <id>
```

Only after `pr-merged` or `pr-closed` does the task reach `completed`.

## Known gates that loop — do not answer them repeatedly

- **`slice-diff-exceeds-cap`** — the implement diff exceeds the velocity cap. The
  reused `approve-plan` update clears it, but it **re-raises on every implement
  pass with no memory of the ack**, so approving loops forever on a legitimately
  large diff. Do not loop it. Either re-slice the work smaller (see
  `decompose.md`), or restart with the cap disabled and a **fresh task**, which
  you must clear with the user first (TASK-68):

  ```
  pnpm --filter @awb/cli cli -- down
  AWB_SLICE_DIFF_CAP=0 AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser \
    pnpm --filter @awb/cli cli -- up
  # then re-create the task; the repo stays trusted
  ```

  The env after `AWB_SLICE_DIFF_CAP=0` is the boot env from `boot.md`. Keep the
  two in sync, and use the isolated form when the route said `stack=isolated`.

- **`repeated-failure-no-progress`** — a phase's completion gate keeps failing.
  This is often a workbench false positive rather than bad agent output (for
  example the `program-design` bodyless-signature check, TASK-67). Diagnose the
  specific failing predicate with `triage.md` before you re-run. Do not loop
  `approve`.

- **A `blocked` at `exercise` on a greenfield repo** usually means no QA start
  command exists (TASK-65), so browser QA has nothing to launch. Approving does
  not clear it. Wire a start command, or settle the QA story with the user.

When a gate reason has no row here, or a `blocked` reason has no first-class CLI
resolution (waiver, permission, budget, scope), STOP and tell the user. Do not
fabricate a way past it.

## Crash check — a dead task looks like a running one

Daemon state alone makes a **crashed** workflow look like it is still `running`.
Every few polls, also check the raw Temporal status:

```
temporal workflow describe --address 127.0.0.1:7233 \
  -w "awb/task/<repositoryId>/<taskId>" -o json
```

Read `workflowExecutionInfo.status`. `RUNNING` is healthy. `FAILED`,
`TERMINATED`, or `TIMED_OUT` means the run died — go to `triage.md`. A failed
workflow is terminal and cannot be resumed; you create a fresh task.

When you background a monitor, cover BOTH signals and emit on every terminal
state. A monitor that greps only for success stays silent through a crash, and
silence is not success.

## If `task show` returns blank

A blank result — not an error, not a state — on a task that WAS advancing usually
means a stale `@awb/*` dist crashed the CLI on import, while the daemon and the
worker (running from source) keep advancing the task (TASK-69). Do NOT read a
blank `task show` as a stall. Rebuild (`pnpm --filter @awb/<pkg> build`, or
`pnpm build`), and meanwhile read ground truth from SQLite (see `triage.md`).

## Driving many tasks at once (a fleet)

When several tasks run at once — a declared DAG, or independent tasks — drive
them all from **one** session with a single poll loop.

```
pnpm --filter @awb/cli cli -- fleet --md
```

`awb fleet` composes one legible row per task from SQLite in a single call:
phase, condition, current activity and its age, the bounce-back signal
`#N ↩<phase>`, open findings, and the PR. `--md` is the agent-legible default,
`--json` a stable named-field contract, and `--watch` a live human TUI. Prefer it
over `task list`, which shows no rollups.

Rules learned the hard way (TASK-115):

1. **Do not spawn one subagent per task.** A context-inheriting fork believes it
   is the coordinator, re-narrates the whole fleet, and may drive *other* tasks.
   Each also tends to answer one poll and end its turn, then goes idle and its
   watchdog reports a false stall.
2. **Loop inside your own turn.** Poll every 45–90 seconds with a bounded wait
   (one `sleep 60` shell call, then re-poll). Never fire one poll and end the
   turn expecting to be woken.
3. **Read the pending gate from the daemon**, not from a raw SQLite column:
   `task show <repositoryId> <taskId>`.
4. **Apply the same decision table per task.** When one task's reason is not in
   the table, STOP that task and hand it back. Keep driving the others.
5. **Respect the concurrency cap.** The stack bounds how many tasks run heavy
   phases at once (`AWB_MAX_CONCURRENT_ACTIVITIES`, default 4). Keep to about
   five live tasks on a laptop. Ten concurrent tasks bury the machine under
   parallel test runs.
