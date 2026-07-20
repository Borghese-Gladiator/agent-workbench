# Manual Deletion of Tasks

> sqlite3 /Users/timothy.shee/GitHub/agent-workbench/data/workbench.sqlite

Verify current status
```sql
SELECT 'projects', COUNT(*) FROM projects
UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
UNION ALL SELECT 'stage_runs', COUNT(*) FROM stage_runs
UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs
UNION ALL SELECT 'agent_run_events', COUNT(*) FROM agent_run_events;
```

Delete tasks AND agent runs
```sql
BEGIN;

-- agent_run_events depends on agent_runs
DELETE FROM agent_run_events
  WHERE run_id IN (SELECT id FROM agent_runs WHERE task_id IN (SELECT id FROM tasks));

DELETE FROM agent_questions WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM agent_runs      WHERE task_id IN (SELECT id FROM tasks);

DELETE FROM delivery_packages WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM validation_runs   WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM artifacts         WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM stage_runs        WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM approvals         WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM worktrees         WHERE task_id IN (SELECT id FROM tasks);
DELETE FROM jobs              WHERE task_id IN (SELECT id FROM tasks);

DELETE FROM tasks;

COMMIT;
```

Re-verify current status
```sql
SELECT 'projects', COUNT(*) FROM projects
UNION ALL SELECT 'tasks', COUNT(*) FROM tasks
UNION ALL SELECT 'stage_runs', COUNT(*) FROM stage_runs
UNION ALL SELECT 'agent_runs', COUNT(*) FROM agent_runs
UNION ALL SELECT 'agent_run_events', COUNT(*) FROM agent_run_events;
```
