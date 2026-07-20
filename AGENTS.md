# AGENTS.md

## Project

Agentic Workbench — a local-first system that autonomously implements software
tasks in existing Python/TypeScript Git repositories, using durable Temporal
lifecycle orchestration, deterministic completion policies, and mandatory QA
evidence (video/trace, not just claims).

This is the 5th iteration of this exact problem in this repo — read
`archive/README.md` before assuming a design choice is arbitrary; most are a
direct response to why v1–v4 were replaced.

## Tech stack

- TypeScript, Node.js, pnpm workspaces
- Temporal TypeScript SDK (local dev server, SQLite-backed) — durable
  lifecycle orchestration
- Fastify (daemon API), React + Vite (web UI), Commander (CLI)
- SQLite + Drizzle ORM (workbench state), FTS5 (search)
- Git CLI, Octokit/`gh` (GitHub delivery)
- Playwright (browser QA + PR video upload), FFmpeg (video processing)
- web-tree-sitter (repository symbol/unit extraction — native `tree-sitter`
  does not build against Node 24's C++20 V8 headers on this machine; see
  `packages/repository-map/README.md`)
- Vitest (all tests)

## Architecture

```
CLI / Web UI
     │  (HTTP + WebSocket, /api only — browser never touches fs/git/shell)
     ▼
Daemon (Fastify) ── Temporal client, SQLite writer, artifact store, GitHub delivery
     │
     ▼
Temporal server (local, SQLite-backed)
     │
     ▼
Temporal worker ── TaskWorkflow, RepositoryDiscoveryWorkflow, Activities
                    (Activities are the only place fs/git/process/agent/network I/O happens)
```

Full detail: `docs/design.md` (component responsibilities and why Temporal),
`docs/domain-model.md` (entity model), `docs/temporal-workflows.md`
(lifecycle, Activities boundary, Updates/Signals/Queries),
`docs/dependencies.md` (package dependency graph), `docs/storage.md` (four
storage systems and why), `docs/security.md` (trust boundaries — read this
before assuming any isolation guarantee).

## Main business concepts

- **Repository** / **RepositorySnapshot** — a registered Git checkout and a
  point-in-time capture of what the workbench has learned about it.
- **Task** / **TaskContract** / **AcceptanceClaim** — one unit of requested
  work, its human-approved explicit meaning, and its falsifiable claims.
- **ImplementationPlan** / **PlanSlice** — the planner's bounded decomposition,
  critiqued by a separate plan-critic session before acceptance.
- **CompletionCandidate** / **PhaseAttemptResult** — what an agent produces;
  never a completion decision. `evaluatePhaseCompletion` (pure, deterministic,
  in `packages/workflow`) is the only thing that decides a phase advanced.
- **Evidence** / **Finding** — proof tied to an exact candidate SHA + policy
  version, and structured problems that route the lifecycle backward.
- **WorkspaceLease** — one Git worktree + branch + ports per task.

Full field-level detail: `docs/domain-model.md`.

## Where things live

| Concern | Path |
| --- | --- |
| Zod schemas / domain types (no I/O) | `packages/domain` |
| SQLite schema, migrations, FTS5 | `packages/database` |
| `~/.agentic-workbench` layout, config.yaml | `packages/config` |
| Content-addressed artifact store | `packages/evidence` |
| Git inspection, command discovery, snapshots | `packages/repository` |
| tree-sitter unit/symbol/import extraction | `packages/repository-map` |
| Project memory (facts, FTS5 retrieval, invalidation) | `packages/repository-memory` |
| Temporal Workflows + deterministic completion policy | `packages/workflow` |
| Git worktree/port/process management | `packages/workspace`, `packages/execution` |
| Agent adapter interface + mock/Claude adapters | `packages/agent-gateway` |
| Per-role tool allowlists | `packages/capability-broker` |
| Task contract, planner↔critic loop, builder slice loop | `packages/planning` |
| Verification command runner + evidence freshness/waivers | `packages/verification` |
| Browser/CLI/API/library QA executors | `packages/qa` |
| Adversarial reviewer | `packages/review` |
| GitHub push/PR/feedback/video-upload | `packages/github` |
| Runtime/token/event telemetry schema | `packages/observability` |
| Human-gate trigger policy | `packages/policy` |
| Temporal worker process (Activities live here) | `workers/temporal-worker` |
| Daemon (Fastify API, the only SQLite writer) | `apps/daemon` |
| Web dashboard | `apps/web` |
| CLI (`awb ...`) | `apps/cli` |

Every package under `packages/` has its own `README.md` covering purpose,
responsibilities, and explicit non-responsibilities — read that first before
reading the source.

## Things NOT to do

- Don't put I/O (filesystem, git, process, network, agent calls) in
  `packages/workflow` Workflow code — it must stay deterministic. I/O belongs
  in Activities (`workers/temporal-worker/src/activities/`).
- Don't let an agent session decide a lifecycle phase is complete. Agents
  return `PhaseAttemptResult`; only `evaluatePhaseCompletion` decides.
  advancement.
- Don't give any agent role a generic unrestricted shell — capabilities are
  broker-enforced per role (`packages/capability-broker`); see `docs/security.md`.
- Don't store videos, traces, or large logs in SQLite or Temporal history —
  the content-addressed artifact store (`packages/evidence`) owns those;
  SQLite only holds metadata.
- Don't treat project memory as more authoritative than current repository
  contents — memory is invalidated against the repo, never the reverse.
- Don't add a vector database, Kubernetes, Postgres, Redis, or a message
  broker — this is a single-developer-machine tool by design (spec §2).
- Don't skip required verification, QA, review, or video upload, and don't
  silently resolve command ambiguity — surface it (`status: "ambiguous"`).
- Don't assume `native-trusted` is a hostile-code sandbox — it isn't; see
  `docs/security.md`'s "known gaps" section before relying on any isolation
  boundary.

## Coding philosophy

- Prefer the simplest solution that satisfies the spec; no speculative
  abstraction for hypothetical future requirements.
- Strict TypeScript, no `any`, Zod at every process/persistence boundary.
- Small, composable modules with a focused public API per package — avoid
  circular package dependencies (see `docs/dependencies.md`).
- Default to no comments; write one only when the *why* is non-obvious (a
  hidden constraint, a workaround, a subtle invariant).
- Every package ships real tests alongside its source, not after the fact.
