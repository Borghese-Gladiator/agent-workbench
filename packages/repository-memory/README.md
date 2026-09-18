# @awb/repository-memory

## Purpose

Stores, retrieves, and invalidates `RepositoryFact`s across repository
accesses — the incremental project-memory behavior.

## Responsibilities

- `lifecycle.ts` — the promotion/eviction policy (ADR-010):
  `qualifiesForPromotion` gates every write, `evictSupersededFacts` retires a
  fact an incoming one explicitly replaces or that went unconfirmed past the
  staleness horizon. Eviction is supersession, never deletion.
- `recordFacts(db, repositoryId, facts)` — applies the lifecycle, then persists
  the promoted facts with full
  provenance (source paths + hashes).
- `queryMemory(db, sqlite, repositoryId, query)` — one composable retrieval
  function covering exact path, unit prefix, changed-path directory
  proximity, FTS5 full-text (delegated to `@awb/database`), confidence
  filter, and recency/confidence sort. A `symbolLookup` hook lets callers
  compose symbol-name queries against a symbol index without this package
  owning one itself.
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
