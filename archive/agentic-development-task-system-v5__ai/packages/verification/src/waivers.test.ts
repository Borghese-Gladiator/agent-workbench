import { describe, expect, it } from 'vitest';
import { isWaiverValidForCandidate, allWaiversValid } from './waivers.js';

describe('isWaiverValidForCandidate', () => {
  it('is valid when human-approved and scoped to the current candidate SHA', () => {
    expect(
      isWaiverValidForCandidate({ humanApproved: true, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' }),
    ).toBe(true);
  });

  it('is invalid when not human-approved even if the SHA matches', () => {
    expect(
      isWaiverValidForCandidate({ humanApproved: false, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' }),
    ).toBe(false);
  });

  it('is invalid when the candidate SHA has moved on, even if human-approved', () => {
    expect(
      isWaiverValidForCandidate({ humanApproved: true, waiverCandidateSha: 'sha-old', currentCandidateSha: 'sha-new' }),
    ).toBe(false);
  });
});

describe('allWaiversValid', () => {
  it('is true when every waiver is valid', () => {
    const waivers = [
      { humanApproved: true, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' },
      { humanApproved: true, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' },
    ];
    expect(allWaiversValid(waivers)).toBe(true);
  });

  it('is false when any waiver is invalid', () => {
    const waivers = [
      { humanApproved: true, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' },
      { humanApproved: false, waiverCandidateSha: 'sha-a', currentCandidateSha: 'sha-a' },
    ];
    expect(allWaiversValid(waivers)).toBe(false);
  });

  it('is vacuously true for an empty waiver list', () => {
    expect(allWaiversValid([])).toBe(true);
  });
});
