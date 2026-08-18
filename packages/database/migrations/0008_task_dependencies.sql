-- TASK-102: scheduling-only fan-in DAG edges as rows. Distinct from the single 'stack' edge kept on
-- tasks.parent_task_id: a task may have ≤1 'stack' parent (git base) and N 'after' parents
-- (ordering only). Unique (task_id, depends_on_task_id) makes an edge idempotent.
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  mode TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
