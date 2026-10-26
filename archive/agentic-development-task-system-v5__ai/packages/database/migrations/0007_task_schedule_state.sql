-- Task DAG orchestration: a daemon-scheduler-owned lifecycle axis, distinct from delivery_state
-- (which is workflow-owned and frozen at creation on this row). `ready` = eligible / root node;
-- `blocked` = row created but its workflow not yet started, waiting on the parent to release its
-- draft PR; `started` = workflow started. Existing rows are directly-created tasks → `ready`.
ALTER TABLE tasks ADD COLUMN schedule_state TEXT NOT NULL DEFAULT 'ready';
