# PR summary

> Generated from the run's other artifacts. Paste into the PR description as a
> starting point — adjust phrasing for the audience as needed.

## Title
<!-- One line. <70 chars. Imperative mood. e.g. "Reduce onboarding step count to 3" -->

## Why
<!-- Pull from normalized-feature-input.md → Problem + Desired outcome. -->

## What changed
<!-- Pull from spec.md → Implementation plan. Bullet the actual deltas. -->

## How it was tested
<!-- Pull from qa-log.md and the QA plan. Both automated and manual. -->

## Risk / rollout notes
<!-- Pull from spec.md → Rollout plan. Mention feature flags, monitoring, rollback. -->

## Linked artifacts
- Run dir: `runs/<run_id>/`
- Spec: `runs/<run_id>/spec.md`
- Decisions: `runs/<run_id>/decisions.md`
- QA log: `runs/<run_id>/qa-log.md`
- Event log: `runs/<run_id>/events.jsonl` (replay how this run reached its current state)

## Checklist
- [ ] Spec was approved before implementation started.
- [ ] All major decisions recorded in `decisions.md`.
- [ ] At least one QA pass logged in `qa-log.md`.
- [ ] No orchestration directories created in the product repo
      (`scripts/validate-product-repos-clean.sh` passes).
- [ ] `metadata.yaml` status reflects current state.
