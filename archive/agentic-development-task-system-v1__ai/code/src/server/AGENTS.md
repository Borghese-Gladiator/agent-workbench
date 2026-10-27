# Server Guidelines

## DB Access
- All database access goes through `db/repositories/` — never inline SQL in routes or domain logic
- Each repository file handles one table with prepared statements
- WAL mode is enabled in `db/connection.ts` — do not change `journal_mode`

## Migrations
- All migrations must be idempotent (safe to re-run)
- Schema changes go in `db/schema.sql`, migration logic in `db/migrate.ts`

## Ingest Pipeline
- New event types: add Zod schema in `src/shared/schemas.ts`, add handler in `ingest/processor.ts`
- Events are validated (envelope + payload), deduped by SHA-256 hash, then dispatched
- Files move to `processed/` on success, `rejected/` on failure

## Routes
- Each route module lives in `routes/` and is mounted in `index.ts`
- Routes call domain logic or repositories — no business logic in route handlers

## Adding a New Table
1. Add DDL to `db/schema.sql`
2. Create `db/repositories/<table>.ts` with prepared-statement CRUD
3. Add types to `src/shared/types.ts`
4. Update migration in `db/migrate.ts` if needed
