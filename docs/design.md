# Design — Agentic Workbench

## What this is

A local-first system that autonomously implements software tasks in existing
Python/TypeScript Git repositories. It runs a fixed lifecycle — specify, plan,
prepare, implement, verify, exercise, challenge, release, assimilate — where
every phase transition is decided by deterministic, workbench-owned policy
code, never by an agent's self-report. Agents produce **candidates and
evidence**; the workbench decides completion.

This is the fifth iteration of this problem in this repo. See
`../archive/README.md` for the full history of v1–v4 and why each was
replaced. The three concrete failures this design targets, carried over from
v4's archival notes:

1. **QA evidence was optional/RNG.** A video or trace might or might not get
   produced depending on model behavior. This design makes QA evidence
   mandatory and structurally verified (§23 of the product spec): a video
   alone never passes QA — structured assertions gate the phase.
2. **Lifecycle gates were not structurally enforced.** Tasks could creep
   toward "done" without satisfying every phase's completion criteria. This
   design makes `evaluatePhaseCompletion` the only path to advance a phase,
   and it is pure deterministic code, not an agent decision.
3. **Retries re-ran everything at full token cost.** This design uses typed
   `PhaseAttemptResult` routing (repair vs. replan vs. await-human) so a
   failed verification loops back to `implement` with just the relevant
   findings, not a full context reset, and Temporal's durable execution means
   a crash mid-task resumes rather than restarting.

## Architecture

Local modular monolith. See the product spec §3 for the full component
diagram. In short:

- **CLI + Web UI** are thin clients over the daemon's HTTP/WebSocket API.
- **Daemon** (Fastify) owns the workbench SQLite database, the content
  addressed artifact store, and is the only process with GitHub credentials.
  It is a Temporal client, not a Temporal worker.
- **Temporal server** (local dev server, SQLite-backed) owns durable
  workflow history, timers, signals, and updates.
- **Temporal worker** hosts `TaskWorkflow` and `RepositoryDiscoveryWorkflow`,
  and all Activities. Activities are the only place filesystem, git, process,
  agent, and network access happens.

## Why Temporal

Prior iterations (v2's markdown+shell control plane, v3's TUI, v4's hand-rolled
Express lifecycle service) all reinvented pieces of durable execution: resuming
after a crash, retrying a transient failure without re-running deterministic
work, waiting indefinitely for a human approval without busy-polling. Temporal
gives us these for free and makes the lifecycle state machine an explicit,
inspectable Workflow rather than an implicit convention enforced by discipline.

## Why deterministic completion policies, not agent judgment

An agent session can be wrong about whether it succeeded — it can hallucinate
a passing test, or simply not run one. `evaluatePhaseCompletion` (product spec
§10–11) is pure TypeScript that inspects a `CompletionCandidate` (evidence IDs,
open finding IDs, exact candidate SHA, environment digest) and returns a
decision. Agents never call an API that says "mark this phase done" — they can
only produce evidence, and the workbench decides whether that evidence is
sufficient.

## Package boundaries

See `docs/domain-model.md` for entity definitions and `docs/temporal-workflows.md`
for the workflow/activity boundary. The short version: `packages/domain` has
no I/O and is imported everywhere; `packages/workflow` contains Workflow code
(deterministic, no direct I/O — calls Activities); every other package is
either an Activity implementation or a pure library the daemon/CLI/web
consume directly.

## What is explicitly out of scope for the MVP

See product spec §2. Notably: no multi-user platform, no Kubernetes, no
automatic PR merge, no vector database, no `container-isolated` execution
profile beyond an interface stub. `native-trusted` is the only fully
implemented execution profile — this is not a hardened hostile-code sandbox,
and that is documented explicitly in `docs/security.md`.
