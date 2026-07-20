---
description: Print the handoff info for an Agent Workbench run (branch, worktree path, audit). Use when the user wants to re-see what was handed off without re-running validation.
---

# /handoff

Read-only wrapper around `agent-workbench handoff`.

```bash
agent-workbench handoff <run_id>
```

Shows branch name, worktree path, audit path, and the contents of `handoff.md`.

## Reference

See `docs/lifecycle.md` § `human_review`.
