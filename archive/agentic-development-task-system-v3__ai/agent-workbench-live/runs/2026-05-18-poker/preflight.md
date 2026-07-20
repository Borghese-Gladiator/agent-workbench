# Preflight

<!--
Confirms the run is ready to advance to `ready`. Verified during `planning`.
-->

## Target

- repo_path: /Users/timothy.shee/GitHub/new-tech-monorepo
- repo_name: new-tech-monorepo
- base_ref: HEAD
- branch_name: agent/poker
- worktree_name: poker

## Checks

- [x] Repo path exists and is a git repo (or will be created by this run)
- [x] Base ref resolves (HEAD on `new-tech-monorepo`)
- [x] Branch name does not already exist (`agent/poker` is unused)
- [x] Worktree path does not already exist (will be created under
  `agent-workbench-live/worktrees/new-tech-monorepo/poker/`)

## Warnings

- The target repo has a `.beads/` git pre-commit hook that runs on every
  commit. It will fire when we commit in the worktree. This is expected
  behavior of this monorepo (see the original handoff note) and not a
  blocker, but commits will be slower than usual.
- The monorepo has **no CI**, so there is no external gate on correctness
  beyond the tests this run will write. The `pytest` suite + the 12 manual
  QA scenarios in `brief.md` are the only quality gate.
- The monorepo has **no shared library or workspace manifest**: the new
  `python-poker-first/` project will be entirely self-contained with its own
  `pyproject.toml` and `poetry.lock`. Nothing else in the repo is modified.
- Python ≥ 3.12 is assumed available (matches the precedent set by
  `python-textual-first/`).
