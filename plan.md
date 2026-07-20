# Plan — Agentic Workbench MVP

## Brief

Build the Agentic Workbench MVP as specified in the product brief: a local-first
TypeScript monorepo that autonomously plans, implements, verifies, QAs, and
adversarially reviews software tasks against real Python/TypeScript repos, using
Temporal for durable lifecycle orchestration, SQLite for structured state, and a
content-addressed filesystem for evidence artifacts (videos, traces, logs).

This is the 5th iteration of this exact problem in this repo (see
`archive/README.md`). v1-v4 are frozen precedent:
- v1: generic Kanban tracker, no worktree isolation, no forced planning/QA.
- v2: markdown+shell control plane, no execution engine, no automated QA.
- v3: TUI board, still hand-driven stage-by-stage, no server/API.
- v4: full TS monorepo (daemon+core+worktree+agents+validation+delivery+web+mcp),
  hand-rolled 14-stage lifecycle. Archived because: QA evidence was RNG (no
  guaranteed video/screenshot), lifecycle gates were not structurally enforced
  (tasks crept through), and retries reran with full cached-token cost.

This spec directly targets those three failure modes: Temporal-owned durable
lifecycle with deterministic `evaluatePhaseCompletion` (agents never decide
completion), mandatory QA evidence (video/trace/structured assertions, not
optional), and typed `PhaseAttemptResult` routing instead of ad hoc retries.

Scope is intentionally staged. Given the size (10 milestones, ~20 packages,
Temporal, Playwright, GitHub delivery), I will build milestone-by-milestone,
running lint/typecheck/tests at each step, and continuing through milestones
autonomously without pausing for confirmation (per user instruction — proceeding
without asking permission), stopping only for genuine blockers (destructive ops,
missing credentials, contradictions in the spec).

Local tooling confirmed available: Node v24.13.0, pnpm 10.33.0, ripgrep 15.1.0,
ffmpeg 8.1.1, gh 2.93.0, Temporal CLI 1.8.0 (installed this session via brew).

## Changes

### Milestone 1 — Foundation
- pnpm workspace monorepo skeleton: `apps/{cli,daemon,web}`, `workers/temporal-worker`,
  `packages/{domain,database,workflow,repository,repository-memory,repository-map,
  workspace,execution,agent-gateway,capability-broker,evidence,verification,qa,
  review,github,observability,policy,config}`, `tests/fixtures/repositories`, `scripts/`.
- Root `tsconfig.base.json` (strict), shared eslint/prettier config, Vitest config.
- `packages/domain`: Zod schemas + types for every entity in spec §7.
- `packages/config`: `AWB_DATA_DIR` resolution, `~/.agentic-workbench` layout creation, config.yaml load/save.
- `packages/database`: SQLite (better-sqlite3) + Drizzle schema/migrations for spec §8, WAL mode, FTS5 tables.
- `packages/evidence` (artifact store slice only for M1): content-addressed put/get/exists/verify/delete/gc.
- `apps/cli`: Commander skeleton with `awb init` wired to config+database bootstrap.
- Docs: `docs/design.md`, `docs/domain-model.md`, `docs/temporal-workflows.md`, `docs/storage.md`, `docs/security.md`, `docs/testing.md`.

### Milestone 2 — Repository intelligence
- `packages/repository`: Git inspection (remotes, branch, status, log) via simple-git or CLI shellouts.
- Python/TypeScript manifest + command discovery (package.json scripts, pyproject/tox/nox, Makefile, Taskfile, justfile, CI workflows) with provenance.
- `packages/repository-map`: tree-sitter based unit/symbol extraction, cached under `cache/repositories/`.
- `packages/repository-memory`: fact storage + FTS5 retrieval + incremental invalidation by changed-path.
- `RepositoryDiscoveryWorkflow` (stub in M1, real in M3) producing `RepositorySnapshot`.
- CLI: `awb repo add/list/inspect/refresh/approve`.

