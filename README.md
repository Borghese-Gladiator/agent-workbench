# Agentic Workbench

A local-first system that autonomously implements software tasks in existing
Python and TypeScript Git repositories. A task moves through a fixed lifecycle —
specify → plan → prepare → implement → verify → exercise (QA) → challenge
(adversarial review) → release → assimilate — and every phase transition is
decided by deterministic, workbench-owned policy code, never by an agent's
self-report. Agents produce **candidates and evidence**; the workbench decides
whether a phase is done.

Three properties define the design, each a direct response to how the previous
iterations fell short (see `archive/README.md` for the full v1–v4 history and
`docs/decisions/` for the choices made here):

- **Deterministic completion.** `evaluatePhaseCompletion` (pure code in
  `packages/workflow`) is the only thing that advances a phase. An agent cannot
  mark its own work complete.
- **Mandatory QA evidence.** The exercise phase requires a real recording/trace
  *and* passing structured assertions tied to the exact candidate SHA — a video
  alone never passes (`deriveQaStatus()` in `packages/qa/src/shared.ts`).
- **Durable orchestration.** Temporal owns the lifecycle state machine, so a
  crash mid-task resumes rather than restarting, and a failed phase loops back
  carrying only the relevant findings instead of resetting the whole context.

## Where to start

- **Agents** working in this repo: read `AGENTS.md` first — it is the single
  source of truth for architecture, the `awb` command contract, and the
  invariants not to break.
- **Reading the design**: `docs/design.md` (why it is built this way),
  `docs/domain-model.md` (entity model), `docs/temporal-workflows.md` (lifecycle
  mechanics), `docs/storage.md`, `docs/security.md` (trust boundaries — read
  before assuming any isolation guarantee), `docs/observability.md`,
  `docs/testing.md`, `docs/dependencies.md` (package graph). Each `packages/*`
  also has its own `README.md` covering purpose and non-responsibilities.

## Requirements

Node ≥ 20, pnpm, Git, ripgrep, FFmpeg, `gh` CLI, and the Temporal CLI
(`brew install temporal`).

## Running it

One command installs, boots the whole runtime (OTel collector, Temporal dev
server, worker, and daemon), and waits until the daemon reports healthy:

```bash
pnpm install
awb up            # boots the runtime, waits for /api/health; awb down tears it down
```

`awb up --dev` runs the worker and daemon from live source via `tsx watch`
(hot reload) instead of the pinned `dist` build. Logs stream to
`~/.agentic-workbench/runtime/logs/`; tail them with `awb logs daemon --tail 50`.
The web dashboard is optional (`awb ui up`, on :5317) — the CLI drives
everything on its own.

`awb` becomes available by symlinking the wrapper (which runs the live TS source
via `tsx`, no build step) onto your `PATH` once:

```bash
ln -sf "$PWD/apps/cli/bin/awb.sh" ~/.local/bin/awb   # ~/.local/bin must be on $PATH
```

Without the symlink, `pnpm --filter @awb/cli cli -- <args>` runs the same CLI
from inside the repo.

### Driving a task

```bash
awb repo add /path/to/some/real/git/repo --json   # registers the repo, remembers its id
awb repo sync                                       # discover its build/test commands
awb repo approve                                    # trust the discovered snapshot
awb task create --prompt "..." --json               # creates the task, remembers its id
awb task show                                        # inspect the current phase + gate
awb task approve-contract --contract-version 1      # cross the first human gate
awb task wait                                        # block until the task settles (for scripts)
```

Repo and task ids are remembered between commands, so you only pass them to
target something other than the most recent. To drive a full task from Claude
Code, use the `.claude/skills/run-workbench-task` skill.

To run the runtime processes by hand instead (e.g. to watch each one's output),
start them in this order — the worker compiles `packages/workflow` first because
Temporal's bundler needs a real `task-workflow.js`, not live TS:

```bash
temporal server start-dev
pnpm --filter @awb/temporal-worker dev
pnpm --filter @awb/daemon dev
```

## Layout

```
apps/                    cli, daemon (Fastify API), web (React/Vite dashboard)
workers/temporal-worker  Temporal Activities (the only place I/O happens) + Workflow registration
packages/                domain, config, database, evidence, repository,
                         repository-map, repository-memory, workflow, workspace,
                         execution, agent-gateway, capability-broker, planning,
                         verification, qa, review, github, policy, telemetry —
                         see docs/dependencies.md for the dependency graph
scripts/                 durable developer tooling
docs/                    design docs + docs/decisions/ (ADRs)
archive/                 frozen v1–v4 predecessors — historical reference only
```

The real `runPhase` Activity drives all nine phases end to end, exercised by
`workers/temporal-worker/src/run-phase-e2e.test.ts` — it boots a real local
Temporal server and runs a task through to a merged PR against GitHub fakes
(never a real API call). The scriptable mock agent adapter
(`packages/agent-gateway`) backs every deterministic test, so the suite runs in
seconds with no token cost; real-model runs are a separate, opt-in path.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```
