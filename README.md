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

Under active build, milestone by milestone (see `plan.md`). Each package
under `packages/` ships with its own `README.md` and tests as it lands.

## Requirements

Node ≥ 20, pnpm, Git, ripgrep, FFmpeg, `gh` CLI, Temporal CLI
(`brew install temporal`).

## Layout

```
apps/            cli, daemon (Fastify API), web (React/Vite dashboard)
workers/          temporal-worker (Activities + Workflow registration)
packages/         domain, database, workflow, repository*, workspace,
                  execution, agent-gateway, capability-broker, evidence,
                  verification, qa, review, github, observability, policy,
                  config — see docs/dependencies.md for the graph
tests/fixtures/   throwaway repo fixtures for automated tests only
scripts/          durable developer tooling
docs/             design docs + docs/decisions/ (ADRs)
archive/          frozen v1-v4 predecessors — historical reference only
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```
