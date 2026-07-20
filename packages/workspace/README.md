# @awb/workspace

## Purpose

Git worktree + port allocation manager — every implementation task gets one
dedicated worktree, never the developer's primary checkout (product spec
§17).

## Responsibilities

- `resolveBaseSha` / `resolveTaskBranchName` — resolve a target branch to an
  immutable SHA and derive a unique `awb/<task-id>-<slug>` branch name.
- `createWorktree` / `removeWorktree` — materialize and tear down a real
  linked Git worktree, producing/consuming a `WorkspaceLease`. Supports
  `preserve: true` so failed worktrees survive for inspection by default.
- `PortAllocator` — hands out collision-free TCP ports across concurrently
  active leases in-process.
- `createTaskTempDir` / `removeTaskTempDir` — a scratch directory per task,
  separate from the worktree itself.
- `prepareEnvironment` — install-command decision logic (pnpm/yarn/npm based
  on the unit's declared package manager), executed via an injectable
  `CommandExecutor` so most tests don't need a real package install.

## Does NOT

- Persist `WorkspaceLease` rows to SQLite — this package hands back a lease
  object; the daemon owns writing it to the `workspace_leases` table.
- Implement `repository-defined` or `container-isolated` execution profiles
  — only `native-trusted` is implemented (see `docs/decisions/004-native-trusted-only.md`).

## Dependencies

`@awb/domain`, `@awb/config`, `@awb/repository` (reuses its `runGit` helper
rather than re-shelling to git with different conventions).
