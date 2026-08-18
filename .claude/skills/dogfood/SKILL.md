---
name: dogfood
description: Dogfood the Agentic Workbench against ITSELF — run a task through the workbench from a controller checkout while a shared MAIN stack may already be warm, without ever touching that MAIN stack. Companion to run-workbench-task. Use when the target repo IS this workbench checkout and a MAIN stack could be serving another task. Always boots an ISOLATED stack; never asks "isolated or shared?".
---

# Dogfood the Agentic Workbench against itself

This is the self-hosting companion to `run-workbench-task`. Dogfooding means the
target repo IS a workbench checkout, and a **shared MAIN stack may already be
running another task**. The single rule that makes that safe: you **always** boot
your own **isolated** stack and route every command at it, so the shared MAIN
stack and its active task are never touched.

`run-workbench-task` owns the actual task-driving loop (contract → lifecycle →
gates → PR outcome). This skill owns only the isolation wrapper around it. Read
`run-workbench-task` for everything about answering gates; do **not** duplicate
its gate table here.

Everything goes through the `awb` CLI, run buildless with the `cli` script:

```
pnpm --filter @awb/cli cli -- <args>
```

## 0. Non-negotiable first step: ALWAYS `awb up --isolated` (never ask "isolated or shared?")

The very first action is an **isolated** boot. Do not survey the environment and
ask the user whether to share the MAIN stack — the answer is always isolated.
A warm MAIN stack is a reason to isolate, not a question to raise.

```
pnpm --filter @awb/cli cli -- up --isolated --json
```

(Continue to step 4 before actually running this — the `--json` output is parsed
there, and the derived ports must be probed first.)

## 1. Detect a warm MAIN stack + active task and route AROUND it via isolation

Up front, detect whether a shared MAIN stack is already running — but only to
confirm you must stay clear of it, never to prompt for a decision. `awb up` on
the default ports prints **`runtime already ready`** when a MAIN stack is warm;
you can also probe the default daemon/Temporal ports directly:

```
curl -sf http://127.0.0.1:4417/api/health   # MAIN daemon (default AWB_DAEMON_PORT)
nc -z 127.0.0.1 7233                         # MAIN Temporal (default AWB_TEMPORAL_PORT)
```

If either responds, a MAIN stack (possibly with an active task) is live. Route
**around** it with isolation — never `down`/`up` it, never create a task against
it, never ask the user which stack to use.

## 2. Boot isolated and read the emitted stack coordinates

`awb up --isolated --json` emits the isolated stack's coordinates (see
`apps/cli/src/commands/lifecycle.ts:157-176`). Parse and print them:

- `ok` — `true` when the isolated stack is healthy
- `stack.daemonUrl` — the isolated daemon URL
- `stack.temporalAddress` — the isolated Temporal address
- `stack.taskQueue` — the isolated task queue
- `stack.dataDir` — the isolated data dir

These four coordinates are what every later `awb` command must target. Print them
so the run is auditable, e.g.:

```
isolated stack: daemon http://127.0.0.1:44xx, temporal 127.0.0.1:72xx,
queue awb-task-queue-<tag>, data dir <base>-<tag>
```

## 3. Automatic slot selection + the same-worktree collision

Isolation is derived, not random. `isolatedOverrides`
(`packages/config/src/runtime-config.ts:117-143`) computes a per-stack offset
from a **tag** and shifts every service's default port by it, then suffixes the
queue / OTel container / data dir with `-<tag>`:

- `AWB_DAEMON_PORT = DEFAULT_DAEMON_PORT + base`
- `AWB_TEMPORAL_PORT = DEFAULT_TEMPORAL_PORT + base`
- `AWB_UI_PORT`, `AWB_OTEL_OTLP_PORT`, `AWB_OTEL_UI_PORT` — same stride
- `AWB_TASK_QUEUE = awb-task-queue-<tag>`
- `AWB_DATA_DIR = <base>-<tag>`

where `tag = deriveIsolationTag(sha256(workspaceRoot))`
(`packages/config/src/runtime-config.ts:105-107`).

**The tag is a pure function of the workspace root.** Two isolated stacks booted
from the **same** worktree therefore derive the **same** tag → the same ports and
the same data dir → they **collide**. Isolation protects you from _other_
worktrees, not from a second stack in the _same_ one.

