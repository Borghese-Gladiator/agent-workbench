# Backlog
Prioritized List of Things to Fix
> Every task must have what is wrong / what to do, where, and how we'll know when it's done

## Group AE — Static dead-code detection

### [ ] TASK-129: Add knip for automated dead-code detection, plus a run command

**What's wrong.** Every dead-code finding on this repo so far (`packages/repository-map`
with zero callers outside itself; `packages/workflow/src/stuck-phase-classification.test.ts`
testing functions that moved to `task-workflow.ts` in a past rename) was found by manual
grep-based tracing, not by tooling. There is no `knip`/`ts-prune`-class check installed and
no `pnpm` script to run one, so a similar dead package or stale file can sit unnoticed
indefinitely.

**What to do.**
- Add `knip` as a devDependency at the workspace root.
- Add a `knip.json` scoped to `apps/`, `packages/`, `workers/` — excluding `archive/` (kept
  intentionally as historical reference per AGENTS.md) and `scripts/` (documented manual
  diagnostics, not a package with exports to track).
- Add a `pnpm run audit:deadcode` script, matching the existing `audit:docs` /
  `report:tokens` script convention.
- Do not wire it into a blocking pre-commit hook yet. Run it once repo-wide first, triage
  the findings (this class of tool has real false positives on CLI entrypoints and on Zod
  schemas used only for type inference), and confirm signal quality before deciding whether
  it should gate anything.

**Where.** Root `package.json` (new devDependency + script), new `knip.json`. No source
changes.

**How we'll know it's done.** *Unit:* `pnpm run audit:deadcode` runs and exits 0 on current
`main` after triaging/allowlisting known false positives. *Manual:* delete a known-unused
export on a throwaway branch and confirm the command flags it.

### [ ] TASK-130: Delete `packages/repository-map` — dead, zero callers, and its own file walk would repeat the fender O(n²) failure if ever wired in

**What's wrong.** `packages/repository-map` (tree-sitter symbol/import extraction, ~1000
lines with tests) has no caller outside its own package — confirmed by grepping every
`apps/`, `packages/`, and `workers/` package.json and import site for `@awb/repository-map`.
`repository_snapshots.repository_map_artifact_id` is written on every snapshot
(`packages/repository/src/persist.ts:168`) but never set to anything but `undefined`. It was
added in commit `cb59e90` for a genuinely different job than the fender incident (symbol
lookup, not workspace-unit discovery — that incident was fixed entirely inside
`packages/repository/src/units.ts` by commit `89a4202` and is unrelated to this package). But
`repository-map`'s own file walker (`packages/repository-map/src/index.ts:20-73`) reads and
tree-sitter-parses every source file in a unit serially, with no batching and no working
cache — the exact class of mechanism that caused the fender O(n²) incident. It has never
triggered only because nothing calls it; it would reproduce that failure shape on a large
repo the day it gets wired in.

**What to do.** Delete `packages/repository-map/` entirely (source, tests, README,
`package.json` entry). Remove the dead `repositoryMapArtifactId` field write in
`packages/repository/src/persist.ts:168` and the corresponding field in
`packages/domain/src/repository.ts:177`. Leave the `repository_snapshots.repository_map_artifact_id`
SQLite column in place for now — dropping a column is a separate, lower-priority migration,
not a blocker for this deletion. If symbol extraction is wanted again later, it belongs
inside `packages/repository` reusing that package's existing file walk, scoped to
changed/relevant files only — not as a second standalone package with its own unbounded
walk.

**Where.** Delete `packages/repository-map/`. Edit `packages/repository/src/persist.ts:168`,
`packages/domain/src/repository.ts:177`, and any explicit workspace/tsconfig references to
the package.

**How we'll know it's done.** *Unit:* `pnpm build` and the full `packages/repository` test
suite pass, and `grep -r "repository-map"` finds nothing outside git history. *Manual:* run
a discovery pass (`awb repo add` or equivalent) on a real repo and confirm snapshot creation
still completes, with `repositoryMapArtifactId` no longer present on the type.
