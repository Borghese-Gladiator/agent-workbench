import { describe, expect, it } from 'vitest';
import type { ExpectedAssertion } from '@awb/domain';
import {
  evaluateBehavioralClaimCoverage,
  behavioralClaimsWithUntouchedTarget,
  buildInteractiveScenarioSteps,
} from './coverage.js';
import { scenarioStrength, type QaAssertionResult } from './shared.js';

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

describe('behavioralClaimsWithUntouchedTarget (TASK-63)', () => {
  it('reports a claim whose diff touched none of its target paths (no-op candidate)', () => {
    // Pi's live failure: README claim, but the builder committed only package-lock.json.
    const untouched = behavioralClaimsWithUntouchedTarget({
      behavioralClaimIds: ['claim-1'],
      claimTargetPaths: new Map([['claim-1', ['README.md']]]),
      changedPaths: ['package-lock.json'],
    });
    expect(untouched).toEqual(['claim-1']);
  });

  it('does not report a claim whose target file was touched', () => {
    const untouched = behavioralClaimsWithUntouchedTarget({
      behavioralClaimIds: ['claim-1'],
      claimTargetPaths: new Map([['claim-1', ['README.md']]]),
      changedPaths: ['README.md', 'package-lock.json'],
    });
    expect(untouched).toEqual([]);
  });

  it('matches by path prefix in either direction (dir target vs file change, file target vs dir change)', () => {
    expect(
      behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds: ['claim-1'],
        claimTargetPaths: new Map([['claim-1', ['src/games']]]),
        changedPaths: ['src/games/rank.ts'],
      }),
    ).toEqual([]);
    expect(
      behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds: ['claim-1'],
        claimTargetPaths: new Map([['claim-1', ['src/games/rank.ts']]]),
        changedPaths: ['src/games'],
      }),
    ).toEqual([]);
  });

  it('never reports a claim with no declared target paths (thin plan / fixture)', () => {
    expect(
      behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds: ['claim-1'],
        claimTargetPaths: new Map([['claim-1', []]]),
        changedPaths: ['unrelated.ts'],
      }),
    ).toEqual([]);
    expect(
      behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds: ['claim-1'],
        claimTargetPaths: new Map(),
        changedPaths: ['unrelated.ts'],
      }),
    ).toEqual([]);
  });

  it('normalizes ./ prefixes and trailing slashes before matching', () => {
    expect(
      behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds: ['claim-1'],
        claimTargetPaths: new Map([['claim-1', ['./src/games/']]]),
        changedPaths: ['src/games/rank.ts'],
      }),
    ).toEqual([]);
  });
});

describe('buildInteractiveScenarioSteps (TASK-90/91)', () => {
  it('translates a behavior claim into >=1 click + >=1 strong assertion derived from the expected assertion', () => {
    const expected: ExpectedAssertion[] = [
      { claimId: 'claim-1', observes: 'a higher rank beats a lower one', kind: 'state-transition' },
    ];
    const steps = buildInteractiveScenarioSteps(expected, {
      'claim-1': { observes: 'a higher rank beats a lower one', controlSelector: '#play', assertionSelector: '#result' },
    });

    const clicks = steps.filter((s) => s.kind === 'click');
    const strong = steps.filter((s) => s.kind === 'expectVisible' || s.kind === 'expectText' || s.kind === 'expectHidden');
    expect(clicks.length).toBeGreaterThanOrEqual(1);
    expect(strong.length).toBeGreaterThanOrEqual(1);
    expect(clicks[0]).toEqual({ kind: 'click', selector: '#play' });
    expect(strong[0]).toEqual({ kind: 'expectVisible', selector: '#result' });
  });

  it('emits an expectText value-match when the hint declares a target value', () => {
    const steps = buildInteractiveScenarioSteps(
      [{ claimId: 'c', observes: 'the score reads 42', kind: 'value-match' }],
      { c: { observes: 'the score reads 42', controlSelector: '#roll', assertionSelector: '#score', assertionText: '42' } },
    );
    expect(steps).toContainEqual({ kind: 'expectText', selector: '#score', equals: '42' });
  });

  it('adds a repeated-click expectNoDuplicateSocket step for a socket-opening control', () => {
    const steps = buildInteractiveScenarioSteps(
      [{ claimId: 'c', observes: 'joining opens the room', kind: 'state-transition' }],
      { c: { observes: 'joining opens the room', controlSelector: '#join', assertionSelector: '#room', socketOpening: true } },
    );
    expect(steps).toContainEqual({ kind: 'expectNoDuplicateSocket', selector: '#join' });
  });

  it('falls back to a text selector derived from observes when no hint is given', () => {
    const steps = buildInteractiveScenarioSteps([
      { claimId: 'c', observes: 'Submit', kind: 'state-transition' },
    ]);
    expect(steps).toContainEqual({ kind: 'click', selector: 'text=Submit' });
    expect(steps).toContainEqual({ kind: 'expectVisible', selector: 'text=Submit' });
  });
});

describe('scenarioStrength gating (TASK-90/91)', () => {
  it('scores an all-liveness scenario weak, so it cannot cover a behavior claim', () => {
    const livenessOnly: QaAssertionResult[] = [
      { name: 'navigate:/', passed: true, strength: 'liveness' },
      { name: 'expectVisible:main', passed: true, strength: 'liveness' },
      { name: 'screenshot:landing', passed: true, strength: 'liveness' },
    ];
    expect(scenarioStrength(livenessOnly)).toBe('weak');

    const coverage = evaluateBehavioralClaimCoverage({
      behavioralClaimIds: ['claim-1'],
      assertions: livenessOnly,
    });
    expect(coverage.everyBehavioralClaimCovered).toBe(false);
    expect(coverage.missing).toEqual(['claim-1']);
  });

  it('scores a scenario with a passing strong assertion strong, covering the claim', () => {
    const strong: QaAssertionResult[] = [
      { name: 'navigate:/', passed: true, strength: 'liveness' },
      { name: 'expectText:#result', passed: true, strength: 'value-match' },
    ];
    expect(scenarioStrength(strong)).toBe('strong');
    expect(
      evaluateBehavioralClaimCoverage({ behavioralClaimIds: ['claim-1'], assertions: strong })
        .everyBehavioralClaimCovered,
    ).toBe(true);
  });
});
