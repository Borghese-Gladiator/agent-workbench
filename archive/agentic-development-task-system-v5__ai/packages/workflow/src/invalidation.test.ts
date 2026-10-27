import { describe, expect, it } from 'vitest';
import { invalidatedPhases, releaseReconciliationRoutesToVerify, type VersionChange } from './invalidation.js';

const noChange: VersionChange = {
  contractChanged: false,
  planChanged: false,
  candidateShaChanged: false,
  qaScenarioChanged: false,
};

describe('invalidatedPhases', () => {
  it('invalidates nothing when nothing changed', () => {
    expect(invalidatedPhases(noChange).size).toBe(0);
  });

  it('a contract change invalidates plan and everything downstream', () => {
    const result = invalidatedPhases({ ...noChange, contractChanged: true });
    expect([...result].sort()).toEqual(
      ['challenge', 'exercise', 'implement', 'plan', 'release', 'verify'].sort(),
    );
  });

  it('a plan change invalidates implementation mapping, verification, QA, review, release but not plan itself', () => {
    const result = invalidatedPhases({ ...noChange, planChanged: true });
    expect(result.has('plan')).toBe(false);
    expect([...result].sort()).toEqual(['challenge', 'exercise', 'implement', 'release', 'verify'].sort());
  });

  it('a candidate SHA change invalidates verification, QA, review, release but not implement or plan', () => {
    const result = invalidatedPhases({ ...noChange, candidateShaChanged: true });
    expect(result.has('implement')).toBe(false);
    expect(result.has('plan')).toBe(false);
    expect([...result].sort()).toEqual(['challenge', 'exercise', 'release', 'verify'].sort());
  });

  it('a QA scenario change invalidates QA and review and release but not verify', () => {
    const result = invalidatedPhases({ ...noChange, qaScenarioChanged: true });
    expect(result.has('verify')).toBe(false);
    expect([...result].sort()).toEqual(['challenge', 'exercise', 'release'].sort());
  });

  it('combines invalidation sets when multiple things changed', () => {
    const result = invalidatedPhases({ ...noChange, candidateShaChanged: true, qaScenarioChanged: true });
    expect([...result].sort()).toEqual(['challenge', 'exercise', 'release', 'verify'].sort());
  });
});

describe('releaseReconciliationRoutesToVerify', () => {
  it('routes to verify when reconciliation changed the candidate SHA', () => {
    expect(releaseReconciliationRoutesToVerify(true)).toBe(true);
  });

  it('does not route to verify when reconciliation left the candidate SHA unchanged', () => {
    expect(releaseReconciliationRoutesToVerify(false)).toBe(false);
  });
});
