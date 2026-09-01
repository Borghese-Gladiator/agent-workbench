-- UI roadmap Phase 0 (state coherence + freshness). Two additive changes:
--
-- 1. `task_summary` — the one durable, denormalized read model for a task, kept in sync by the
--    daemon on every workflow transition (including gate open/park, the state where the `tasks` row
--    otherwise stopped updating and the list went stale). The task list, board, approval queue, and
--    repository task list all read THIS table instead of fanning out one live Temporal query per
--    task. `derived_status` is computed by the domain deriveTaskStatus so every surface agrees.
--    `indexed_at` is the projection clock the detail page compares against live workflow state to
--    report "the index is behind".
CREATE TABLE task_summary (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  phase TEXT NOT NULL,
  condition TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  size TEXT,
  derived_status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  open_finding_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  pending_gate_reason TEXT,
  candidate_sha TEXT,
  pull_request_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE INDEX idx_task_summary_repository ON task_summary(repository_id);
CREATE INDEX idx_task_summary_status ON task_summary(derived_status);

-- 2. Retry lineage: an explicit back-pointer from a phase attempt to the prior attempt it retries.
--    Today only the positional `attempt_number` exists (encoded in the id) with no relational edge;
--    this makes the retry chain queryable. Nullable — null on a first attempt.
ALTER TABLE phase_attempts ADD COLUMN retry_of TEXT;
