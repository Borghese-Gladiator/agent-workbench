# Better worktree name template

Today `worktree_name` defaults to the slug of the brief title. For long titles
it loses information; there's no date hint; collisions are possible when two
runs share a slug.

Adopt `<YYYYMMDD>__<slug>` (matches the existing `LOCAL_worktrees` convention
this repo uses — e.g. `202605_agent_workbench_v2`).

Update `agent-workbench.yaml.defaults.worktree_name_template` and the resolver
in `lib/run_ids.py`. Confirm `branch_name` (`agent/<worktree_name>`) still
parses as a valid git ref.

## Files likely to change

- agent-workbench-live/lib/run_ids.py
- agent-workbench-live/agent-workbench.yaml
- agent-workbench-live/tests/
