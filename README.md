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

```bash
pnpm install
pnpm build                                    # builds every package's dist/ output
node apps/cli/dist/index.js init               # bootstraps ~/.agentic-workbench
node apps/cli/dist/index.js daemon start       # starts the Fastify daemon on :4417
temporal server start-dev                      # separately: the local Temporal dev server
node workers/temporal-worker/dist/index.js     # the Temporal worker
pnpm --filter @awb/web dev                     # the dashboard on :5317
```

(`apps/cli/package.json` declares a `bin: awb` entry for when this is
installed as a real package — inside this checkout, invoke it via
`node apps/cli/dist/index.js <command>` as above, or `pnpm link` the CLI
package yourself if you want a bare `awb` command on your PATH.)

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
