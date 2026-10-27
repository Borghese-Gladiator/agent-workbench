# @awb/database

## Purpose

The workbench-owned SQLite database: schema, hand-written migrations, and
FTS5 search helpers, via Drizzle ORM + better-sqlite3.

## Responsibilities

- Define every table in `src/schema/*.ts` (repositories, tasks, contracts,
  plans, evidence, findings, sessions, delivery, memory — see
  `docs/storage.md` for the full list).
- Apply hand-written SQL migrations (`migrations/*.sql`) in order via a
  tracked `_migrations` table.
- Maintain 5 FTS5 virtual tables (repository facts/symbols, task contracts,
  findings, memory entries) with insert/update/delete sync triggers, exposed
  through typed search helpers in `src/fts.ts`.
- Open connections in WAL mode with `foreign_keys` enforcement on.

## Does NOT

- Store large binary content (videos, traces, logs) — those live in the
  content-addressed artifact store (`@awb/evidence`); this package only
  holds `ArtifactRecord` metadata.
- Enforce that it's the only writer — that's a daemon-level convention (see
  `docs/storage.md`), not something this package can check at runtime.

## Dependencies

`@awb/domain`, `@awb/config`, `drizzle-orm`, `better-sqlite3`.
