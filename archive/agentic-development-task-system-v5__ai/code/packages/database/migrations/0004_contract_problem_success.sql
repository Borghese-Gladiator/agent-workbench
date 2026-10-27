-- TASK-54: reviewer-alignment before implementation. Persist the problem statement the human
-- aligns on at the specify gate. Additive column with a safe default; existing rows keep ''.
ALTER TABLE task_contracts ADD COLUMN problem_statement TEXT NOT NULL DEFAULT '';
