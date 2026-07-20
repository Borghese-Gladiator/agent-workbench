# @awb/repository

## Purpose

Learns an arbitrary Python/TypeScript repository's structure without
assuming its shape: Git inspection, command discovery with provenance, unit
detection, fact extraction, and snapshot persistence.

## Responsibilities

- `git.ts` — remotes, default branch, status, log, changed-paths, all via
  the real `git` CLI (never a git library) so behavior matches what the
  developer sees in their own terminal.
- `command-discovery.ts` — discovers install/format/lint/typecheck/test/
  build/start commands from CI workflows, Makefile/Taskfile/justfile/tox/
  nox, package.json scripts, and Python config, in a fixed priority order
  (`DISCOVERY_SOURCE_PRIORITY`), marking ambiguous duplicates rather than
  silently picking one.
- `units.ts` — detects buildable/runnable subtrees (single-package or
  monorepo) with language/kind/framework/packageManager heuristics.
- `facts.ts` — extracts declared/inferred `RepositoryFact`s from repo docs
  (CLAUDE.md/AGENTS.md/README/ADRs) and detected units.
- `snapshot.ts` / `persist.ts` — assembles a full `RepositorySnapshot` and
  persists it (plus the `Repository` row itself) via `@awb/database`.

## Does NOT

- Store or invalidate `RepositoryFact`s long-term — this package produces
  facts as part of a snapshot; `@awb/repository-memory` owns storage,
  retrieval, and invalidation across snapshots.
- Extract symbols or build an import graph — that's `@awb/repository-map`
  (tree-sitter-based), a distinct concern from Git/command/unit discovery.
- Validate that discovered commands actually succeed — commands start life
  as `declared`/`inferred`; validation (running them) is a later milestone
  (`@awb/verification`).

## Dependencies

`@awb/domain`, `@awb/database`, `drizzle-orm`, `yaml`.
