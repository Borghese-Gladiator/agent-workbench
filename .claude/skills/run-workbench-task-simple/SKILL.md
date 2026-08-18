---
name: run-workbench-task-simple
description: Mechanically DRIVE (not code) a task that is already running through the Agentic Workbench — poll one command, read one field, run the one matching command. A judgment-free decision table for weak/small models; the stripped-down companion to run-workbench-task. Use when a workbench task exists and you only need to answer gates and advance it to pr-readiness. To boot the stack, register a repo, and create the task first, use run-workbench-task instead.
---

# Drive a workbench task (mechanical loop for a weak model)

You are DRIVING a task, not coding it. A stronger model (or the workbench's own
real path) writes the code. Your ONLY job: keep polling, read one field, run the
one command that matches. Do not think about the code. Do not improvise commands.

**Every command in this skill is copy-paste-ready. Run them exactly. Only fill in
`<...>` placeholders. Do not invent flags or subcommands not shown here.**

All commands use the buildless CLI:

```
pnpm --filter @awb/cli cli -- <args>
```

Repo and task ids are remembered between calls, so you normally omit them.

---

## PRECONDITION: a task must already exist

This skill starts AFTER `up` + `repo add/refresh/approve` + `task create`. If none
of that has happened, STOP and use the `run-workbench-task` skill first, then come
back here to drive.

Confirm a task exists:

```
pnpm --filter @awb/cli cli -- task show
```

If that errors or prints nothing about a task, STOP — the task isn't set up. (A
*blank* result on a task that WAS running can also be a broken CLI build, not a
missing task — see the last section.)

---

## THE LOOP (do this over and over)

**Step 1 — Poll.** Run:

```
pnpm --filter @awb/cli cli -- task show
```

**Step 2 — Read exactly two fields** from the JSON it prints:
- `state.condition`
- `pendingHumanGate.reason` (only meaningful when `condition` is `awaiting-human`)

**Step 3 — Look up the row** in the table below and run the ONE command in it.

**Step 4 — Wait ~30s, then go back to Step 1.** Repeat until `condition` is
`completed`, or a row tells you to STOP.

That is the entire job. Never do anything not in the table.

### Decision table

| `state.condition` | `pendingHumanGate.reason` | Run this ONE command |
| --- | --- | --- |
| `running` | (any / none) | *nothing* — wait 30s, poll again |
| `awaiting-human` | `task-contract-approval` | See **Contract check** below, then `task approve-contract --contract-version <n>` |
| `awaiting-human` | `planner-critic-non-convergence` | `task approve-plan --plan-version <n>` |
| `awaiting-human` | `pr-readiness` | STOP — hand back to the operator to deliver the PR (see **PR-readiness**) |
| `awaiting-human` | `slice-diff-exceeds-cap` | STOP — needs a restart with a flag; see **Auto-resolutions** |
| `blocked` | `repeated-failure-no-progress` | STOP — see **Auto-resolutions** |
| `blocked` | anything else | STOP and tell the operator (see **STOP list**) |
| `completed` | — | Done. Report success. |

`<n>` for the version flags: use the version number shown in `pendingHumanGate`
(look for `contractVersion` / `planVersion`, or `state.contractVersion` /
`state.planVersion`). If you cannot find a number, use `1`.

---

## Contract check (the ONE place you must read, briefly)

Before approving the contract, read `state.prompt` (the contract text) from
`task show` and confirm it matches what the operator asked for. This is a
yes/no glance, not a rewrite:

- The contract describes the same feature/fix the operator wanted → **approve**:
  ```
  pnpm --filter @awb/cli cli -- task approve-contract --contract-version <n>
  ```
- The contract is about something clearly different, or you are unsure → **STOP**
  and show the operator the contract text. Do NOT approve a wrong contract — it
  sends the whole task down the wrong path.

There is **no `reject-contract` CLI command**. If the contract is wrong, you
cannot fix it mechanically — STOP and hand back to the operator.

---

## PR-readiness (the happy ending — hand off, don't push)

When `pendingHumanGate.reason` is `pr-readiness`, the code is done and the task is
waiting for a real PR to be opened/merged. A weak driver does NOT push code or
open PRs. STOP here and tell the operator: "Task reached pr-readiness — ready to
deliver." The operator (or a stronger model) delivers, then signals the outcome
with one of:

```
pnpm --filter @awb/cli cli -- task pr-merged --sha <merge-commit-sha>
pnpm --filter @awb/cli cli -- task pr-closed
pnpm --filter @awb/cli cli -- task pr-feedback --feedback-id <id>
```

Only after `pr-merged`/`pr-closed` does the task reach `completed`.

---

## Auto-resolutions (known gates with a scripted answer — but they need the operator)

