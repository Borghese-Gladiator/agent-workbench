# @awb/verification

## Purpose

Runs repository-defined deterministic verification commands and produces
structured `Evidence`, plus the freshness/waiver checks
that back the Verify-phase completion criteria.

## Responsibilities

- `verification-runner.ts` — `runCommandAndRecordEvidence`/
  `runVerificationMatrix`: executes a `ValidatedCommand` via
  `@awb/execution`'s real `runCommand` (splitting the command string into
  executable + args, since `spawn` runs without a shell), captures
  stdout/stderr as real artifacts via `@awb/evidence`, and produces an
  `Evidence` record with the correct `kind` (unit-test/integration-test/
  build/static-check) and `status` (passed/failed/inconclusive — a timeout
  is inconclusive, not failed). `allRequiredCommandsPass()` implements the
  Verify completion criterion; an empty matrix never counts as passing.
- `evidence-freshness.ts` — `isEvidenceFresh`/`anyEvidenceStale`: strict
  equality checks (candidate SHA, environment digest, contract/plan
  version) — any single mismatch makes evidence stale, this is not a
  heuristic. `computeArtifactManifestHash()` for
  `CompletionCandidate.artifactManifestHash`.
- `waivers.ts` — `isWaiverValidForCandidate`/`allWaiversValid`: a waiver
  only counts if it is both human-approved AND scoped to the exact current
  candidate SHA — approval alone is not enough once the
  candidate has moved on.

## Does NOT

- Let the builder redefine what commands run — callers must pass
  `ValidatedCommand` rows with `status: "validated"`; this package doesn't
  enforce that itself; it's a caller contract.
- Decide phase completion — its outputs (`allRequiredCommandsPass`,
  `anyEvidenceStale`, `allWaiversValid`) feed
  `@awb/workflow`'s `evaluatePhaseCompletion`, they don't replace it.

## Dependencies

`@awb/domain`, `@awb/evidence`, `@awb/execution`.
