# Plan — Group I (Delivery & stacked PRs)

## Brief
Two ways a finished change fails to *land*:
- **TASK-71**: repo has no `origin` → delivery has nowhere to go; should branch + merge to local default branch.
- **TASK-72**: no first-class stacked-PR DAG → a task's base branch can't be the previous task's delivered branch.

## Changes

### TASK-71 — no-origin → local-merge delivery
- `packages/github/src/local-merge.ts` (new): `LocalMergeRunner` + `deliverToLocalMerge()` — from the repo root, ff/merge the feature branch into the local default branch, returning `{ merged, commitSha, defaultBranch }`. Never pushes, never opens a PR.
- `packages/github/src/local-merge.test.ts` (new): unit test on a real temp git repo with **no** `origin` → produces a merge commit on local `master`, no push attempted.
- `packages/github/src/index.ts`: export it.
- `run-phase.ts` release handler: when `realDelivery` and `getRemotes` shows **no** GitHub-parseable origin → route to local-merge instead of the terminal `blockedResult`. Build a delivery result with `pushed:false`, `pr.number:0`; release completes with an `await-human` gate reason `local-merge-landed` (or completes straight through). Detect via a new `resolveDeliveryTarget(worktreePath)` helper in `delivery-support.ts`.

### TASK-72 — per-task base override / stacked-PR edge
- `packages/domain/src/tasks.ts`: add optional `parentTaskId?`, `baseBranch?` to `TaskSchema`.
- `packages/database/migrations/0006_task_stacking.sql` (new): `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT; ADD COLUMN base_branch TEXT;`
- `packages/database/src/schema/tasks.ts`: add the two columns.
- `packages/database/src/data-access/tasks.ts`: `UpsertTaskInput` + `upsertTask` carry `parentTaskId`/`baseBranch`.
- `packages/workflow/src/workflow-types.ts`: `TaskWorkflowInput` + `TaskWorkflowState` carry `baseBranch?`.
- `packages/workflow/src/task-workflow.ts`: `initialState` seeds `baseBranch`; continue-as-new re-seed preserves it.
- `apps/daemon/src/routes/tasks.ts`: `/api/tasks` accepts `parentTaskId?`/`baseBranch?`. If `parentTaskId` given and no explicit `baseBranch`, resolve the parent task's delivered branch (from its workspace lease `branchName`) as the base. Thread `baseBranch` into workflow start args + `upsertTask`.
- `workers/temporal-worker/src/activities/worktree-support.ts`: `materializeWorktree` accepts optional `baseOverride` → `createWorktree({ baseRef: baseOverride ?? repository.defaultBranch })`.
- `run-phase.ts` prepare handler: pass `baseOverride: state.baseBranch` to `materializeWorktree`.
- Release handler: `baseBranch` for the PR already flows from `lease.baseRef`, so the override makes the PR base = parent branch. PR#0 (no override) stays `master`/`main`.
- `apps/cli/src/commands/task.ts`: `--parent-task <id>` / `--base-branch <ref>` flags on `task create`.

## Tests

### Unit
- `local-merge.test.ts`: no-origin repo → feature branch merged into local `master` with a new commit; asserts no push.
- `deliverToLocalMerge` ff case: fast-forwardable branch lands without a merge commit (or as a merge commit — assert the tip contains the feature work either way).
- domain: `TaskSchema` parses with/without `parentTaskId`/`baseBranch`.
- db: `upsertTask` round-trips `parentTaskId`/`baseBranch`; migration present in `_migrations`.
- workflow: `initialState` carries `baseBranch`; a two-node chain resolves child base = parent branch (route-level or a small helper test).
- worktree-support: `materializeWorktree` with `baseOverride` calls `createWorktree` with that `baseRef` (spy/stub).

### Manual
- Backend script: create a local-only git repo (no origin), 2 commits, drive `deliverToLocalMerge` → confirm `git log master` shows the feature commit.
- (Deferred to dogfood) drive a 3-task stacked chain; confirm each PR base = previous branch.
