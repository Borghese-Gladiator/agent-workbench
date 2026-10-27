# @awb/domain

## Purpose

Zod schemas and inferred TypeScript types for every entity in the system
(Repository, Task, TaskContract, ImplementationPlan, WorkspaceLease,
Evidence, Finding, ArtifactRecord, SemanticEvent, PhaseAttemptResult, and
more).

## Responsibilities

- Define the shape of every domain entity, once.
- Provide runtime validation (`.parse`) at process/persistence boundaries.

## Does NOT

- Perform any I/O — no filesystem, database, network, or process access.
- Depend on any other `@awb/*` package (see `docs/dependencies.md`) — this
  package sits at the bottom of the dependency graph so everything else can
  safely depend on it.

## Dependencies

`zod` only.