### Milestone 3 — Temporal lifecycle
- Local Temporal dev server bootstrap script (`temporal server start-dev` w/ SQLite persistence, data dir under `~/.agentic-workbench/temporal`).
- `packages/workflow`: TaskWorkflow (9-phase lifecycle per spec §9), RepositoryDiscoveryWorkflow, Updates/Signals/Queries per spec §13, `evaluatePhaseCompletion` deterministic policy per spec §11, loop routing per spec §12.
- `workers/temporal-worker`: worker process registering workflows + activities.
- Activities are thin wrappers delegating to packages (repository, workspace, agent-gateway, verification, qa, review, github).

### Milestone 4 — Workspace & execution
- `packages/workspace`: worktree manager (branch+worktree create/remove), port allocator, WorkspaceLease persistence.
- `packages/execution`: process supervisor (spawn, tree-kill on cleanup), scoped command runner, environment digest.

### Milestone 5 — Agent gateway
- `packages/agent-gateway`: `CodingAgentAdapter` interface, mock adapter (deterministic, scriptable), Claude Code adapter (real, using Claude Agent SDK / CLI in a role-scoped mode).
- `packages/capability-broker`: per-role tool allowlists per spec §18.
- Semantic event normalization + token/usage capture.

### Milestone 6 — Planning & implementation
- Task contract generation + human approval Update.
- Planner (read-only session) + plan critic (separate read-only session) with bounded retry loop.
- Builder slice loop with failure fingerprinting + no-progress detection.

### Milestone 7 — Verification & evidence
- `packages/verification`: runs validated repository commands, records structured evidence.
- `packages/evidence`: evidence dependency graph + invalidation rules (contract/plan/SHA/scenario cascades per spec §11).

### Milestone 8 — QA & review
- `packages/qa`: browser (Playwright), CLI (PTY), HTTP API, library-example QA executors; video/trace capture.
- `packages/review`: adversarial reviewer session + structured findings.

### Milestone 9 — GitHub delivery
- `packages/github`: push, draft PR create/update, evidence-matrix comment, PR feedback polling, merge/close tracking, Playwright-based video uploader.

### Milestone 10 — UI & hardening
- `apps/web`: React+Vite pages (Repositories, Repository detail, Tasks, Task detail, Approvals, Evidence viewer, Settings), WebSocket live updates.
- `apps/daemon`: Fastify server wiring Temporal client, repository intelligence, capability broker, evidence service, GitHub adapter, WS updates.
- Crash recovery, cancellation, final docs pass.

## Tests

### Unit
- Zod schema round-trips (`packages/domain`).
- `evaluatePhaseCompletion` policy table (all 9 phases, pass/fail branches).
- Evidence invalidation cascade rules.
- Failure fingerprinting equality/inequality.
- Artifact hashing + content-addressed dedup.
- Cache-key construction.
- Capability broker allow/deny per role.
- Human-gate trigger conditions.
- PR feedback classification.
- Repository fact invalidation on changed paths.

### Temporal (via `@temporalio/testing` TestWorkflowEnvironment)
- Successful end-to-end lifecycle (mock adapter) through all 9 phases to Assimilate.
- Contract rejection → Specify loop.
- Plan-critic rejection loop.
- Verification repair loop.
- QA repair loop.
- Review repair loop.
- Human approval wait (Update blocks until signaled).
- Budget exhaustion → human gate.
- Candidate SHA invalidation cascade.
- Release rebase invalidation → back to Verify.
- PR merged / PR closed without merge.
- Cancellation.

### Manual
- Backend: `scripts/manual/e2e_smoke.py`-equivalent — actually since this is a TS system, a manual Node script: `scripts/manual-e2e.mjs` that runs `awb init`, `awb repo add <fixture>`, `awb task create`, approves contract via CLI, and asserts a draft PR object appears in the mock-GitHub adapter output.
- Frontend (once `apps/web` exists in M10): open Repositories page, add a fixture repo, confirm units/commands render; open Task detail, approve contract via UI button, watch phase advance via WebSocket; open Evidence viewer, confirm a QA video plays.

## Execution note

Building milestone-by-milestone in this session, running format/lint/typecheck/test
after each, without pausing for approval per user instruction. Will surface here
(in commit messages / summaries) any point where I had to deviate from the spec
or where something is stubbed rather than fully real (e.g. container-isolated
execution profile is interface-only per spec §37).
