# Implementation plan — Better worktree name template

## Current repo understanding

`lib/run_ids.py` resolves names for runs, worktrees, and branches. The current
`make_worktree_path` is:

```python
def make_worktree_path(cfg, repo_name, worktree_name):
    return cfg.worktrees_path / repo_name / worktree_name
```

The run_id (already date-prefixed: `YYYY-MM-DD-<slug>`) is the source of
truth for "what date did this run start". The metadata.yaml stores it.

`cfg.defaults.worktree_name_template` exists in `agent-workbench.yaml`
(currently `"{slug}"`) but is **not actually substituted** by any code path
today — it's a declarative leftover.

## Proposed changes

1. Add `extract_run_date(run_id) -> str` to `lib/run_ids.py` returning the
   `YYYYMMDD` prefix derived from `run_id`'s first three hyphen-separated
   segments (`YYYY-MM-DD-foo` → `20260521`).
2. Change `make_worktree_path` signature to accept the `run_id` and
   prepend the date to the last segment: `cfg.worktrees_path / repo_name /
   f"{date}__{worktree_name}"`.
3. Update `cmd_start.py` (the only caller) to pass `run_id`.
4. Update `agent-workbench.yaml.defaults.worktree_name_template` to
   `"{date}__{slug}"` for documentation accuracy.

## Files likely to change

- `agent-workbench-live/lib/run_ids.py` — new helper + updated function
- `agent-workbench-live/lib/cli/cmd_start.py` — pass run_id
- `agent-workbench-live/agent-workbench.yaml` — doc update
- `agent-workbench-live/tests/test_integration.py` — assert worktree path
  contains today's date

## Test plan

- Unit: assert `make_worktree_path(cfg, "myrepo", "feat", run_id=
  "2026-05-21-feat")` returns `…/worktrees/myrepo/20260521__feat`.
- Unit: assert `extract_run_date("2026-05-21-feat")` returns `"20260521"`.
- Unit: `extract_run_date` raises on a malformed run_id.
- Integration: drive a fresh `new-run` + `start`, read the worktree path
  from metadata, assert the basename starts with today's `YYYYMMDD`.

## QA plan

Manual: list `worktrees/` after a few runs and confirm a glance reveals
both the date and the slug.

## Risks

- Two runs created on the same day with the same slug would still
  collide (same `<YYYYMMDD>__<slug>`). Existing collision-rejection in
  `make_run_id` already handles the run_id side; this needs no new check
  because run_id collision implies worktree collision.

## Definition of done

- All 6 acceptance criteria from brief.md pass.
- Existing test suite still green.
- Worktree path format visible in `agent-workbench show` output.

## Preflight

- python3 imports clean
- `agent-workbench doctor` passes
- 93/93 tests pass against current branch

## Decisions & assumptions

### DR-001
- **Decision**: pass the run's creation date down via the run_id rather
  than calling `datetime.now()` inside `make_worktree_path`.
- **Rationale**: idempotency. Calling `now()` would mean the worktree
  path depends on when `start` runs, not when `new-run` ran. The run_id
  is the canonical "when did this run start" source.
- **Alternatives considered**: read `metadata.created_at` directly; pass
  the date as a separate parameter.
- **Why not the alternatives**: metadata.created_at needs an ISO parser
  and an extra round-trip; passing a separate param burdens every caller
  with knowing the date. The run_id already carries it.

### DR-002
- **Decision**: do NOT update `branch_name` to include the date.
- **Rationale**: branches are visible in git logs and PRs; long names get
  truncated everywhere. The directory name benefits from a date hint; the
  branch name doesn't.

### ASM-001
- **Text**: All callers of `make_worktree_path` go through `cmd_start.py`.
- **Reason**: I grepped — only one call site outside tests.
- **Impact**: low. If a future caller forgets to pass run_id, the function
  will raise a TypeError immediately.
