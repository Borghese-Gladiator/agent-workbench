---
name: wb-drive
description: Drive a workbench task through its lifecycle from the terminal, without the web UI — create a task, then clear each human gate with judgment (read the brief/plan/diff, approve or bounce, answer mid-run questions). Use when asked to run a task end-to-end, drive the workbench headless, or reproduce a lifecycle run via the CLI.
profile: any
---

# Drive a workbench task headless (`wb` CLI)

The workbench is normally driven from the web UI, but the daemon owns all state
and exposes the full lifecycle over HTTP. The `wb` CLI (`@workbench/client`) is a
typed wrapper over that API. This skill drives a task from intake to closeout
**from a Claude Code session**, where — unlike `wb task drive`, which approves
every gate blindly — you read each artifact and decide.

## When to use which

- **`pnpm wb task drive <id>`** — fire-and-forget. Clears all 4 gates in
  sequence. Right for a smoke run or a mock-runtime task where you trust the
  output. It approves unconditionally; it does not read artifacts.
- **This skill (gate-by-gate, below)** — when the run matters: a real
  (`claude`-runtime) task where you should inspect the brief, plan, and diff and
  may bounce or abandon. Prefer this for anything you'd actually ship.

## Prerequisites

1. **A running daemon.** Check it: `pnpm wb projects` (lists projects, or errors
   if the daemon is down). If down, the user must start it — suggest they run
   `! pnpm daemon` in this session (it listens on `:4417`; override with
   `WORKBENCH_URL`). Do not start the daemon yourself in the background unless
   asked; it holds the SQLite DB open.
2. **A project.** `pnpm wb projects`. To register one:
   `pnpm wb project create --name N --repo /abs/path --branch main --runtime claude --test "pnpm test" --typecheck "pnpm typecheck"`.
   A `claude`-runtime project's `--repo` must exist on disk.

## The lifecycle (where the gates are)

```
intake → task_brief → [human_brief_approval] → discovery → [human_plan_approval] →
implementation → verification → agent_self_review → [human_review] →
delivery_prep → [human_delivery_approval] → publish → closeout
```

Approving a gate auto-advances the non-gate stages server-side and parks at the
next gate. You only act at the four `[bracketed]` gates.

## Procedure

1. **Create the task** (or take an existing id):
   `pnpm wb task create --project <pid> --title "…" --request "…"`
   → note the returned task id.

2. **Generate the brief and reach the first gate:**
   `pnpm wb task show <id>` — if `stage` is `intake`/`task_brief`, kick it:
   `pnpm wb task action <id> generate-brief`. The task parks at
   `human_brief_approval`.

3. **At each gate, READ before you decide.** `pnpm wb task show <id>` lists the
   task's artifacts with their ids; read a body with
   `pnpm wb task artifact <artifactId>` (prints the markdown verbatim). The
   gate → what to read:
   - `human_brief_approval` → the `task_brief` artifact. Does it capture the
     real intent?
   - `human_plan_approval` → the `execution_plan` artifact. Is the plan sound?
   - `human_review` → the `self_review` artifact **and the worktree diff**
     (`pnpm wb task diff <id>`). Does the change do what was asked, and is it
     clean?
   - `human_delivery_approval` → the `delivery_package` artifact (the PR/merge
     target). Right destination?

4. **Decide and act** (the daemon enforces the legal moves):
   - **Approve:** `pnpm wb task action <id> approve-brief` (or `approve-plan`,
     `review/complete`, `approve-delivery`).
   - **Reject / bounce** (sends feedback back to the agent — a comment is
     required): `pnpm wb task action <id> reject-brief --comment "…"` (or
     `reject-plan`, `reject-delivery`), or
     `pnpm wb task action <id> review/bounce --target implementation --comment "…"`
     (target is `implementation` or `discovery`). The comment is the
     only guidance the regenerated artifact gets — make it specific.
   - **Abandon** (terminal): `pnpm wb task action <id> review/abandon --comment "…"`.

5. **Mid-run questions.** A `claude`-runtime agent may pause to ask. The gate
   stays blocked until every open question is answered — `task action` will 409
   with "answer the open question(s) first". Answer them through the daemon
   (`GET /api/tasks/:id/questions/unanswered`, then the answer endpoint) or via
   the web UI's question card, then retry the gate.

6. **Confirm closeout.** `pnpm wb task show <id>` → `stage: closeout`,
   `status: done`. For a real delivery, the `delivery_package` artifact carries
   the PR URL.

## Notes

- Base URL: `--url`, else `WORKBENCH_URL`, else `http://127.0.0.1:4417`. Set
  `WORKBENCH_URL` once if you run a non-default port.
- A self-targeting project (repoPath == the workbench's own checkout) **refuses
  the skip-worktree path** — every task there gets an isolated worktree. That's
  by design; do not try to force direct mode.
- This skill does not weaken any gate. Reject/bounce always carry a reason so the
  agent gets actionable feedback.
