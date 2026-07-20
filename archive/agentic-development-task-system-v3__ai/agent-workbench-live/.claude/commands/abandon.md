---
description: Abandon an Agent Workbench run. Wildcard transition from any non-terminal state to abandoned. Artifacts are preserved.
---

# /abandon

Thin wrapper around `agent-workbench abandon`. Wildcard transition `any_non_terminal -> abandoned`.

## What you need from the user

- The `run_id`.
- `--reason <text>`.
- `--abandoned-by <name>`.

## Run

```bash
agent-workbench abandon <run_id> --reason "..." --abandoned-by "$USER"
```

The run is stopped intentionally. All artifacts and events are preserved. The worktree is not deleted by this command — use an explicit cleanup step if you want to remove it.

## Reference

See `docs/lifecycle.md` § `abandoned`.
