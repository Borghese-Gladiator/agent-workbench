-- UI roadmap Phase 3: task titles + cross-task retry lineage.
--
-- title: an optional concise label for a task (the list/board show it instead of the full prompt).
--   Nullable — when absent the UI derives a fallback from the prompt's first sentence.
-- retry_of_task_id: the task this one is a retry of (retry creates a NEW task, so lineage is
--   cross-task, distinct from phase_attempts.retry_of which is intra-task). Null for an original.
-- root_task_id: the head of the retry chain — the original task. For an original this equals its
--   own id; a retry copies its parent's root_task_id so a whole family shares one root.
ALTER TABLE tasks ADD COLUMN title TEXT;
ALTER TABLE tasks ADD COLUMN retry_of_task_id TEXT;
ALTER TABLE tasks ADD COLUMN root_task_id TEXT;

-- Existing rows are all originals: root_task_id = id.
UPDATE tasks SET root_task_id = id WHERE root_task_id IS NULL;
