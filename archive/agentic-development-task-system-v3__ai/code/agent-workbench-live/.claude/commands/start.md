---
description: Create the branch + worktree for an Agent Workbench run in the ready state. Normally auto-chained from /plan; can also be invoked manually after the user reviewed the plan.
---

# /start

Thin wrapper around `agent-workbench start`. Transitions `ready -> building`.

## Preconditions

- Run is in state `ready`.
- `brief.md`, `plan.md`, `preflight.md`, `assumptions.md`, `decisions.md` all exist and are non-empty.

## Invocation paths

- **Auto-chained from `/plan`** (default). The agent invokes `/start` immediately after `planning -> ready`. Use `$USER` for `--approved-by`; do not prompt — the user already approved by letting the chain run.
- **Manual** (the user typed `/start <run_id>`). Same command; still pass `--approved-by "$USER"` unless the user explicitly specified a different approver.

## Run

```bash
agent-workbench start <run_id> --approved-by "$USER"
```

On success the command creates the worktree at `worktrees/<repo_name>/<worktree_name>/` and prints the path. Tell the user that path so they can `cd` into it for implementation.

## Next step

The agent (you, or another) implements inside the worktree. When done, run `/validate <run_id>`.

## Reference

See `docs/lifecycle.md` § `ready` -> `building`.
