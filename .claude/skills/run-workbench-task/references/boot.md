# Boot, stack isolation, and teardown

Read this before you type any `up` command. Step 0 of `SKILL.md` already told you
whether `stack=shared` or `stack=isolated`.

## The runtime env decides whether the run is real

**Always pass the runtime explicitly, inline on the same command as `up`.** Shell
state does not persist between separate CLI calls. The worker reads the env when
it spawns.

```
# LIVE run — real agent, real tokens, browser QA. Use this unless told otherwise:
AWB_AGENT_RUNTIME=claude AWB_QA_MODE=browser pnpm --filter @awb/cli cli -- up --quiet
```

Wait for `ready.`.

**A bare `up` runs MOCK, and MOCK is not a real implementation.** It produces a
fake PR in about 90 seconds and spends zero tokens. `mock` is the code-level
fallback (`workers/temporal-worker/src/activities/agent-factory.ts:22-23`): an
unset *or misspelled* runtime degrades to `mock` so the deterministic tests stay
offline. A typo therefore gives you a fake run instead of an error. Omit the env
only for a deliberate plumbing dry-run:

```
# MOCK dry-run (plumbing check only):
pnpm --filter @awb/cli cli -- up
```

**If `up` says "runtime already ready", the env you just passed did NOT take.** A
warm stack keeps whatever runtime, QA, and capability env it booted with. There
is no way to read the active runtime back — `/api/health` returns only
`{status:"ok"}` (TASK-70). So a "live" run can silently execute as MOCK. The
tells are a fake PR in about 90 seconds and zero tokens.

To force specific env onto a warm stack, run `down`, then `up` with the env
inline. **This is safe only before a task exists.** Never `down`/`up` mid-task.

## `DATA_DIR` — resolve it once, use it for every path

Logs, the SQLite database, and the worktrees all hang off one root:
`AWB_DATA_DIR` when set, otherwise `~/.agentic-workbench`
(`packages/config/src/paths.ts:4-6`).

```
DATA_DIR="${AWB_DATA_DIR:-$HOME/.agentic-workbench}"
```

Logs stream to `$DATA_DIR/runtime/logs/`. If you booted an isolated stack, every
path in these references must be re-rooted at that stack's data dir. The default
root belongs to a *different* stack and tells you nothing about your run.

## When `up` times out

"Waiting for the daemon to become healthy… timed out" almost always means the
daemon crashed on import. **Do not loop `up` blindly. Read the log first:**

```
tail -40 "$DATA_DIR/runtime/logs/daemon.log"
```

Two common causes on a clean checkout, both build-state and not config:

- `ERR_MODULE_NOT_FOUND: Cannot find package '@awb/…'` — a workspace symlink was
  never materialized. `pnpm install` reports "up to date" and does NOT fix it.
  Run `pnpm install --force`.
- `SyntaxError: … does not provide an export named '…'` — a package `dist/` is
  stale. The daemon runs through `tsx` but imports other packages from their
  built `dist/`. Run `pnpm build`. The `apps/daemon` test-file TS error is
  harmless; the package dists build before it.

Then `down` the half-started processes and `up` again.

---

# Isolated stacks (`stack=isolated`)

Use an isolated stack whenever the target repo is a workbench checkout, or a
shared MAIN stack is already warm. Isolation lets your run proceed without ever
touching the MAIN stack or the task it may be serving.

## 1. Confirm what is warm, then route around it

```
curl -sf http://127.0.0.1:4417/api/health   # MAIN daemon (default AWB_DAEMON_PORT)
nc -z 127.0.0.1 7233                        # MAIN Temporal (default AWB_TEMPORAL_PORT)
```

If either responds, a MAIN stack is live. Route around it. Never `down` it, never
create a task against it, and never ask the user which stack to use.

## 2. Isolation is derived, not random

`isolatedOverrides` (`packages/config/src/runtime-config.ts:117-143`) computes a
per-stack offset from a **tag** and shifts every service port by it, then
suffixes the queue, the OTel container, and the data dir with `-<tag>`:

- `AWB_DAEMON_PORT = DEFAULT_DAEMON_PORT + base`
- `AWB_TEMPORAL_PORT = DEFAULT_TEMPORAL_PORT + base`
- `AWB_UI_PORT`, `AWB_OTEL_OTLP_PORT`, `AWB_OTEL_UI_PORT` — same stride
- `AWB_TASK_QUEUE = awb-task-queue-<tag>`
- `AWB_DATA_DIR = <base>-<tag>`

where `tag = deriveIsolationTag(sha256(workspaceRoot))`
(`packages/config/src/runtime-config.ts:105-107`).

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
  pnpm --filter @awb/cli cli -- up --isolated --json
```

Bump the `AWB_DATA_DIR` suffix alongside the ports. Two stacks that share one
data dir corrupt each other. Re-probe the chosen ports before `up`. Never boot
onto a port you have not verified is free.

## 4. Read and print the stack coordinates

`up --isolated --json` emits them (`apps/cli/src/commands/lifecycle.ts:157-176`):

- `ok` — `true` when the isolated stack is healthy
- `stack.daemonUrl`, `stack.temporalAddress`, `stack.taskQueue`, `stack.dataDir`

Print them so the run is auditable:

```
isolated stack: daemon http://127.0.0.1:44xx, temporal 127.0.0.1:72xx,
queue awb-task-queue-<tag>, data dir <base>-<tag>
```

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

---

# Teardown

```
# stack=shared
pnpm --filter @awb/cli cli -- down

# stack=isolated — env inline, never a bare `down`
AWB_DATA_DIR="<stack.dataDir>" \
AWB_DAEMON_PORT="<isolated daemon port>" \
AWB_TEMPORAL_PORT="<isolated temporal port>" \
  pnpm --filter @awb/cli cli -- down
```

A bare `down` during an isolated run stops the shared MAIN stack and blocks
whatever task it was serving. After an isolated teardown, confirm MAIN is still
healthy: `curl -sf http://127.0.0.1:4417/api/health`.

`task list` shows all tasks created this session.
