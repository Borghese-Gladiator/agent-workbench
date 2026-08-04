-- TASK-54: reviewer-alignment before implementation. Persist the problem statement and measurable
-- success criteria the human aligns on at the specify gate, so the QA rubric (TASK-42) can be held
-- to them. Additive columns with safe defaults; existing rows keep '' / '[]'.
ALTER TABLE task_contracts ADD COLUMN problem_statement TEXT NOT NULL DEFAULT '';
ALTER TABLE task_contracts ADD COLUMN success_criteria_json TEXT NOT NULL DEFAULT '[]';
