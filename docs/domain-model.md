# Domain model

All types below are defined as Zod schemas in `packages/domain/src/*.ts` and
exported from `@awb/domain`. This document explains the relationships; the
source is authoritative for exact field shapes.

## Repository intelligence

- **Repository** — a registered local Git checkout. `trusted` gates whether
  the workbench will run commands in it at all.
- **RepositorySnapshot** — a point-in-time (`headSha`) capture of everything
  the workbench has learned about a repository: units, commands, services,
  QA surfaces, facts. One snapshot per discovery/refresh cycle.
- **RepositoryUnit** — a buildable/runnable subtree (an app, a library, a
  package) with a language and kind. Snapshots reference units by ID; commands
  and services may be scoped to a unit.
- **ValidatedCommand** — a single discovered command (e.g. `pnpm test`) with
  `source` (where it was found) and `status` (has it actually been run
  successfully). Only `validated` commands are used for real verification;
  `inferred` commands require human approval before they become trusted.
- **RepositoryFact** — a piece of project memory: an architectural
  observation, a convention, a risk. Always tied to `observedAtSha` and
  `sourcePaths`/`sourceHashes` so it can be invalidated when those paths
  change on a later access.

## Task lifecycle

- **Task** — one unit of requested work against one repository. Has a
  `phase` (where it is in the 9-stage lifecycle), `condition` (is it
  actively running, blocked, waiting on a human, etc.), and `deliveryState`
  (has a PR been opened yet).
- **TaskContract** — the explicit, human-approvable statement of what the
  task means: objective, constraints, non-goals, risk level, and a list of
  **AcceptanceClaim**s. Nothing downstream (plan, implementation, QA, review)
  exists without a claim justifying it.
- **AcceptanceClaim** — one falsifiable thing the delivered change must
  satisfy, tagged with which *kinds* of evidence it requires
  (deterministic check, QA, human judgment). A claim with
  `qaEvidenceRequired: true` cannot be satisfied by unit tests alone.
- **ImplementationPlan** / **PlanSlice** — the planner's proposed
  decomposition of the contract into boundable units of work. Every
  `AcceptanceClaim` must be covered by at least one `PlanSlice`
  (`ClaimCoverage` records the mapping) before the plan can be accepted.
- **WorkspaceLease** — the one worktree + branch + allocated ports for a
  task's execution. A task always has exactly one active lease.

## Evidence and findings

- **Evidence** — the record that a specific claim was checked, at a specific
  `candidateSha`, under a specific `environmentDigest`, using a specific
  `policyVersion`. Evidence is keyed to *exact* commits and environments
  deliberately — evidence about `candidateSha` A does not carry over to
  `candidateSha` B, which is what forces re-verification after any code
  change (see the invalidation cascade in product spec §11).
- **Finding** — something a builder, verifier, QA session, or reviewer
  flagged as wrong. Findings route the lifecycle backward (product spec
  §12) based on `category` — a `correctness` finding goes back to
  `implement`, an `architecture` finding goes back to `plan`, a
  `requirements` finding goes back to `specify`.
- **ArtifactRecord** — metadata for a piece of content stored in the
  content-addressed filesystem (video, trace, log, report). Never the
  content itself — SQLite never stores large blobs.

## Lifecycle coordination types

- **TaskPhase** — the 9-phase enum driving `TaskWorkflow`.
- **PhaseAttemptResult** — the only thing a phase executor can return:
  a `candidate` (attempt succeeded, produced a `CompletionCandidate` for
  policy evaluation), a `repair`/`replan` (send findings backward), an
  `await-human` (block on a `HumanGate`), `blocked`, or `cancelled`. See
  `docs/temporal-workflows.md` for how the Workflow consumes this.
- **CompletionCandidate** — the compact, hashable summary of "what was
  produced this attempt" that `evaluatePhaseCompletion` evaluates against
  policy. It never contains the evidence bodies, only IDs.

## Events

- **SemanticEvent** — the human-readable event stream the UI subscribes to
  over WebSockets. Distinct from Temporal's own history (durable but not
  meant for UI consumption) and from raw agent transcripts (stored as
  artifacts, referenced by `artifactId` when large).
