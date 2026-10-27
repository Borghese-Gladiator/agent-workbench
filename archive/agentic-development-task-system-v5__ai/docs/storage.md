# Storage

Four storage systems, each with a distinct responsibility. No system is used
outside its role — in particular, large binary evidence never goes into
SQLite, and Temporal history never holds anything that could instead live in
workbench SQLite.

## Git repositories

Source of truth for code, branches, commits, history, and any
repository-authored documentation (READMEs, ADRs, CI config). The workbench
never treats its own memory as more authoritative than what's actually on
disk in the repository — memory is invalidated against current repository
contents, never the reverse.

## Temporal-owned SQLite

`~/.agentic-workbench/temporal/temporal.sqlite`. Owned entirely by the local
Temporal dev server. Holds workflow history, retries, timers, signals, and
updates. The daemon and worker never touch this file directly — only through
the Temporal client/SDK.

## Workbench-owned SQLite

`~/.agentic-workbench/database/workbench.sqlite`, WAL mode, accessed only by
the daemon (the daemon is the single application writer; the worker's
Activities call back into the daemon's data layer rather than opening a
second writer handle on the same file, to avoid SQLite writer contention
beyond what WAL already tolerates). Holds repositories, project memory,
tasks, evidence metadata, findings, events, agent sessions, token usage, PR
state, and artifact metadata — everything in the schema listed in
`packages/database/src/schema/`. FTS5 virtual tables provide search over
repository facts, repository symbols, task contracts, findings, and memory
entries.

## Local content-addressed filesystem

`~/.agentic-workbench/artifacts/sha256/<first-two>/<full-hash>`. Holds
videos, traces, screenshots, logs, test reports, raw event streams, plans,
review reports — anything large or binary. Content-addressing gives
automatic deduplication (see `packages/evidence/src/artifact-store.ts`):
identical content, even generated at different times for different tasks,
is stored once. Metadata (kind, retention, associated task/run/candidate)
lives in the `artifacts` SQLite table; the blob itself never does.

Retention categories (`temporary`, `task`, `permanent`) determine what
garbage collection may remove. GC only ever deletes a blob when no
`ArtifactRecord` references its hash.

## Disposable cache directory

`~/.agentic-workbench/cache/`. Repository maps, parsed AST data, symbol
indexes, dependency graphs, test-to-source maps, video thumbnails, token
estimates, temporary context packs. Cache keys always include the inputs
that would invalidate them (repository SHA, file hash, tool/parser version,
configuration hash) — see `packages/repository-map` for the concrete key
construction. Deleting the entire cache directory must never lose task
state, evidence, project memory, or workflow state; this is verified by a
unit test that clears the cache dir and re-derives everything from Git +
workbench SQLite.

## Why not Postgres/Redis/a message broker/a vector database

This is explicitly a single-developer-machine tool (see `AGENTS.md` › "Things
NOT to do" and ADR 002). SQLite (two independent files, one per subsystem) plus a
content-addressed filesystem covers every storage need in this spec without
introducing operational surface area (a server process to start/stop/monitor,
a schema migration story across services, network calls where a function
call would do). Retrieval uses SQLite FTS5 plus structural signals (exact
path, symbol name, changed-path proximity, Git history) rather than
embeddings (embeddings are an explicit non-goal for the MVP — ADR 002).