## 4. Free-port probe the derived ports BEFORE `up`; on collision, fall back to a next-free slot

Because a same-worktree second stack collides, confirm the derived
`AWB_DAEMON_PORT` / `AWB_TEMPORAL_PORT` are actually free **before** booting:

```
# derived values (compute the tag/offset, or read a dry `up --isolated --json`)
nc -z 127.0.0.1 "$AWB_DAEMON_PORT"   && echo "daemon port BUSY"
nc -z 127.0.0.1 "$AWB_TEMPORAL_PORT" && echo "temporal port BUSY"
```

If the derived slot is free, boot with plain `--isolated`. If either port is
busy, pick a **next-free slot** and pass explicit overrides — per
`isolatedOverrides`, derived values are only set **if unset**, so an explicit
env var always wins:

```
AWB_DAEMON_PORT=<next-free> AWB_TEMPORAL_PORT=<next-free> \
AWB_DATA_DIR="<base>-<tag>-2" \
  pnpm --filter @awb/cli cli -- up --isolated --json
```

Bump the `AWB_DATA_DIR` suffix alongside the ports so the second stack also gets
its own SQLite/state dir (otherwise the two stacks share one data dir and corrupt
each other). Re-probe the chosen ports and confirm they are free **before** `up`
— never boot onto a port you have not verified is open.

## 5. Target EVERY subsequent `awb` command at the isolated stack

Shell state does **not** persist between separate CLI calls, so the isolation env
set during `up` is gone on the next command. Re-pass the isolated coordinates
**inline on every call** — repo, task, gate, and status commands all:

```
AWB_DATA_DIR="<stack.dataDir>" \
AWB_DAEMON_PORT="<isolated daemon port>" \
AWB_TEMPORAL_PORT="<isolated temporal port>" \
AWB_TASK_QUEUE="<stack.taskQueue>" \
  pnpm --filter @awb/cli cli -- <repo|task|...> ...
```

A command run without this env hits the **default** ports — i.e. the shared MAIN
stack. That is exactly the mistake this skill exists to prevent. If in doubt,
diff the command's target against `stack.dataDir` before running it.

## 6. Answer gates by reference to `run-workbench-task`

Once the isolated stack is up and every command is scoped to it, drive the task
exactly as `run-workbench-task` describes: register + trust the target repo,
create the task, approve the **contract** gate, watch it advance (daemon state
**and** raw Temporal status), and signal the final PR outcome. Its gate table
(`task-contract-approval` / `planner-critic-non-convergence` / `pr-readiness`),
its failure-triage steps, and its recover-and-land path all apply unchanged —
just with the isolated env inline on each call.

Do not restate that table here; follow `run-workbench-task` and keep this skill
to the isolation concern only.

## 7. Tear down ONLY the isolated stack

Teardown targets the isolated stack's env inline — **never** a bare `down`, which
would hit the default ports and stop the shared MAIN stack (and its active task):

```
AWB_DATA_DIR="<stack.dataDir>" \
AWB_DAEMON_PORT="<isolated daemon port>" \
AWB_TEMPORAL_PORT="<isolated temporal port>" \
  pnpm --filter @awb/cli cli -- down
```

Confirm the MAIN stack is still healthy afterward (`curl -sf
http://127.0.0.1:4417/api/health`) — teardown of the isolated stack must leave it
untouched.

## Key invariants (do not violate)

- **Isolated always.** The first step is `awb up --isolated`, unconditionally.
  Never surface "isolated or shared?" as a question.
- **Never touch the shared MAIN stack.** No task, no `down`, no `up`, no gate
  command on the default ports. It may be serving another task.
- **Never `down`/`up` the MAIN stack mid-task** — it wipes in-memory run state and
  permanently blocks whatever task it is running.
- **Confirm the slot is free before boot.** The isolation tag is derived from the
  workspace root, so a second stack from the same worktree collides — free-port
  probe the derived ports and fall back to an explicit next-free slot first.
- **Re-pass the isolated env inline on every command.** Shell state does not
  persist; an unscoped command silently targets the shared MAIN stack.
- Gate-answering, failure triage, and delivery are owned by `run-workbench-task`;
  this skill only guarantees isolation around it.
