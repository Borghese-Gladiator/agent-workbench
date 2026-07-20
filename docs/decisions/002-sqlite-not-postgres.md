# 002 — SQLite (two files), not Postgres

## Decision

Use two independent SQLite databases — one owned entirely by the local
Temporal dev server, one owned by the daemon (`packages/database`, Drizzle
ORM, WAL mode) — instead of a shared Postgres instance.

## Why

This is explicitly a single-developer-machine tool (product spec §1, §21,
§22). Postgres would mean a server process to install, configure, start,
stop, and monitor, a schema-migration story that has to stay in sync across
two logical databases if Temporal and the workbench shared one instance
(they don't need to), and a networked connection where a function call
suffices. SQLite's WAL mode gives adequate concurrent-read/single-writer
behavior for one developer driving one workbench daemon, and FTS5 gives full
text search over facts/symbols/contracts/findings/memory without a separate
search service.

## Alternatives considered

- **Shared Postgres for both Temporal and the workbench.** Rejected: adds an
  operational dependency this tool is explicitly designed not to require,
  for no benefit at single-developer scale.
- **A single SQLite file for both Temporal and the workbench.** Rejected:
  Temporal's SQLite plugin owns its own schema and lifecycle; sharing a file
  would couple two independently-versioned schemas and complicate backup/
  reset semantics (e.g. "wipe workbench state, keep Temporal history" or vice
  versa becomes impossible).
- **A vector database for repository memory retrieval.** Explicitly rejected
  by the product spec — FTS5 plus structural signals (exact path, symbol
  name, changed-path proximity, confidence, recency, Git history) is the
  retrieval strategy; embeddings are an explicit non-goal for the MVP.

## Consequences

- The daemon is the single application writer to the workbench SQLite file
  (see `docs/storage.md`) — Activities call back into the daemon's data layer
  rather than opening a second writer handle on the same file.
- Large binary evidence (video, traces, logs) never goes into either SQLite
  file — the content-addressed artifact store (`packages/evidence`) owns
  that, with only metadata in SQLite. This was true from the first schema
  design and is enforced by convention + code review, not a technical
  constraint SQLite itself imposes.
