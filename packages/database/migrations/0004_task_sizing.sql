-- TASK-51 / TASK-52: task size classification + program-design artifact.

-- Size class on the task row (nullable until the specify classifier sets it).
ALTER TABLE tasks ADD COLUMN size TEXT;

-- Size class on the contract (mirrors `risk`; defaults to M for pre-existing rows).
ALTER TABLE task_contracts ADD COLUMN size TEXT NOT NULL DEFAULT 'M';

-- Program-design artifacts (TASK-52), one row per (task, version).
CREATE TABLE program_designs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  plan_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_tree_diff_json TEXT NOT NULL,
  type_signatures_json TEXT NOT NULL,
  function_signatures_json TEXT NOT NULL
);
