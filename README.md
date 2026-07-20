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

Four processes, each in its own terminal:

```bash
pnpm install

# 1. Local Temporal dev server (must be up before the worker connects)
temporal server start-dev

# 2. Temporal worker — runs the real 9-phase runPhase Activity
pnpm --filter @awb/temporal-worker dev

# 3. The daemon — Fastify API on :4417
pnpm --filter @awb/daemon dev

# 4. The web dashboard on :5317 (optional — you can drive everything via the CLI instead)
pnpm --filter @awb/web dev
```

Each `dev` script runs the app's TypeScript directly via `tsx watch` (auto-
restarts on save) — no separate build step needed. The worker's `dev` script
builds `packages/workflow` first automatically, since Temporal's bundler
needs a real compiled `task-workflow.js` to package, not live TS.

Once the daemon is up, drive it with the CLI (built once via `pnpm build`):

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js repo add /path/to/some/real/git/repo
node apps/cli/dist/index.js repo refresh <repositoryId>
node apps/cli/dist/index.js repo approve <repositoryId>
node apps/cli/dist/index.js task create <repositoryId> --prompt "..."
node apps/cli/dist/index.js task show <repositoryId> <taskId>
node apps/cli/dist/index.js task approve-contract <repositoryId> <taskId> --version 1
```

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
                          review, github, policy — see docs/dependencies.md
                          for the full dependency graph
tests/fixtures/          throwaway repo fixtures for automated tests only
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
