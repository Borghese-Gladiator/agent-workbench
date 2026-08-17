// TASK-75 proof (handler seam): the exercise gate's onBlocked mapping routes a real defect to
// `repair → implement` and a pure evidence deficiency to an `await-human` `qa-inconclusive` gate
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
  ])('routes %s to an await-human qa-inconclusive gate (re-coding cannot supply it)', (_label, override) => {
    const missing = ['some behavioral acceptance claim is not covered'];
    const result = mapExerciseBlock({ ...base, ...override }, missing, 'task-1');
    expect(result.outcome).toBe('await-human');
    if (result.outcome !== 'await-human') throw new Error('unreachable');
    expect(result.gate.reason).toBe('qa-inconclusive');
    expect(result.gate.phase).toBe('exercise');
    expect(result.gate.taskId).toBe('task-1');
    // The gate surfaces the actionable deficiency, not an opaque retry.
    expect(result.gate.summary).toContain('some behavioral acceptance claim is not covered');
  });

  it('never returns `repair` for a pure evidence deficiency (the old trap)', () => {
    const result = mapExerciseBlock({ ...base, requiredRecordingExists: false }, ['no recording'], 'task-1');
    expect(result.outcome).not.toBe('repair');
  });
});
