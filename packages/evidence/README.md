# @awb/evidence

## Purpose

Content-addressed local filesystem for large artifacts (videos, traces,
screenshots, logs, reports) — never SQLite blobs.

## Responsibilities

- `ArtifactStore.put/get/exists/verify/delete/garbageCollect/listByTask/
  listByCandidateSha` — hash-on-write (SHA-256), atomic rename into
  `sha256/<first-two>/<full-hash>`, automatic dedup on identical content.
- Retention-aware garbage collection (`temporary`/`task`/`permanent`).

## Does NOT

- Decide *what* counts as evidence for phase completion — that's
  `packages/workflow`'s `evaluatePhaseCompletion`. This package only stores
  bytes and metadata.
- Provide a SQLite-backed metadata store itself in production — the daemon
  wires a real one; `InMemoryArtifactMetadataStore` here exists for tests
  and as the interface's reference implementation.

## Dependencies

`@awb/domain`, `zod`.
