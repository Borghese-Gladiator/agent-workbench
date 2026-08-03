# Agentic Workbench

A local-first system that autonomously implements software tasks in existing
Python and TypeScript Git repositories: plan → implement → verify → exercise
(QA) → adversarially review → repair or advance, with durable Temporal
lifecycle orchestration and deterministic, workbench-owned completion
policies — agents produce candidates and evidence, they never decide a phase
is done.

This is the fifth iteration of this problem in this repo; see
`archive/README.md` for the full history of what v1–v4 tried and why each was
replaced, and `docs/decisions/` for the specific design choices this version
makes in response.

## Start here

- **Agents**: read `AGENTS.md` first.
- **Humans**: `docs/design.md` (why this is built the way it is),
  `docs/domain-model.md` (entity model), `docs/temporal-workflows.md`
  (lifecycle mechanics), `docs/storage.md`, `docs/security.md`,
  `docs/observability.md` (how a run is observed — the three channels +
  a debugging runbook; see `docs/decisions/008-observability-split.md`),
  `docs/testing.md`, `docs/dependencies.md` (package graph).

## Status

All 10 planned milestones are built and tested: repository discovery,
Temporal lifecycle orchestration with deterministic completion policies,
worktree/process management, a real Claude Code agent adapter (plus a
scriptable mock for all deterministic tests), the planner→critic→builder
loop, real deterministic verification, real browser/CLI/HTTP-API/library QA,
adversarial review, GitHub delivery (push/draft-PR/evidence-matrix/feedback
classification), and a Fastify daemon + CLI + web dashboard. The real
`runPhase` Activity drives all 9 lifecycle phases end to end — proven by
`workers/temporal-worker/src/run-phase-e2e.test.ts`, which boots a real local
Temporal server and runs a task through to a merged PR (against fakes for
GitHub, never a real API call).

Known gaps, tracked explicitly rather than hidden: `RepositoryDiscoveryWorkflow`
isn't yet a real Temporal workflow (repository discovery runs as a plain
function call); the real GitHub video-upload implementation (Playwright
against an authenticated browser session) is interface-only; `runPhase`'s
cross-phase state is in-memory only and does not survive a worker restart.
See `docs/decisions/006-runphase-state-is-not-durable.md` and the project's
task list for the full detail on each.

## Running it

The fast path — one command boots the whole stack (Temporal dev server,
worker, and daemon) and waits for the daemon to report healthy:

```bash
pnpm install
pnpm --filter @awb/cli cli -- up      # boots Temporal + worker + daemon, waits for /api/health
```

`awb down` tears it back down. Logs stream to `~/.agentic-workbench/runtime/logs/`.
The web dashboard is optional (`pnpm --filter @awb/web dev`, on :5317) — you
can drive everything from the CLI.

If you'd rather run the processes yourself (e.g. to watch each one's output),
they are, in order — each `dev` runs TypeScript directly via `tsx watch`, no
build step; the worker's `dev` compiles `packages/workflow` first since
Temporal's bundler needs a real `task-workflow.js`, not live TS:

```bash
temporal server start-dev
pnpm --filter @awb/temporal-worker dev
pnpm --filter @awb/daemon dev
```

Once the stack is up, drive it with the CLI. Run it buildless via the `cli`
script (no `pnpm build` needed):

For a bare `awb` that works from any directory (runs the live TS source via
`tsx`, no `pnpm build` needed), symlink the wrapper into a dir on your `PATH`
once:

```bash
ln -sf "$PWD/apps/cli/bin/awb.sh" ~/.local/bin/awb   # ~/.local/bin must be on $PATH
```

Alternatively, a shell function works but only from inside this repo:

```bash
awb() { pnpm --filter @awb/cli cli -- "$@"; }
```

Either way:

```bash
awb repo add /path/to/some/real/git/repo --json   # prints the repo, remembers its id
awb repo refresh                                   # id falls back to the last one used
awb repo approve
awb task create --prompt "..." --json              # prints the task, remembers its id
awb task show                                       # ids fall back to the last ones used
awb task approve-contract --contract-version 1
awb task list                                       # tasks created this session
```

Repo and task ids are remembered between commands, so you only pass them when
you want to target something other than the most recent. To drive a full task
from Claude Code, see `.claude/skills/run-workbench-task`.

`apps/cli/package.json` declares a `bin: awb` entry for when this is
installed as a real package; `pnpm link` the CLI package yourself if you
want a bare `awb` command on your PATH instead of the `node apps/cli/dist/...`
form above. `awb daemon start`/`awb daemon stop` manage a detached daemon
process directly (spawns `apps/daemon/dist/index.js`, so run `pnpm build`
first if you use this path instead of `pnpm --filter @awb/daemon dev`).

## Requirements

Node ≥ 20, pnpm, Git, ripgrep, FFmpeg, `gh` CLI, Temporal CLI
(`brew install temporal`).

## Layout

```
apps/                   cli, daemon (Fastify API), web (React/Vite dashboard)
workers/temporal-worker  Activities + Workflow registration
packages/                domain, config, database, evidence, repository,
                          repository-map, repository-memory, workflow,
                          workspace, execution, agent-gateway,
                          capability-broker, planning, verification, qa,
                          review, github, policy, telemetry — see
                          docs/dependencies.md for the full dependency graph
scripts/                 durable developer tooling
docs/                    design docs + docs/decisions/ (ADRs)
archive/                 frozen v1-v4 predecessors — historical reference only
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```
