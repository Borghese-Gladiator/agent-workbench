---
description: Pretty-print one Agent Workbench run's metadata and artifact paths. Use when the user wants details on a specific run_id.
---

# /run-show

Thin wrapper around `agent-workbench show`.

```bash
agent-workbench show <run_id>
```

Shows status, target repo + worktree, every artifact's path and whether it exists, validation flags, and completion fields.
