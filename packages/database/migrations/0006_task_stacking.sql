-- TASK-72: stacked-PR DAG. A task may stack on a parent task's delivered branch instead of the
-- repository default branch. Both nullable — a root task (PR#0) has neither.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
