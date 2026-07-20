# Infra: SQL migrations

Applies when: writing a SQL migration or any schema change.

Do:

- Backwards-compatible by default. Old code must run against the new schema.
- Expand-then-contract for any rename or type change:
  1. **Expand**: add the new column / table, dual-write from app code.
  2. **Backfill**: copy historic data into the new shape.
  3. **Contract**: stop writing the old column; later, drop it in a separate release.
- Add `NOT NULL` only after the column is backfilled. Otherwise inserts fail mid-deploy.
- Add indexes `CONCURRENTLY` (Postgres) to avoid table locks on large tables.
- Keep each migration small enough to review on one screen.

Do not:

- Do not drop a column in the same release that stops writing to it. Two releases minimum.
- Do not run a destructive migration (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`) without explicit approval and a rollback plan.
- Do not assume a small table will stay small. Concurrent variants are cheap insurance.
- Do not hand-edit migrations that are already deployed — write a new migration.

Commands:

```sql
-- Expand
ALTER TABLE users ADD COLUMN email_v2 TEXT;

-- Backfill (separate migration)
UPDATE users SET email_v2 = lower(email) WHERE email_v2 IS NULL;

-- Index without locking writes
CREATE INDEX CONCURRENTLY idx_users_email_v2 ON users (email_v2);

-- Add NOT NULL after backfill verified
ALTER TABLE users ALTER COLUMN email_v2 SET NOT NULL;
```
