// TASK-75 proof (handler seam): the exercise gate's onBlocked mapping routes a real defect to
// `repair → implement` and a pure evidence deficiency to a terminal `unmet` `qa-inconclusive`
// — never `repair` for a deficiency re-coding cannot fix. Paired with the workflow-level proof in
// packages/workflow that shows the *consequence*: a qa-inconclusive result parks on first hit
// (no streak), while `repair` would need three strikes to reach `repeated-failure-no-progress`.
import { describe, expect, it } from 'vitest';
import type { CompletionContext } from '@awb/workflow';
import { mapExerciseBlock } from './run-phase.js';

const base: NonNullable<CompletionContext['exercise']> = {
  everyRequiredScenarioHasResult: true,
  everyBehavioralClaimCovered: true,
  structuredAssertionsPass: true,
  requiredRecordingExists: true,
  browserScenariosHaveTraces: true,
  evidenceTiedToCandidateSha: true,
  policyBlockingErrorsPresent: false,
};

describe('mapExerciseBlock (TASK-75)', () => {
  it.each([
    ['a policy-blocking runtime error', { policyBlockingErrorsPresent: true }],
    ['a structured assertion that ran and failed', { structuredAssertionsPass: false }],
    ['a no-op / off-target candidate diff', { behavioralClaimsWithUntouchedTarget: ['claim-1'] }],
  ])('routes %s to repair → implement (a real defect the builder can fix)', (_label, override) => {
    const result = mapExerciseBlock({ ...base, ...override }, ['x'], 'task-1');
    expect(result.outcome).toBe('repair');
    if (result.outcome !== 'repair') throw new Error('unreachable');
    expect(result.target).toBe('implement');
  });

  it.each([
    ['missing recording', { requiredRecordingExists: false }],
    ['missing browser trace', { browserScenariosHaveTraces: false }],
    ['a required scenario has no result', { everyRequiredScenarioHasResult: false }],
    ['a behavioral claim uncovered with no failing assertion', { everyBehavioralClaimCovered: false }],
    ['a claim with no authored strong assertion', { behavioralClaimsMissingStrongAssertion: ['claim-1'] }],
    ['evidence not tied to candidate SHA', { evidenceTiedToCandidateSha: false }],
  ])('routes %s to a terminal qa-inconclusive unmet outcome (re-coding cannot supply it)', (_label, override) => {
    const missing = ['some behavioral acceptance claim is not covered'];
    const result = mapExerciseBlock({ ...base, ...override }, missing, 'task-1');
    expect(result.outcome).toBe('unmet');
    if (result.outcome !== 'unmet') throw new Error('unreachable');
    expect(result.reason).toBe('qa-inconclusive');
    // The outcome names the actionable deficiency, not an opaque retry, and carries it as the
    // unproven claim the draft PR reports (TASK-106).
    expect(result.detail).toContain('some behavioral acceptance claim is not covered');
    expect(result.unprovenClaims).toEqual(missing);
  });

  it('never returns `repair` for a pure evidence deficiency (the old trap)', () => {
    const result = mapExerciseBlock({ ...base, requiredRecordingExists: false }, ['no recording'], 'task-1');
    expect(result.outcome).not.toBe('repair');
  });
});
