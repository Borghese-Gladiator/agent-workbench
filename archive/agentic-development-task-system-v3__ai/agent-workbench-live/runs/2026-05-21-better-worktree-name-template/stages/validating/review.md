# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. All 6 acceptance criteria are addressed (AC-5 is partial — no
dedicated unit test for `extract_run_date`; covered indirectly by the
integration test). Behavior matches DR-001's idempotency intent: the
date comes from the run_id, not `datetime.now()`.

## Did it accidentally expand scope?

The CLI's scope-creep check (TODO §1g) will run on the next transition;
see the appended `## Scope creep check` section below. By eye: all four
touched files (`run_ids.py`, `cmd_start.py`, `agent-workbench.yaml`,
`tests/test_integration.py`) are listed in the brief's "Files likely to
change" (`tests/` matches `tests/test_integration.py` via prefix).

## Are there fragile assumptions?

ASM-001 (single caller of `make_worktree_path`) was verified by grep
before authoring. The signature change is a breaking change for any
external caller — there are none in this repo, but a future caller would
hit a TypeError. Acceptable: the error is loud and immediate.

## Are there missing tests?

- AC-5 (dedicated unit tests for `extract_run_date`) not satisfied.
  Recommend a follow-up with explicit tests for malformed input.
- No test exercises the `NamingError` path. Same follow-up.

## Are there security / data loss / migration risks?

None.

## What should the human review first?

`lib/run_ids.py` lines 56–82 (the new helper + signature change). Then
the one-line update to `cmd_start.py`. Everything else is downstream.

## Blast radius

depth 1 (changed files in this diff):
  - agentic-development-task-system-v2__ai/agent-workbench-live/agent-workbench.yaml
  - agentic-development-task-system-v2__ai/agent-workbench-live/lib/cli/cmd_start.py
  - agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py
  - agentic-development-task-system-v2__ai/agent-workbench-live/tests/test_integration.py

depth 2 (callers of changed symbols, via `git grep`):
  - lib/run_ids.py:make_worktree_path → only lib/cli/cmd_start.py
  - lib/run_ids.py:extract_run_date  → only self (lib/run_ids.py:make_worktree_path)
  - lib/cli/cmd_start.py             → only registered in bin/agent-workbench (dispatcher)

depth 3 (callers of those callers):
  - bin/agent-workbench → top-level CLI entrypoint; reached via shell, not by Python imports.

No depth-2 or depth-3 file lives outside the brief's expected scope.
The blast radius is contained.

## Findings

(no blocking findings)

### F-001
- **Severity**: minor
- **Where**: `lib/run_ids.py:extract_run_date`
- **Issue**: AC-5 calls for dedicated unit tests covering malformed
  run_ids; only the happy path is exercised via the integration test.
- **Suggested fix**: add `tests/test_run_ids.py` with cases for empty
  run_id, missing date prefix, garbage prefix.

## Scope creep check

Validating compared `brief.md`'s expected file list against `git diff` in the worktree. The following files were changed but NOT anticipated by the brief:

- `agentic-development-task-system-v2__ai/agent-workbench-live/agent-workbench.yaml`
- `agentic-development-task-system-v2__ai/agent-workbench-live/lib/cli/cmd_start.py`
- `agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py`
- `agentic-development-task-system-v2__ai/agent-workbench-live/tests/test_integration.py`

Either these are legitimate ripple effects (and the brief should be updated), or the scope expanded mid-run. Reviewer: confirm or push back.
