import { describe, expect, it } from 'vitest';
import { evaluateBehavioralClaimCoverage } from './coverage.js';
import type { QaAssertionResult } from './shared.js';

const liveness: QaAssertionResult = { name: 'navigate:/', passed: true, strength: 'liveness' };

describe('evaluateBehavioralClaimCoverage (TASK-42)', () => {
  it('leaves a behavioral claim uncovered when only liveness assertions passed', () => {
    const result = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions: [liveness],
    });
    expect(result.everyBehavioralClaimCovered).toBe(false);
    expect(result.missing).toEqual(['claim-1']);
  });

  it('covers a behavioral claim when a passing strong assertion exists (no expected-assertion target)', () => {
    const result = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions: [liveness, { name: 'expectVisible:#x', passed: true, strength: 'state-transition' }],
    });
    expect(result.everyBehavioralClaimCovered).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('does not count a failing strong assertion as coverage', () => {
    const result = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions: [{ name: 'expectText:#x', passed: false, strength: 'value-match' }],
    });
    expect(result.everyBehavioralClaimCovered).toBe(false);
  });

  it('requires the strong assertion to reference the claim when an expected assertion was declared', () => {
    const assertions: QaAssertionResult[] = [
      { name: 'expectVisible:#other', passed: true, strength: 'state-transition', detail: 'unrelated' },
    ];
    // Expected assertion declared → a strong assertion for a *different* thing does not cover it.
    const uncovered = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions,
      claimHasExpectedAssertion: () => true,
      assertionCoversClaim: (_claimId, a) => a.detail?.includes('beats a lower') ?? false,
    });
    expect(uncovered.everyBehavioralClaimCovered).toBe(false);

    // A strong assertion that observes the declared transition covers it.
    const covered = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions: [
        { name: 'expectText:#trick', passed: true, strength: 'value-match', detail: 'a higher rank beats a lower one' },
      ],
      claimHasExpectedAssertion: () => true,
      assertionCoversClaim: (_claimId, a) => a.detail?.includes('beats a lower') ?? false,
    });
    expect(covered.everyBehavioralClaimCovered).toBe(true);
  });

  it('is vacuously true when there are no behavioral claims (mock/CLI path)', () => {
    expect(
      evaluateBehavioralClaimCoverage({ behavioralClaimIds: [], assertions: [liveness] }).everyBehavioralClaimCovered,
    ).toBe(true);
  });
});
