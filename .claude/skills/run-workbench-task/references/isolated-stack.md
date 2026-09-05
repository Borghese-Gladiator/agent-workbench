# Isolated stacks (`stack=isolated`)

Load this when the route says `stack=isolated` — the target repo is this
workbench repo, or a shared MAIN stack is already warm. Isolation lets your run
proceed without ever touching the MAIN stack or the task it may be serving.

Everything in Step 2 of `SKILL.md` still applies: the runtime env goes inline,
`up --isolated` alone still runs MOCK.

## 1. Confirm what is warm, then route around it

```
curl -sf http://127.0.0.1:4417/api/status   # MAIN daemon (default AWB_DAEMON_PORT)
nc -z 127.0.0.1 7233                        # MAIN Temporal (default AWB_TEMPORAL_PORT)
```

If either responds, a MAIN stack is live. Route around it. Never `down` it, never
create a task against it, and never ask the user which stack to use.

## 2. The slot is derived from the workspace root

`isolatedOverrides` (`packages/config/src/runtime-config.ts`) shifts every
default port by an offset derived from a tag, and suffixes the task queue, the
OTel container, and the data dir with that same tag. You never compute this —
`up --isolated --json` prints the resulting coordinates.

**The tag is a pure function of the workspace root.** Two isolated stacks booted
from the SAME worktree derive the same tag, so they take the same ports and the
same data dir, and they collide. Isolation protects you from *other* worktrees,
not from a second stack in the *same* one.

## 3. Probe the derived ports BEFORE `up`

```
nc -z 127.0.0.1 "$AWB_DAEMON_PORT"   && echo "daemon port BUSY"
nc -z 127.0.0.1 "$AWB_TEMPORAL_PORT" && echo "temporal port BUSY"
```

If the derived slot is free, boot with plain `--isolated`. If either port is
busy, pick a next-free slot and pass explicit overrides. Derived values are set
only when unset, so an explicit env var always wins:

```
AWB_DAEMON_PORT=<next-free> AWB_TEMPORAL_PORT=<next-free> \
AWB_DATA_DIR="<base>-<tag>-2" \
AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser \
  pnpm --filter @awb/cli cli -- up --isolated --json
```

Bump the `AWB_DATA_DIR` suffix alongside the ports. Two stacks that share one
data dir corrupt each other. Re-probe the chosen ports before `up`. Never boot
onto a port you have not verified is free.

## 4. Read and print the stack coordinates

`up --isolated --json` emits them (the `up` action in
`apps/cli/src/commands/lifecycle.ts`):

- `ok` — `true` when the isolated stack is healthy
- `stack.daemonUrl`, `stack.temporalAddress`, `stack.taskQueue`, `stack.dataDir`
- `runtimeConfig` and `envMismatch` — the env the stack actually runs under

Print them so the run is auditable:

```
isolated stack: daemon http://127.0.0.1:44xx, temporal 127.0.0.1:72xx,
queue awb-task-queue-<tag>, data dir <base>-<tag>
```

`stack.dataDir` is your `DATA_DIR` for the rest of the run. Every path in
`SKILL.md` and `references/triage.md` re-roots there.

## 5. Re-pass the isolated env inline on EVERY later command

Shell state does not persist between CLI calls, so the isolation env set during
`up` is gone on the next command. A command without this env hits the default
ports — that is, the shared MAIN stack. This is the exact mistake isolation
exists to prevent.

```
AWB_DATA_DIR="<stack.dataDir>" \
AWB_DAEMON_PORT="<isolated daemon port>" \
AWB_TEMPORAL_PORT="<isolated temporal port>" \
AWB_TASK_QUEUE="<stack.taskQueue>" \
  pnpm --filter @awb/cli cli -- <repo|task|fleet|...> ...
```

When in doubt, compare the command's target against `stack.dataDir` before you
run it.

## 6. Tear down only your own stack

```
AWB_DATA_DIR="<stack.dataDir>" \
AWB_DAEMON_PORT="<isolated daemon port>" \
AWB_TEMPORAL_PORT="<isolated temporal port>" \
  pnpm --filter @awb/cli cli -- down
```

A bare `down` during an isolated run stops the shared MAIN stack and blocks
whatever task it was serving. Afterwards, confirm MAIN is still healthy:
`curl -sf http://127.0.0.1:4417/api/status`.