These gates have a *known* fix, but the fix is a stack restart, which is NOT
something a weak driver should do alone (a wrong `down`/`up` permanently blocks a
task). When you hit one, STOP and give the operator this exact recipe:

- **`slice-diff-exceeds-cap`** (the diff is legitimately large): approving loops
  forever — it re-raises every implement pass. The only real fix is a restart with
  the cap disabled + a **fresh task**:
  ```
  pnpm --filter @awb/cli cli -- down
  AWB_SLICE_DIFF_CAP=0 AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser \
    pnpm --filter @awb/cli cli -- up
  # then re-create the task (repo stays trusted)
  ```
- **`repeated-failure-no-progress`** (a phase's completion check keeps failing):
  this is often a workbench false-positive, not bad agent output. It needs a human
  to diagnose the *specific* failing predicate (worker log + semantic events).
  STOP and hand back — do not loop `approve`.

Do not attempt these yourself. Report the gate and the recipe; let the operator
run the restart.

---

## STOP list (never try to resolve these — hand back to the operator)

STOP and tell the operator whenever any of these is true. These are NOT driver
decisions:

- `condition` is `blocked` and the reason is anything other than the auto-resolvable
  ones above (waiver / permission / budget / scope gates have no CLI command).
- The contract does not match the operator's intent (see Contract check).
- `pendingHumanGate.reason` is a value NOT in the decision table.
- The task looks dead (see crash check below).
- Anything is ambiguous. When in doubt, STOP. Driving is mechanical; a real
  decision belongs to the operator.

---

## Crash check (a dead task can look like a running one)

The daemon state alone will make a **crashed** workflow look like it's still
`running`. Roughly every few polls, also check the raw Temporal status:

```
temporal workflow describe --address 127.0.0.1:7233 \
  -w "awb/task/<repositoryId>/<taskId>" -o json
```

Read `workflowExecutionInfo.status`:
- `RUNNING` → healthy, keep looping.
- `FAILED` / `TERMINATED` / `TIMED_OUT` → the run died. STOP and tell the operator.
  A failed workflow is terminal — it cannot be resumed; the operator must create a
  fresh task. Do not keep polling a dead task forever.

---

## If `task show` returns blank (not an error, not a state)

A blank result on a task that WAS advancing usually means the **CLI build is
stale**, not that the task stalled — the daemon+worker keep running while the CLI
crashes on import. Do NOT read a blank `task show` as a stall or a stop. Tell the
operator: "task show is blank — CLI likely needs a rebuild (`pnpm build`)." Then
STOP; rebuilding is not a driver action.

---

## Driving MANY tasks at once (a fleet) — TASK-115

When several tasks run at once, drive them all from **one** session with a single
poll loop — do **not** spawn one context-inheriting subagent per task.

**Why not per-task subagents (the anti-pattern, learned the hard way):** a
`fork`-style subagent inherits the whole controller conversation, so it believes it
is the coordinator, re-narrates the entire fleet, and may drive *other* tasks
(double-driving). Each also tends to answer one poll then end its turn — with no
external scheduler to wake it, it goes idle and its watchdog reports "stalled: no
progress." Net: more confusion and more stalls than driving directly.

**Do this instead — one in-session poll loop over all task ids:**

1. Keep the list of `(repositoryId, taskId)` you are driving.
2. Every ~45–90s, for each task read its gate reason ONCE (cheap): `task show
   <repo> <task>` and read `pendingHumanGate.reason` (the pending gate is only
   authoritative from the daemon, not from a raw SQLite column).
3. For any task at a gate, apply the SAME decision table above
   (contract→approve, plan→approve, else STOP that one and hand back). Continue.
4. Loop **inside your own turn** with a bounded wait (`sleep 60` in one shell
   call, then re-poll) — never fire a single poll and end the turn expecting to be
   woken.
5. **Respect the concurrency cap.** The stack now bounds how many tasks run heavy
   phases at once (`AWB_MAX_CONCURRENT_ACTIVITIES`, default 4) so the box can't be
   thrashed — you don't need to stagger task creation yourself, but don't try to
   force more than a handful through at once on a laptop.

If a task's gate reason isn't in the table (blocked / waiver / budget / scope) or
anything is ambiguous, STOP that task and hand it back — keep driving the others.

---

## Key invariants (do not violate)

- You DRIVE, you do not CODE. Never edit files, never push, never open a PR.
- Run only the commands shown here. Never invent a flag or subcommand.
- Never `down`/`up` mid-task on your own — it permanently blocks the task. The
  restart recipes above are for the operator to run.
- When the reason isn't in the table, or anything is ambiguous: STOP and hand back.
- For deep triage, the full lifecycle, and how to boot/register from scratch, see
  the `run-workbench-task` skill and `AGENTS.md`. This skill is only the
  mechanical driving loop.
