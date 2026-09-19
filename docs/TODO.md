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

### [x] TASK-130: Delete `packages/repository-map` — dead, zero callers, and its own file walk would repeat the fender O(n²) failure if ever wired in

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

## Group AF — Agentic QA: a tool-using model instead of four hardcoded executors

### [ ] TASK-131: Give `exercise` a real agent session (the already-defined `qa-executor` role) instead of the deterministic executor ladder

**What's wrong.** The `exercise` phase picks one of four deterministic executors via
`selectQaMode` (`workers/temporal-worker/src/activities/qa-mode.ts:48-76`): `browser` (real
Chromium), `cli-run` (the project's own resolved command), `http-api` (one hardcoded
`GET /` status check), `library` (a hardcoded or env-supplied script), or the final
`cli-default` fallback that runs `echo qa-ok` and always passes — its own code comment
admits it "covers no behavioral claim on its own." No function in `packages/qa`,
`browser-qa-support.ts`, `qa-mode.ts`, or `qa-media-support.ts` calls an agent session; the
scenario steps it runs are mechanically derived from the plan's `expectedAssertions`
(`buildInteractiveScenarioSteps`, `packages/qa/src/coverage.ts:35-61`) — written by an LLM
earlier, in `plan`, then just walked as data by the time `exercise` runs. Meanwhile
`packages/capability-broker/src/capability-table.ts:34-45` already defines a full
`qa-executor` capability allowlist (`browser.navigate`, `browser.click`, `browser.type`,
`browser.inspect-accessibility`, `browser.record`, `terminal.interact`, `http.request`,
`application.start`/`stop`, `evidence.write`) and it is wired into `AgentSessionRole`
(`packages/agent-gateway`, `packages/domain/src/observability.ts:45`) — but no code anywhere
starts a session with `role: 'qa-executor'`. It is a fully specified, never-implemented
feature.

**What to do.** Replace the executor-selection ladder with one agent session, scoped to the
existing `qa-executor` role, given tool definitions that call into `packages/qa`'s existing
browser/http/terminal primitives (these become callable tools instead of top-level dispatch
branches). The session validates the task's behavioral claims using whatever combination of
tools fits the repo it's given, and must end by emitting the same structured
`QaAssertionResult` + evidence shape (recording, trace, per-claim assertion results) the
completion gate already requires — the agent decides which tool to reach for; it does not
get to decide whether QA passed.
- Do **not** change `evaluateExercise` (`packages/workflow/src/evaluate-completion.ts:125-155`)
  — it stays the hard, code-side backstop that reads the emitted evidence shape, never the
  session's own claim.
- Retire `detectRepoShape`'s guessing ladder and the always-pass `cli-default` fallback once
  the agent session is in place — a model concluding "there's no server, so I can't validate
  this" is a real, evidenced block; a hardcoded `echo qa-ok` is not.
- Follow the same session-construction pattern already used for the `builder` and
  `adversarial-reviewer` roles in `packages/agent-gateway` — this is a new role instance, not
  a new adapter shape.

**Known tradeoff, accept before building.** Evidence becomes less reproducible run-to-run —
an agent picks its own steps instead of executing a fixed script. That is the deliberate
trade for coverage flexibility; the completion gate is what keeps it honest, not scenario
determinism.

**Where.** New QA agent-session wiring in `workers/temporal-worker/src/activities/`
(e.g. `exercise-support.ts`, matching the existing per-phase support-file pattern) or inline
in the exercise block of `run-phase.ts`; tool definitions bridging to `packages/qa/src/*`;
`packages/capability-broker` (confirm/extend the existing `qa-executor` allowlist);
`packages/agent-gateway` (session start with `role: 'qa-executor'`). No change to
`packages/workflow/src/evaluate-completion.ts`.

**How we'll know it's done.** *Unit:* a QA run against a mock/test repo starts a session with
`role: 'qa-executor'` (assert via a spy/mock on session start) and produces a
`QaAssertionResult` set that `evaluateExercise` accepts unchanged. *Manual:* drive a real task
through `exercise` on a repo whose dev server the current `detectRepoShape` heuristic gets
wrong, and confirm the agent session finds a working validation path — or reports an honest,
evidenced block — instead of silently falling through to `cli-default`.
