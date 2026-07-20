# Agentic Development Task System

## Purpose

Fully local, browser-based dashboard for managing Claude Code development workflows.
Supports plan ingestion/approval, Kanban task tracking, terminal sessions, adversarial review, and activity logging — all backed by SQLite.

## Repo Map

- `src/server/` — Express API server, SQLite DB, file ingest pipeline
  - `db/` — Schema, connection (WAL mode), migrations, repositories (one per table)
  - `ingest/` — Chokidar file watcher, Zod validation, event processor
  - `routes/` — Express route modules
  - `domain/` — Business logic
  - `terminal/` — Terminal/PTY management
- `src/client/` — React 18 SPA
  - `api/` — HTTP client + TanStack Query hooks
  - `pages/` — Route-level page components
  - `components/` — Shared UI components
- `src/shared/` — Types, Zod schemas, constants (shared between client/server)
- `tests/` — Mirrors src structure
- `docs/plans/` — Versioned planning documents
- `docs/adr/` — Architecture Decision Records
- `docs/architecture.md` — System architecture overview
- `data/ingest/` — Runtime inbox/processed/rejected directories for ingest
- `.claude/skills/` — Reusable AI workflow skills

## Rules

- SQLite only — no Postgres, no external DB
- All ingest events validated with Zod schemas before processing
- DB access only through `src/server/db/repositories/` — no inline SQL in routes
- Repositories use prepared statements, one file per table
- Migrations must be idempotent (see `db/migrate.ts`)
- API calls from client go through `src/client/api/client.ts` — no raw fetch in components
- Server: port 3001 / Client: port 5173 (proxied to server)

## Commands

```bash
npm run dev            # Start server + client concurrently
npm run dev:server     # Express + ingest watcher on :3001
npm run dev:client     # Vite dev server on :5173
npm run build          # Production build
npx tsc --noEmit       # Type check
```

## Tech Stack

Node.js + TypeScript (ESM), Express, SQLite (better-sqlite3), React 18, Vite, Tailwind CSS v4, TanStack Query, Zustand, Zod, Chokidar
