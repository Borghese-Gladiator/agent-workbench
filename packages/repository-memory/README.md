# @awb/repository-memory

## Purpose

Stores, retrieves, and invalidates `RepositoryFact`s across repository
accesses — the incremental project-memory behavior.

## Responsibilities

- `recordFacts(db, repositoryId, facts)` — persists facts with full
  provenance (source paths + hashes).
- `queryMemory(db, sqlite, repositoryId, query)` — one composable retrieval
  function covering exact path, unit prefix, changed-path directory
  proximity, FTS5 full-text (delegated to `@awb/database`), confidence
  filter, and recency/confidence sort. A `symbolLookup` hook lets callers
  compose symbol-name queries against `@awb/repository-map`'s symbol table
  without this package owning a symbol index itself.
- `invalidateFacts(db, repositoryId, changedPaths)` — soft-invalidates any
  fact whose `sourcePaths` or `invalidatedByPaths` overlap the changed set
  (via the pre-existing `supersededBy` column), leaving unaffected facts
  untouched.

## Does NOT

- Run Git or compute changed paths itself — callers (typically
  `@awb/repository`'s refresh flow) pass changed paths in.
- Own a symbol index — see the `symbolLookup` composition point above.
- Own command-validation state — that belongs to `@awb/repository`.

## Dependencies

`@awb/domain`, `@awb/database`.
