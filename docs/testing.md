# Testing strategy

## Unit tests (Vitest, per package)

Every package under `packages/` ships its own `*.test.ts` files, run via
`pnpm --filter @awb/<pkg> test` or in aggregate via the root `vitest.config.ts`
(which globs `packages/**`, `apps/**`, `workers/**`). Priority coverage per
product spec §34:

- Zod schema round-trips (`packages/domain`) — accept valid, reject invalid,
  for every entity.
- `evaluatePhaseCompletion` policy table (`packages/workflow`) — every phase,
  both the "complete" and "not complete" branch, for every listed completion
  criterion.
- Evidence invalidation cascade (`packages/evidence`) — contract/plan/SHA/
  scenario version bumps each correctly invalidate the documented downstream
  evidence kinds and nothing else.
- Failure fingerprinting (`packages/agent-gateway` or wherever the builder
  loop lives) — same (command, exit code, failing test IDs, normalized error
  class, top stack frame) fingerprints compare equal; any one differing
  compares unequal.
- Artifact hashing + content-addressed dedup (`packages/evidence`) — see
  `artifact-store.test.ts`.
- Cache-key construction (`packages/repository-map`) — same inputs (repo SHA,
  file hash, tool/parser version, config hash) produce the same key; any
  differing input changes the key.
- Permission/capability-broker policies (`packages/capability-broker`) — each
  role's allow/deny table is exercised positively and negatively.
  Human-gate trigger conditions (`packages/policy`) — each conditional gate
  in product spec §14 fires under the described condition and does not fire
  otherwise.
- PR feedback classification (`packages/github`) — each of the six
  categories in product spec §29 classifies correctly on representative
  sample comments.
  Repository fact invalidation (`packages/repository-memory`) — a fact whose
  `sourcePaths` overlap a changed-path set is invalidated; a fact whose paths
  don't overlap survives a refresh.

## Temporal tests (`@temporalio/testing`)

`TestWorkflowEnvironment.createLocal()` (real-time, not time-skipping — see
`docs/temporal-workflows.md`'s Testing section for why) drives `TaskWorkflow`
against the fake agent adapter for every scenario in product spec §34:
successful lifecycle, contract rejection, plan-critic loop, verification
repair loop, QA repair loop, review repair loop, human approval wait, budget
exhaustion, candidate SHA invalidation, release rebase invalidation, PR
merged, PR closed without merge, cancellation, continue-as-new threshold.
As of Milestone 3, `packages/workflow/src/task-workflow.test.ts` covers the
lifecycle scenarios that don't require verification/QA/review packages
(which land in Milestones 6-8); the remaining scenarios extend this file as
those packages arrive rather than living in a separate
`*.workflow.test.ts` naming convention. These live under
`packages/workflow/src/*.test.ts` and `workers/temporal-worker` as
appropriate.

## Repository fixtures

`tests/fixtures/repositories/` holds throwaway Git repos (simple TS package,
simple Python package, mixed monorepo, browser app, CLI fixture, a repo with
a failing baseline, a repo with ambiguous commands) built fresh in a temp dir
per test run — not committed as static repo trees, since they need to be real
Git repos with real history for discovery/worktree tests to be meaningful.
These fixtures exist purely for automated testing and must never be treated
as the product's assumed repository shape.

## Fake agent adapter

`packages/agent-gateway`'s mock adapter is deterministic and scriptable: it
can simulate successful planning, critic rejection, source edits, test
failures, QA failures, review findings, token usage, timeouts, and repeated
failure signatures, all without any network call or real model invocation.
This is what all Temporal lifecycle tests run against — real-model tests are
a separate, opt-in manual/integration path (see `scripts/manual-e2e.mjs`),
since they cost tokens and are non-deterministic by nature.

## End-to-end MVP test

The full 20-step scenario in product spec §34 (create fixture → register →
discover → approve onboarding → create task → approve contract → plan+critic
→ worktree → fake implementation → fail verify → repair → pass verify → fail
QA → repair → pass QA → pass review → mocked draft PR → mark merged → refresh
memory → clean up worktree) is the acceptance test for the whole system. It
runs the mock GitHub delivery adapter (no real network calls) and is part of
the standard `pnpm test` run since it uses only the fake agent adapter and
local fixtures.

## What is manual, and why

Real-provider QA (an actual Claude Code session driving a real repository) is
not run on every CI pass — it costs real tokens/time and its output is
inherently less deterministic than the fake-adapter path. `scripts/manual-e2e.mjs`
exercises the CLI end-to-end against a fixture repo using whichever
`agentProvider` is configured, for a human to run before a release, not on
every commit.
