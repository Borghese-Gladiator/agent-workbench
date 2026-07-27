# @awb/cli

## Purpose

The `awb` command-line entry point. Separates the **runtime** (Temporal + worker
+ daemon) from the **optional UI** (Vite frontend) so machines and agents can
start the minimum they need without launching a browser.

## Command surface

**Runtime**
- `up` — start the core runtime (Temporal, worker, daemon) and wait until healthy.
  Idempotent, detached, quiet on success.
- `down` — stop all AWB-managed local services (never deletes data).
- `restart [service]` — restart the runtime, or one service and its dependents.
- `status [service]` — one-line health; `--verbose` table, `--json` machine form.
  Exits nonzero when the required runtime is unhealthy.
- `logs [service]` — last 50 lines then exit; `--tail`, `--since`, `--follow`.
- `doctor` — diagnose dependencies, ports, and local state; `--json`, `--fix`.

**User interface**
- `open` — ensure runtime + UI are up, then open the browser.
- `ui up|down|restart|status|logs` — manage the frontend (`ui up --no-deps` skips
  starting runtime dependencies).

**Work**
- `repo add|list|show|current|sync|approve|remove|open` — manage registered
  repositories (`ls`/`inspect`/`refresh`/`rm` retained as aliases). `add .`,
  `show .`, and `current` resolve the repository from the current directory.
- `task create|list|show|wait|watch|result|logs|cancel|retry|open` plus the
  contract/plan/PR signal commands. `wait` blocks quietly for automation;
  `watch` streams live events for humans.

**Configuration**
- `init` — initialize the local data directory.
- `config get|set|list` — view/modify `config.yaml` (validated on set).
- `completion [bash|zsh]` — shell completions.
- `reset runtime|logs|data` — scoped resets (`data` requires `--yes`).

**Daemon-specific**
- `daemon run|ping|reload` — foreground run, health ping, in-place restart.
  Generic process ops use the shared commands (`status daemon`, `logs daemon`,
  `restart daemon`).

## Global output contract

`-q/--quiet` (results only), `--json` (stable machine output; implies no
color/prompts), `-v/--verbose`, `--no-color`, `--no-input`. Errors go to stderr;
requested data to stdout.

## Design

- `services.ts` is the single registry of managed services (label, port, pid
  key, start command). `health.ts` derives per-service state from the daemon's
  `/api/status` plus port/PID fallbacks. `process-control.ts` owns spawn/stop.
- Business logic lives in the packages the CLI calls into (`@awb/repository`,
  `@awb/config`), not in command handler bodies. Command handlers only open the
  shared DB connection (`db.ts`) and shape output.

## Dependencies

`@awb/config`, `@awb/database`, `@awb/domain`, `@awb/repository`, `commander`.
